import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { adjustTokenResourceSchema, createTokenSchema, duplicateTokenSchema, duplicateTokensSchema, idSchema, updateTokenSchema } from '@nri/contracts';
import { db } from '../../db/index.js';
import { assets, auditEvents, scenes, tokens } from '../../db/schema.js';
import { canReadSceneTokens, type CampaignSceneRole } from '../../domain/sceneAccess.js';
import type { FastifyInstance } from 'fastify';
import type { Server } from 'socket.io';
import { digest, parseBody } from '../../security/access.js';
import { publicToken } from '../../domain/projections.js';
import { publishTokenState } from '../../realtime/tokenEvents.js';
import { publishInitiative } from '../../realtime/initiativeEvents.js';
import { publishMovement } from '../../realtime/movementEvents.js';
import { cookieName } from '../../config/runtime.js';
import { commandSessionIsActive, lockCampaign, lockCampaignActor, lockCampaignRoles, lockCampaignSceneActor, lockCommandSession, type Transaction } from '../../security/commandAccess.js';
import { updateTokenGroup } from './movement.js';
import { lockOperationReceipt, operationRequestId, saveOperationReceipt } from '../../security/operationReceipts.js';

const movementErrorStatus = { INVALID: 400, UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409 };

type LockedTokenContext =
  | { error: 'UNAUTHENTICATED' | 'NOT_FOUND' | 'FORBIDDEN' }
  | { token: typeof tokens.$inferSelect; scene: Pick<typeof scenes.$inferSelect, 'id' | 'campaignId' | 'isActive'>;
      role: CampaignSceneRole; roles: Map<string, CampaignSceneRole>; userId: string };

async function lockTokenCommand(tx: Transaction, tokenHash: string, tokenId: string, requestedOwner?: string | null): Promise<LockedTokenContext> {
  const session = await lockCommandSession(tx, tokenHash);
  if (!session) return { error: 'UNAUTHENTICATED' } as const;
  const [location] = await tx.select({ sceneId: scenes.id, campaignId: scenes.campaignId }).from(tokens)
    .innerJoin(scenes, eq(tokens.sceneId, scenes.id)).where(eq(tokens.id, tokenId)).limit(1);
  if (!location) return { error: 'NOT_FOUND' } as const;
  if (!await lockCampaign(tx, location.campaignId)) return { error: 'FORBIDDEN' } as const;
  const roles = await lockCampaignRoles(tx, location.campaignId, requestedOwner ? [session.userId, requestedOwner] : [session.userId]);
  const role = roles.get(session.userId);
  if (!role) return { error: 'FORBIDDEN' } as const;
  const [scene] = await tx.select({ id: scenes.id, campaignId: scenes.campaignId, isActive: scenes.isActive }).from(scenes)
    .where(and(eq(scenes.id, location.sceneId), eq(scenes.campaignId, location.campaignId), isNull(scenes.archivedAt))).for('share').limit(1);
  if (!scene) return { error: 'NOT_FOUND' } as const;
  const [token] = await tx.select().from(tokens).where(and(eq(tokens.id, tokenId), eq(tokens.sceneId, scene.id))).for('no key update').limit(1);
  if (!token) return { error: 'NOT_FOUND' } as const;
  if (!await commandSessionIsActive(tx, tokenHash)) return { error: 'UNAUTHENTICATED' } as const;
  return { token, scene, role, roles, userId: session.userId };
}

type LockedTokenDuplicateContext =
  | { error: 'UNAUTHENTICATED' | 'NOT_FOUND' | 'FORBIDDEN' }
  | { destination: typeof scenes.$inferSelect; sources: Map<string, typeof tokens.$inferSelect>; role: CampaignSceneRole; userId: string };

async function lockTokenDuplicateContext(tx: Transaction, tokenHash: string, destinationSceneId: string, tokenIds: string[]): Promise<LockedTokenDuplicateContext> {
  const session = await lockCommandSession(tx, tokenHash);
  if (!session) return { error: 'UNAUTHENTICATED' } as const;
  const [destinationLocation] = await tx.select({ campaignId: scenes.campaignId }).from(scenes).where(eq(scenes.id, destinationSceneId)).limit(1);
  if (!destinationLocation) return { error: 'NOT_FOUND' } as const;
  if (!await lockCampaign(tx, destinationLocation.campaignId)) return { error: 'FORBIDDEN' } as const;
  const role = (await lockCampaignRoles(tx, destinationLocation.campaignId, [session.userId])).get(session.userId);
  if (!role) return { error: 'FORBIDDEN' } as const;
  const sourceLocations = tokenIds.length ? await tx.select({ tokenId: tokens.id, sceneId: tokens.sceneId }).from(tokens).innerJoin(scenes, eq(tokens.sceneId, scenes.id))
    .where(and(inArray(tokens.id, tokenIds), eq(scenes.campaignId, destinationLocation.campaignId), isNull(tokens.deletedAt), isNull(scenes.archivedAt)))
    .orderBy(asc(tokens.id)) : [];
  if (sourceLocations.length !== tokenIds.length) return { error: 'NOT_FOUND' } as const;
  const sceneIds = [...new Set([destinationSceneId, ...sourceLocations.map(({ sceneId }) => sceneId)])].sort();
  const lockedScenes = await tx.select().from(scenes).where(and(eq(scenes.campaignId, destinationLocation.campaignId), inArray(scenes.id, sceneIds), isNull(scenes.archivedAt)))
    .orderBy(asc(scenes.id)).for('share');
  if (lockedScenes.length !== sceneIds.length) return { error: 'NOT_FOUND' } as const;
  const destination = lockedScenes.find(({ id }) => id === destinationSceneId);
  if (!destination) return { error: 'NOT_FOUND' } as const;
  const sourceRows = tokenIds.length ? await tx.select().from(tokens).where(and(inArray(tokens.id, tokenIds), inArray(tokens.sceneId, sceneIds), isNull(tokens.deletedAt)))
    .orderBy(asc(tokens.id)).for('share') : [];
  if (sourceRows.length !== tokenIds.length) return { error: 'NOT_FOUND' } as const;
  if (!await commandSessionIsActive(tx, tokenHash)) return { error: 'UNAUTHENTICATED' } as const;
  return { destination, sources: new Map(sourceRows.map((token) => [token.id, token])), role, userId: session.userId } as const;
}

export function registerTokenRoutes(app: FastifyInstance, io: Server) {
  app.get('/api/scenes/:sceneId/tokens', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const tokenHash = digest(cookie);
    const sceneId = parseBody(idSchema, (request.params as { sceneId: string }).sceneId);
    const result = await db.transaction(async (tx) => {
      const session = await lockCommandSession(tx, tokenHash);
      if (!session) return { error: 'UNAUTHENTICATED' } as const;
      const [location] = await tx.select({ campaignId: scenes.campaignId }).from(scenes).where(eq(scenes.id, sceneId)).limit(1);
      if (!location || !await lockCampaign(tx, location.campaignId)) return { error: 'NOT_FOUND' } as const;
      const role = (await lockCampaignRoles(tx, location.campaignId, [session.userId])).get(session.userId);
      const [scene] = await tx.select({ isActive: scenes.isActive }).from(scenes)
        .where(and(eq(scenes.id, sceneId), eq(scenes.campaignId, location.campaignId), isNull(scenes.archivedAt))).for('share').limit(1);
      if (!role || !scene || !canReadSceneTokens(role, scene.isActive, false)) return { error: 'NOT_FOUND' } as const;
      const rows = await tx.select().from(tokens).where(and(eq(tokens.sceneId, sceneId), isNull(tokens.deletedAt)));
      if (!await commandSessionIsActive(tx, tokenHash)) return { error: 'UNAUTHENTICATED' } as const;
      return { projection: rows.filter((token) => !token.hidden || role !== 'PLAYER').map((token) => publicToken(token, role !== 'PLAYER', session.userId)) };
    }, { isolationLevel: 'read committed' });
    if ('error' in result) return reply.code(movementErrorStatus[result.error]).send({ error: result.error });
    return result.projection;
  });
  app.post('/api/tokens', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const input = parseBody(createTokenSchema, request.body);
    const requestId = operationRequestId(request.headers['idempotency-key']);
    if (requestId === 'invalid') return reply.code(400).send({ error: 'INVALID_REQUEST_ID' });
    const result = await db.transaction(async (tx) => {
      const context = await lockCampaignSceneActor(tx, digest(cookie), input.sceneId, { sceneStrength: 'update' });
      if ('error' in context) return context;
      if (context.role !== 'OWNER' && context.role !== 'GM') return { error: 'FORBIDDEN' } as const;
      const receipt = requestId ? await lockOperationReceipt(tx, { actorId: context.userId, campaignId: context.scene.campaignId, operationType: 'token.create', requestId }, input) : null;
      if (receipt?.kind === 'conflict') return { error: 'CONFLICT' } as const;
      if (receipt?.kind === 'replay') {
        const [token] = await tx.select().from(tokens).where(and(eq(tokens.id, receipt.resultIds[0]!), eq(tokens.sceneId, context.scene.id), isNull(tokens.deletedAt))).limit(1);
        return token ? { token, scene: context.scene, replayed: true } as const : { error: 'RESULT_UNAVAILABLE' } as const;
      }
      if (input.imageAssetId) {
        const [asset] = await tx.select({ id: assets.id }).from(assets).where(and(eq(assets.id, input.imageAssetId), eq(assets.campaignId, context.scene.campaignId), eq(assets.category, 'TOKEN'))).for('share').limit(1);
        if (!asset) return { error: 'INVALID_ASSET' } as const;
      }
      const [token] = await tx.insert(tokens).values(input).returning();
      if (!token) throw new Error('Token creation failed');
      await tx.insert(auditEvents).values({ campaignId: context.scene.campaignId, actorId: context.userId, action: 'token.created', targetId: token.id });
      if (receipt?.kind === 'new') await saveOperationReceipt(tx, receipt, [token.id]);
      return { token, scene: context.scene, replayed: false } as const;
    });
    if ('error' in result) return reply.code(result.error === 'UNAUTHENTICATED' ? 401 : result.error === 'INVALID_ASSET' ? 400 : result.error === 'RESULT_UNAVAILABLE' || result.error === 'CONFLICT' ? 409 : result.error === 'NOT_FOUND' ? 404 : 403).send({ error: result.error });
    const { token, scene } = result;
    const projection = publicToken(token, true);
    if (!result.replayed) void publishTokenState(io, scene.campaignId, scene.id, [{ ...token, publication: 'create' }])
      .catch(() => request.log.error('Committed token creation could not be published'));
    return reply.code(result.replayed ? 200 : 201).send({ token: projection });
  });
  app.post('/api/tokens/:tokenId/duplicate', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const { tokenId } = request.params as { tokenId: string };
    const input = parseBody(duplicateTokenSchema, request.body);
    const requestId = operationRequestId(request.headers['idempotency-key']);
    if (requestId === 'invalid') return reply.code(400).send({ error: 'INVALID_REQUEST_ID' });
    const result = await db.transaction(async (tx) => {
      const context = await lockTokenDuplicateContext(tx, digest(cookie), input.sceneId, [tokenId]);
      if ('error' in context) return context;
      if (context.role !== 'OWNER' && context.role !== 'GM') return { error: 'FORBIDDEN' as const };
      const receipt = requestId ? await lockOperationReceipt(tx, { actorId: context.userId, campaignId: context.destination.campaignId, operationType: 'token.duplicate', requestId }, { tokenId, ...input }) : null;
      if (receipt?.kind === 'conflict') return { error: 'CONFLICT' as const };
      if (receipt?.kind === 'replay') {
        const [token] = await tx.select().from(tokens).where(and(eq(tokens.id, receipt.resultIds[0]!), eq(tokens.sceneId, context.destination.id), isNull(tokens.deletedAt))).limit(1);
        return token ? { token, campaignId: context.destination.campaignId, replayed: true } as const : { error: 'RESULT_UNAVAILABLE' as const };
      }
      const destination = context.destination;
      const source = context.sources.get(tokenId);
      if (!source) return { error: 'NOT_FOUND' as const };
      if (source.version !== input.expectedVersion) return { error: 'CONFLICT' as const };
      const { id: _sourceId, sceneId: _sourceSceneId, version: _sourceVersion, deletedAt: _deletedAt, ownerUserId: _ownerUserId, ownerNote: _ownerNote, ...copied } = source;
      const [token] = await tx.insert(tokens).values({
        ...copied,
        sceneId: destination.id,
        name: `${source.name} copy`.slice(0, 48),
        x: input.x,
        y: input.y,
        ownerUserId: null,
        ownerNote: '',
        version: 1,
        deletedAt: null,
      }).returning();
      if (!token) throw new Error('Token duplication failed');
      await tx.insert(auditEvents).values({ campaignId: destination.campaignId, actorId: context.userId, action: 'token.duplicated', targetId: token.id, detail: `source:${source.id}` });
      if (receipt?.kind === 'new') await saveOperationReceipt(tx, receipt, [token.id]);
      return { token, campaignId: destination.campaignId, isActive: destination.isActive, replayed: false };
    });
    if ('error' in result) return reply.code(result.error === 'UNAUTHENTICATED' ? 401 : result.error === 'FORBIDDEN' ? 403 : result.error === 'CONFLICT' || result.error === 'RESULT_UNAVAILABLE' ? 409 : 404).send({ error: result.error });
    if (!result.replayed) void publishTokenState(io, result.campaignId, result.token.sceneId, [{ ...result.token, publication: 'create' }])
      .catch(() => request.log.error('Committed token copy could not be published'));
    return reply.code(result.replayed ? 200 : 201).send({ token: publicToken(result.token, true) });
  });
  app.post('/api/scenes/:sceneId/tokens/duplicate', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const { sceneId } = request.params as { sceneId: string };
    const input = parseBody(duplicateTokensSchema, request.body);
    const requestId = operationRequestId(request.headers['idempotency-key']);
    if (requestId === 'invalid') return reply.code(400).send({ error: 'INVALID_REQUEST_ID' });
    if (input.sceneId !== sceneId) return reply.code(400).send({ error: 'SCENE_MISMATCH' });
    const result = await db.transaction(async (tx) => {
      const context = await lockTokenDuplicateContext(tx, digest(cookie), sceneId, input.tokens.map(({ tokenId }) => tokenId));
      if ('error' in context) return context;
      if (context.role !== 'OWNER' && context.role !== 'GM') return { error: 'FORBIDDEN' as const };
      const receipt = requestId ? await lockOperationReceipt(tx, { actorId: context.userId, campaignId: context.destination.campaignId, operationType: 'token.duplicate-group', requestId }, input) : null;
      if (receipt?.kind === 'conflict') return { error: 'CONFLICT' as const };
      if (receipt?.kind === 'replay') {
        const rows = await tx.select().from(tokens).where(and(inArray(tokens.id, receipt.resultIds), eq(tokens.sceneId, context.destination.id), isNull(tokens.deletedAt)));
        if (rows.length !== receipt.resultIds.length || rows.some((row) => row.hidden)) return { error: 'RESULT_UNAVAILABLE' as const };
        const byId = new Map(rows.map((row) => [row.id, row]));
        return { tokens: receipt.resultIds.map((id) => byId.get(id)!), campaignId: context.destination.campaignId, replayed: true } as const;
      }
      const destination = context.destination;
      const sources = context.sources;
      if (input.tokens.some((item) => sources.get(item.tokenId)?.version !== item.expectedVersion)) return { error: 'CONFLICT' as const };
      const duplicates = input.tokens.map((item) => {
        const source = sources.get(item.tokenId)!;
        const { id: _sourceId, sceneId: _sourceSceneId, version: _sourceVersion, deletedAt: _deletedAt, ownerUserId: _ownerUserId, ownerNote: _ownerNote, ...copied } = source;
        return { ...copied, id: randomUUID(), sceneId: destination.id, name: `${source.name} copy`.slice(0, 48), x: item.x, y: item.y, ownerUserId: null, ownerNote: '', version: 1, deletedAt: null };
      });
      const created = await tx.insert(tokens).values(duplicates).returning();
      await tx.insert(auditEvents).values(created.map((token, index) => ({ campaignId: destination.campaignId, actorId: context.userId, action: 'token.duplicated', targetId: token.id, detail: `source:${input.tokens[index]!.tokenId}` })));
      const byId = new Map(created.map((token) => [token.id, token]));
      const ordered = duplicates.map(({ id }) => byId.get(id)!);
      if (receipt?.kind === 'new') await saveOperationReceipt(tx, receipt, ordered.map(({ id }) => id));
      return { tokens: ordered, campaignId: destination.campaignId, isActive: destination.isActive, replayed: false };
    });
    if ('error' in result) return reply.code(result.error === 'UNAUTHENTICATED' ? 401 : result.error === 'FORBIDDEN' ? 403 : result.error === 'CONFLICT' || result.error === 'RESULT_UNAVAILABLE' ? 409 : 404).send({ error: result.error });
    if (!result.replayed) void publishTokenState(io, result.campaignId, sceneId, result.tokens.map((token) => ({ ...token, publication: 'create' })))
      .catch(() => request.log.error('Committed token copies could not be published'));
    return reply.code(result.replayed ? 200 : 201).send({ tokens: result.tokens.map((token) => publicToken(token, true)) });
  });
  app.get('/api/campaigns/:campaignId/token-trash', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const { campaignId } = request.params as { campaignId: string };
    const result = await db.transaction(async (tx) => {
      const actor = await lockCampaignActor(tx, digest(cookie), campaignId);
      if ('error' in actor) return actor;
      if (actor.role !== 'OWNER' && actor.role !== 'GM') return { error: 'FORBIDDEN' } as const;
      const rows = await tx.select({ id: tokens.id, sceneId: tokens.sceneId, sceneTitle: scenes.title, name: tokens.name, version: tokens.version, deletedAt: tokens.deletedAt, sceneArchivedAt: scenes.archivedAt })
        .from(tokens).innerJoin(scenes, eq(tokens.sceneId, scenes.id)).where(and(eq(scenes.campaignId, campaignId), sql`${tokens.deletedAt} IS NOT NULL`)).orderBy(desc(tokens.deletedAt));
      if (!await commandSessionIsActive(tx, digest(cookie))) return { error: 'UNAUTHENTICATED' } as const;
      return { rows } as const;
    });
    if ('error' in result) return reply.code(result.error === 'UNAUTHENTICATED' ? 401 : 403).send({ error: result.error });
    return result.rows;
  });
  for (const action of ['delete', 'restore'] as const) {
    const register = action === 'delete' ? app.delete.bind(app) : app.post.bind(app);
    register(action === 'delete' ? '/api/tokens/:tokenId' : '/api/tokens/:tokenId/restore', async (request, reply) => {
      const cookie = request.cookies[cookieName];
      if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
      const tokenId = parseBody(idSchema, (request.params as { tokenId: string }).tokenId);
      const { expectedVersion } = parseBody(z.object({ expectedVersion: z.number().int().positive() }), request.body);
      const result = await db.transaction(async (tx) => {
        const context = await lockTokenCommand(tx, digest(cookie), tokenId);
        if ('error' in context) return context;
        const { token, scene, role, userId } = context;
        if (action === 'delete' && token.deletedAt) return { error: 'NOT_FOUND' } as const;
        if (role === 'PLAYER') return { error: 'FORBIDDEN' } as const;
        if (action === 'restore' && !token.deletedAt) return { error: 'NOT_DELETED' } as const;
        if (token.version !== expectedVersion) return { error: 'CONFLICT' } as const;
        const [updated] = await tx.update(tokens).set({ deletedAt: action === 'delete' ? new Date() : null, version: expectedVersion + 1 })
          .where(and(eq(tokens.id, tokenId), eq(tokens.version, expectedVersion))).returning();
        if (!updated) throw new Error('Token lifecycle changed while locked');
        await tx.insert(auditEvents).values({ campaignId: scene.campaignId, actorId: userId, action: action === 'delete' ? 'token.deleted' : 'token.restored', targetId: tokenId });
        return { token: updated, scene };
      });
      if ('error' in result) return reply.code(result.error === 'NOT_DELETED' ? 409 : movementErrorStatus[result.error]).send({ error: result.error });
      const { token, scene } = result;
      void publishTokenState(io, scene.campaignId, scene.id, [{ ...token, publication: action === 'delete' ? 'delete' : 'create',
        wasPublic: action === 'delete' && scene.isActive && !token.hidden, note: action === 'restore' }])
        .catch(() => request.log.error('Committed token lifecycle could not be published'));
      void publishInitiative(io, scene.campaignId).catch(() => request.log.error('Token initiative could not be published'));
      return action === 'delete' ? reply.code(204).send() : { token: publicToken(token, true) };
    });
  }
  app.patch('/api/scenes/:sceneId/tokens/group', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const { sceneId } = request.params as { sceneId: string };
    const result = await updateTokenGroup(digest(cookie), sceneId, request.body);
    if ('error' in result) return reply.code(movementErrorStatus[result.error]).send({ error: result.error });
    void publishMovement(io, result).catch(() => request.log.error('Committed token group update could not be published'));
    if (result.changes.some(({ wasHidden, hidden }) => wasHidden !== hidden)) {
      void publishInitiative(io, result.campaignId).catch(() => request.log.error('Token group initiative could not be published'));
    }
    return { tokens: result.projections };
  });
  app.patch('/api/tokens/:tokenId', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const tokenHash = digest(cookie);
    const tokenId = parseBody(idSchema, (request.params as { tokenId: string }).tokenId);
    const { expectedVersion, ...patch } = parseBody(updateTokenSchema, request.body);
    const result = await db.transaction(async (tx) => {
      const context = await lockTokenCommand(tx, tokenHash, tokenId);
      if ('error' in context) return context;
      const { token, scene, role, userId } = context;
      if (token.deletedAt) return { error: 'NOT_FOUND' } as const;
      if (role === 'PLAYER') return { error: 'FORBIDDEN' } as const;
      if (patch.imageAssetId) {
        const [asset] = await tx.select({ id: assets.id }).from(assets).where(and(eq(assets.id, patch.imageAssetId), eq(assets.campaignId, scene.campaignId), eq(assets.category, 'TOKEN'))).limit(1);
        if (!asset) return { error: 'INVALID_ASSET' } as const;
      }
      if (token.version !== expectedVersion) return { error: 'CONFLICT' } as const;
      if (!await commandSessionIsActive(tx, tokenHash)) return { error: 'UNAUTHENTICATED' } as const;
      const [updated] = await tx.update(tokens).set({ ...patch, version: expectedVersion + 1 })
        .where(and(eq(tokens.id, tokenId), eq(tokens.version, expectedVersion))).returning();
      if (!updated) throw new Error('Token properties changed while locked');
      await tx.insert(auditEvents).values({ campaignId: scene.campaignId, actorId: userId, action: 'token.updated', targetId: tokenId });
      return { updated, previous: token, scene };
    });
    if ('error' in result) return reply.code(result.error === 'INVALID_ASSET' ? 400 : movementErrorStatus[result.error]).send({ error: result.error });
    const { previous, updated, scene } = result;
    const reveals = previous.hidden && !updated.hidden;
    void publishTokenState(io, scene.campaignId, scene.id, [{ ...updated, publication: reveals ? 'create' : 'update',
      wasPublic: scene.isActive && !previous.hidden, note: reveals || previous.ownerNote !== updated.ownerNote }])
      .catch(() => request.log.error('Committed token properties could not be published'));
    if (previous.hidden !== updated.hidden) void publishInitiative(io, scene.campaignId).catch(() => request.log.error('Token visibility initiative could not be published'));
    return { token: publicToken(updated, true) };
  });
  app.post('/api/tokens/:tokenId/resources/adjust', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const tokenId = parseBody(idSchema, (request.params as { tokenId: string }).tokenId);
    const input = parseBody(adjustTokenResourceSchema, request.body);
    const result = await db.transaction(async (tx) => {
      const context = await lockTokenCommand(tx, digest(cookie), tokenId);
      if ('error' in context) return context;
      const { token, scene, role, userId } = context;
      if (token.deletedAt) return { error: 'NOT_FOUND' } as const;
      if (role === 'PLAYER' && (token.hidden || !scene.isActive || token.ownerUserId !== userId || !token.resources[input.resourceIndex].visible)) return { error: 'FORBIDDEN' } as const;
      if (token.version !== input.expectedVersion) return { error: 'CONFLICT' } as const;
      const resources = structuredClone(token.resources);
      const resource = resources[input.resourceIndex];
      const current = resource.current + input.delta;
      if (current < 0 || current > resource.maximum) return { error: 'RESOURCE_LIMIT' } as const;
      resources[input.resourceIndex] = { ...resource, current };
      const [updated] = await tx.update(tokens).set({ resources, version: input.expectedVersion + 1 })
        .where(and(eq(tokens.id, tokenId), eq(tokens.version, input.expectedVersion))).returning();
      if (!updated) throw new Error('Token resources changed while locked');
      await tx.insert(auditEvents).values({ campaignId: scene.campaignId, actorId: userId, action: 'token.resource_adjusted', targetId: tokenId });
      return { updated, scene, role };
    });
    if ('error' in result) return reply.code(result.error === 'RESOURCE_LIMIT' ? 409 : movementErrorStatus[result.error]).send({ error: result.error });
    const { updated, scene, role } = result;
    void publishTokenState(io, scene.campaignId, scene.id, [{ ...updated, publication: 'update' }])
      .catch(() => request.log.error('Committed token resource could not be published'));
    return { token: publicToken(updated, role !== 'PLAYER') };
  });
  app.post('/api/tokens/:tokenId/owner', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const tokenHash = digest(cookie);
    const tokenId = parseBody(idSchema, (request.params as { tokenId: string }).tokenId);
    const input = parseBody(z.object({ ownerUserId: z.uuid().transform((id) => id.toLowerCase()).nullable() }), request.body);
    const result = await db.transaction(async (tx) => {
      const context = await lockTokenCommand(tx, tokenHash, tokenId, input.ownerUserId);
      if ('error' in context) return context;
      const { token, scene, role, roles, userId } = context;
      if (token.deletedAt) return { error: 'NOT_FOUND' } as const;
      if (role === 'PLAYER') return { error: 'FORBIDDEN' } as const;
      if (input.ownerUserId && !roles.has(input.ownerUserId)) return { error: 'INVALID_OWNER' } as const;
      const [updated] = await tx.update(tokens).set({ ownerUserId: input.ownerUserId, version: token.version + 1 })
        .where(and(eq(tokens.id, tokenId), eq(tokens.version, token.version))).returning();
      if (!updated) throw new Error('Locked token changed before ownership was applied');
      await tx.insert(auditEvents).values({ campaignId: scene.campaignId, actorId: userId, action: 'token.owner_changed', targetId: tokenId });
      return { updated, scene };
    }, { isolationLevel: 'read committed' });
    if ('error' in result) return reply.code(result.error === 'INVALID_OWNER' ? 400 : movementErrorStatus[result.error]).send({ error: result.error });
    const { updated, scene } = result;
    void publishTokenState(io, scene.campaignId, scene.id, [{ ...updated, publication: 'update', note: true }])
      .catch(() => request.log.error('Committed token ownership could not be published'));
    return { token: publicToken(updated, true) };
  });
}

import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { adjustTokenResourceSchema, createTokenSchema, duplicateTokenSchema, duplicateTokensSchema, updateTokenGroupSchema, updateTokenSchema } from '@nri/contracts';
import { db } from '../../db/index.js';
import { assets, auditEvents, memberships, scenes, tokens } from '../../db/schema.js';
import { canReadSceneTokens } from '../../domain/sceneAccess.js';
import type { FastifyInstance } from 'fastify';
import type { Server } from 'socket.io';
import { parseBody, requireUser, roleFor } from '../../security/access.js';
import { publicToken } from '../../domain/projections.js';
import { campaignMemberRoom } from '../../realtime/campaignRooms.js';

export function registerTokenRoutes(app: FastifyInstance, io: Server) {
  app.get('/api/scenes/:sceneId/tokens', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { sceneId } = request.params as { sceneId: string };
    const [scene] = await db.select().from(scenes).where(eq(scenes.id, sceneId)).limit(1);
    if (!scene || scene.archivedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
    const role = await roleFor(scene.campaignId, user.id);
    if (!role || !canReadSceneTokens(role, scene.isActive, scene.archivedAt !== null)) return reply.code(404).send({ error: 'NOT_FOUND' });
    const rows = await db.select().from(tokens).where(and(eq(tokens.sceneId, sceneId), isNull(tokens.deletedAt)));
    return rows.filter((token) => !token.hidden || role === 'OWNER' || role === 'GM').map((token) => publicToken(token, role === 'OWNER' || role === 'GM', user.id));
  });
  app.post('/api/tokens', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const input = parseBody(createTokenSchema, request.body);
    const [scene] = await db.select().from(scenes).where(eq(scenes.id, input.sceneId)).limit(1);
    if (!scene) return reply.code(404).send({ error: 'NOT_FOUND' });
    const role = await roleFor(scene.campaignId, user.id);
    if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
    if (scene.archivedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (input.imageAssetId) {
      const [asset] = await db.select({ id: assets.id }).from(assets).where(and(eq(assets.id, input.imageAssetId), eq(assets.campaignId, scene.campaignId), eq(assets.category, 'TOKEN'))).limit(1);
      if (!asset) return reply.code(400).send({ error: 'INVALID_ASSET' });
    }
    const [token] = await db.insert(tokens).values(input).returning();
    if (!token) throw new Error('Token creation failed');
    const projection = publicToken(token, true); const playerProjection = publicToken(token);
    const room = `campaign:${scene.campaignId}`;
    ((token.hidden || !scene.isActive) ? io.to(`${room}:gm`) : io.to(room)).emit('token:created', token.hidden || !scene.isActive ? projection : playerProjection);
    return reply.code(201).send({ token: projection });
  });
  app.post('/api/tokens/:tokenId/duplicate', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { tokenId } = request.params as { tokenId: string };
    const input = parseBody(duplicateTokenSchema, request.body);
    const result = await db.transaction(async (tx) => {
      const [source] = await tx.select({ token: tokens, scene: scenes }).from(tokens).innerJoin(scenes, eq(tokens.sceneId, scenes.id))
        .where(and(eq(tokens.id, tokenId), isNull(tokens.deletedAt), isNull(scenes.archivedAt))).for('update').limit(1);
      if (!source) return { error: 'NOT_FOUND' as const };
      const [destination] = await tx.select().from(scenes).where(eq(scenes.id, input.sceneId)).for('update').limit(1);
      if (!destination || destination.archivedAt || destination.campaignId !== source.scene.campaignId) return { error: 'NOT_FOUND' as const };
      const [membership] = await tx.select({ role: memberships.role }).from(memberships)
        .where(and(eq(memberships.campaignId, source.scene.campaignId), eq(memberships.userId, user.id))).limit(1);
      if (!membership || !['OWNER', 'GM'].includes(membership.role)) return { error: 'FORBIDDEN' as const };
      if (source.token.version !== input.expectedVersion) return { error: 'CONFLICT' as const };
      const { id: _sourceId, sceneId: _sourceSceneId, version: _sourceVersion, deletedAt: _deletedAt, ownerUserId: _ownerUserId, ownerNote: _ownerNote, ...copied } = source.token;
      const [token] = await tx.insert(tokens).values({
        ...copied,
        sceneId: destination.id,
        name: `${source.token.name} copy`.slice(0, 48),
        x: input.x,
        y: input.y,
        ownerUserId: null,
        ownerNote: '',
        version: 1,
        deletedAt: null,
      }).returning();
      if (!token) throw new Error('Token duplication failed');
      await tx.insert(auditEvents).values({ campaignId: source.scene.campaignId, actorId: user.id, action: 'token.duplicated', targetId: token.id, detail: `source:${source.token.id}` });
      return { token, campaignId: destination.campaignId, isActive: destination.isActive };
    });
    if ('error' in result) return reply.code(result.error === 'FORBIDDEN' ? 403 : result.error === 'CONFLICT' ? 409 : 404).send({ error: result.error });
    const room = `campaign:${result.campaignId}`;
    ((result.token.hidden || !result.isActive) ? io.to(`${room}:gm`) : io.to(room)).emit('token:created', result.token.hidden || !result.isActive ? publicToken(result.token, true) : publicToken(result.token));
    return reply.code(201).send({ token: publicToken(result.token, true) });
  });
  app.post('/api/scenes/:sceneId/tokens/duplicate', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { sceneId } = request.params as { sceneId: string };
    const input = parseBody(duplicateTokensSchema, request.body);
    if (input.sceneId !== sceneId) return reply.code(400).send({ error: 'SCENE_MISMATCH' });
    const result = await db.transaction(async (tx) => {
      const [destination] = await tx.select().from(scenes).where(eq(scenes.id, sceneId)).for('update').limit(1);
      if (!destination || destination.archivedAt) return { error: 'NOT_FOUND' as const };
      const [membership] = await tx.select({ role: memberships.role }).from(memberships)
        .where(and(eq(memberships.campaignId, destination.campaignId), eq(memberships.userId, user.id))).limit(1);
      if (!membership || !['OWNER', 'GM'].includes(membership.role)) return { error: 'FORBIDDEN' as const };
      const sourceRows = await tx.select({ token: tokens, scene: scenes }).from(tokens).innerJoin(scenes, eq(tokens.sceneId, scenes.id))
        .where(and(inArray(tokens.id, input.tokens.map((item) => item.tokenId)), isNull(tokens.deletedAt), isNull(scenes.archivedAt)))
        .orderBy(asc(tokens.id)).for('update');
      if (sourceRows.length !== input.tokens.length || sourceRows.some(({ scene: sourceScene }) => sourceScene.campaignId !== destination.campaignId)) return { error: 'NOT_FOUND' as const };
      const sources = new Map(sourceRows.map(({ token }) => [token.id, token]));
      if (input.tokens.some((item) => sources.get(item.tokenId)?.version !== item.expectedVersion)) return { error: 'CONFLICT' as const };
      const duplicates = input.tokens.map((item) => {
        const source = sources.get(item.tokenId)!;
        const { id: _sourceId, sceneId: _sourceSceneId, version: _sourceVersion, deletedAt: _deletedAt, ownerUserId: _ownerUserId, ownerNote: _ownerNote, ...copied } = source;
        return { ...copied, id: randomUUID(), sceneId: destination.id, name: `${source.name} copy`.slice(0, 48), x: item.x, y: item.y, ownerUserId: null, ownerNote: '', version: 1, deletedAt: null };
      });
      const created = await tx.insert(tokens).values(duplicates).returning();
      await tx.insert(auditEvents).values(created.map((token, index) => ({ campaignId: destination.campaignId, actorId: user.id, action: 'token.duplicated', targetId: token.id, detail: `source:${input.tokens[index]!.tokenId}` })));
      const byId = new Map(created.map((token) => [token.id, token]));
      return { tokens: duplicates.map(({ id }) => byId.get(id)!), campaignId: destination.campaignId, isActive: destination.isActive };
    });
    if ('error' in result) return reply.code(result.error === 'FORBIDDEN' ? 403 : result.error === 'CONFLICT' ? 409 : 404).send({ error: result.error });
    const room = `campaign:${result.campaignId}`;
    for (const token of result.tokens) {
      ((token.hidden || !result.isActive) ? io.to(`${room}:gm`) : io.to(room)).emit('token:created', token.hidden || !result.isActive ? publicToken(token, true) : publicToken(token));
    }
    return reply.code(201).send({ tokens: result.tokens.map((token) => publicToken(token, true)) });
  });
  app.get('/api/campaigns/:campaignId/token-trash', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { campaignId } = request.params as { campaignId: string };
    const role = await roleFor(campaignId, user.id);
    if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
    return db.select({ id: tokens.id, sceneId: tokens.sceneId, sceneTitle: scenes.title, name: tokens.name, version: tokens.version, deletedAt: tokens.deletedAt, sceneArchivedAt: scenes.archivedAt }).from(tokens).innerJoin(scenes, eq(tokens.sceneId, scenes.id)).where(and(eq(scenes.campaignId, campaignId), sql`${tokens.deletedAt} IS NOT NULL`)).orderBy(desc(tokens.deletedAt));
  });
  app.delete('/api/tokens/:tokenId', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { tokenId } = request.params as { tokenId: string };
    const input = parseBody(z.object({ expectedVersion: z.number().int().positive() }), request.body);
    const [row] = await db.select({ token: tokens, scene: scenes }).from(tokens).innerJoin(scenes, eq(tokens.sceneId, scenes.id)).where(eq(tokens.id, tokenId)).limit(1);
    if (!row || row.scene.archivedAt || row.token.deletedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
    const role = await roleFor(row.scene.campaignId, user.id);
    if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
    const [deleted] = await db.update(tokens).set({ deletedAt: new Date(), version: row.token.version + 1 }).where(and(eq(tokens.id, tokenId), eq(tokens.version, input.expectedVersion), isNull(tokens.deletedAt))).returning({ id: tokens.id });
    if (!deleted) return reply.code(409).send({ error: 'CONFLICT' });
    await db.insert(auditEvents).values({ campaignId: row.scene.campaignId, actorId: user.id, action: 'token.deleted', targetId: tokenId });
    if (row.scene.isActive && !row.token.hidden) io.to(`campaign:${row.scene.campaignId}`).emit('token:hidden', { id: tokenId, sceneId: row.scene.id });
    return reply.code(204).send();
  });
  app.post('/api/tokens/:tokenId/restore', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { tokenId } = request.params as { tokenId: string };
    const input = parseBody(z.object({ expectedVersion: z.number().int().positive() }), request.body);
    const [row] = await db.select({ token: tokens, scene: scenes }).from(tokens).innerJoin(scenes, eq(tokens.sceneId, scenes.id)).where(eq(tokens.id, tokenId)).limit(1);
    if (!row || row.scene.archivedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
    const role = await roleFor(row.scene.campaignId, user.id);
    if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
    if (!row.token.deletedAt) return reply.code(409).send({ error: 'NOT_DELETED' });
    const [restored] = await db.update(tokens).set({ deletedAt: null, version: row.token.version + 1 }).where(and(eq(tokens.id, tokenId), eq(tokens.version, input.expectedVersion), isNotNull(tokens.deletedAt))).returning();
    if (!restored) return reply.code(409).send({ error: 'CONFLICT' });
    await db.insert(auditEvents).values({ campaignId: row.scene.campaignId, actorId: user.id, action: 'token.restored', targetId: tokenId });
    const room = `campaign:${row.scene.campaignId}`;
    if (row.scene.isActive && !restored.hidden) io.to(room).emit('token:created', publicToken(restored));
    else io.to(`${room}:gm`).emit('token:created', publicToken(restored, true));
    return { token: publicToken(restored, true) };
  });
  app.patch('/api/scenes/:sceneId/tokens/group', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { sceneId } = request.params as { sceneId: string };
    const input = parseBody(updateTokenGroupSchema, request.body);
    const [scene] = await db.select().from(scenes).where(eq(scenes.id, sceneId)).limit(1);
    if (!scene || scene.archivedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
    const role = await roleFor(scene.campaignId, user.id);
    if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
    const ids = input.updates.map((item) => item.tokenId);
    const result = await db.transaction(async (tx) => {
      const rows = await tx.select().from(tokens).where(and(eq(tokens.sceneId, sceneId), inArray(tokens.id, ids))).for('update');
      if (rows.length !== input.updates.length || rows.some((row) => row.deletedAt)) return { error: 'NOT_FOUND' as const };
      const byId = new Map(rows.map((row) => [row.id, row]));
      if (input.updates.some((item) => byId.get(item.tokenId)?.version !== item.expectedVersion)) return { error: 'CONFLICT' as const };
      const updated = [];
      for (const item of input.updates) {
        const previous = byId.get(item.tokenId)!;
        const [next] = await tx.update(tokens).set({ ...item.patch, version: previous.version + 1 }).where(and(eq(tokens.id, previous.id), eq(tokens.version, item.expectedVersion), isNull(tokens.deletedAt))).returning();
        if (!next) throw new Error('Locked group token changed during transaction');
        updated.push({ previous, token: next });
        await tx.insert(auditEvents).values({ campaignId: scene.campaignId, actorId: user.id, action: 'token.group_updated', targetId: next.id });
      }
      return { updated };
    });
    if ('error' in result) return reply.code(result.error === 'CONFLICT' ? 409 : 404).send({ error: result.error });
    const room = `campaign:${scene.campaignId}`;
    for (const { previous, token } of result.updated) {
      if (scene.isActive && !previous.hidden && token.hidden) io.to(room).emit('token:hidden', { id: token.id, sceneId });
      else if (scene.isActive && !token.hidden) io.to(room).emit(previous.hidden ? 'token:created' : 'token:updated', publicToken(token));
      io.to(`${room}:gm`).emit('token:updated', publicToken(token, true));
    }
    return { tokens: result.updated.map(({ token }) => publicToken(token, true)) };
  });
  app.patch('/api/tokens/:tokenId', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { tokenId } = request.params as { tokenId: string };
    const input = parseBody(updateTokenSchema, request.body);
    const { expectedVersion, ...patch } = input;
    const [row] = await db.select({ token: tokens, scene: scenes }).from(tokens).innerJoin(scenes, eq(tokens.sceneId, scenes.id)).where(eq(tokens.id, tokenId)).limit(1);
    if (!row || row.scene.archivedAt || row.token.deletedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
    const role = await roleFor(row.scene.campaignId, user.id);
    if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
    if (patch.imageAssetId) {
      const [asset] = await db.select({ id: assets.id }).from(assets).where(and(eq(assets.id, patch.imageAssetId), eq(assets.campaignId, row.scene.campaignId), eq(assets.category, 'TOKEN'))).limit(1);
      if (!asset) return reply.code(400).send({ error: 'INVALID_ASSET' });
    }
    const [updated] = await db.update(tokens).set({ ...patch, version: row.token.version + 1 }).where(and(eq(tokens.id, tokenId), eq(tokens.version, expectedVersion))).returning();
    if (!updated) return reply.code(409).send({ error: 'CONFLICT' });
    await db.insert(auditEvents).values({ campaignId: row.scene.campaignId, actorId: user.id, action: 'token.updated', targetId: tokenId });
    const room = `campaign:${row.scene.campaignId}`; const wasVisible = !row.token.hidden && row.scene.isActive; const isVisible = !updated.hidden && row.scene.isActive; const projection = publicToken(updated, true); const playerProjection = publicToken(updated);
    if (wasVisible && !isVisible) io.to(room).emit('token:hidden', { id: updated.id, sceneId: updated.sceneId });
    else if (isVisible) io.to(room).emit(wasVisible ? 'token:updated' : 'token:created', playerProjection);
    if (isVisible && updated.ownerUserId && (!wasVisible || updated.ownerNote !== row.token.ownerNote)) {
      io.to(campaignMemberRoom(row.scene.campaignId, updated.ownerUserId)).emit('token:owner_note', { id: updated.id, ownerUserId: updated.ownerUserId, ownerNote: updated.ownerNote, version: updated.version });
    }
    io.to(`${room}:gm`).emit('token:updated', projection);
    return { token: projection };
  });
  app.post('/api/tokens/:tokenId/resources/adjust', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { tokenId } = request.params as { tokenId: string };
    const input = parseBody(adjustTokenResourceSchema, request.body);
    const [row] = await db.select({ token: tokens, scene: scenes }).from(tokens).innerJoin(scenes, eq(tokens.sceneId, scenes.id)).where(eq(tokens.id, tokenId)).limit(1);
    if (!row || row.scene.archivedAt || row.token.deletedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
    const role = await roleFor(row.scene.campaignId, user.id);
    if (!role || (!['OWNER', 'GM'].includes(role) && (row.token.hidden || !row.scene.isActive || row.token.ownerUserId !== user.id || !row.token.resources[input.resourceIndex].visible))) return reply.code(403).send({ error: 'FORBIDDEN' });
    if (row.token.version !== input.expectedVersion) return reply.code(409).send({ error: 'CONFLICT' });
    const resources = structuredClone(row.token.resources); const resource = resources[input.resourceIndex]; const current = resource.current + input.delta;
    if (current < 0 || current > resource.maximum) return reply.code(409).send({ error: 'RESOURCE_LIMIT' });
    resources[input.resourceIndex] = { ...resource, current };
    const [updated] = await db.update(tokens).set({ resources, version: row.token.version + 1 }).where(and(eq(tokens.id, tokenId), eq(tokens.version, input.expectedVersion))).returning();
    if (!updated) return reply.code(409).send({ error: 'CONFLICT' });
    await db.insert(auditEvents).values({ campaignId: row.scene.campaignId, actorId: user.id, action: 'token.resource_adjusted', targetId: tokenId });
    const room = `campaign:${row.scene.campaignId}`; const projection = publicToken(updated, true); const playerProjection = publicToken(updated);
    if (!updated.hidden && row.scene.isActive) io.to(room).emit('token:updated', playerProjection);
    io.to(`${room}:gm`).emit('token:updated', projection);
    return { token: role === 'OWNER' || role === 'GM' ? projection : playerProjection };
  });
  app.post('/api/tokens/:tokenId/owner', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { tokenId } = request.params as { tokenId: string };
    const input = parseBody(z.object({ ownerUserId: z.uuid().nullable() }), request.body);
    const [row] = await db.select({ token: tokens, scene: scenes }).from(tokens).innerJoin(scenes, eq(tokens.sceneId, scenes.id)).where(eq(tokens.id, tokenId)).limit(1);
    if (!row || row.token.deletedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
    const role = await roleFor(row.scene.campaignId, user.id);
    if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
    if (row.scene.archivedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (input.ownerUserId && !await roleFor(row.scene.campaignId, input.ownerUserId)) return reply.code(400).send({ error: 'INVALID_OWNER' });
    const [updated] = await db.update(tokens).set({ ownerUserId: input.ownerUserId, version: row.token.version + 1 }).where(and(eq(tokens.id, tokenId), eq(tokens.version, row.token.version))).returning();
    if (!updated) return reply.code(409).send({ error: 'CONFLICT' });
    await db.insert(auditEvents).values({ campaignId: row.scene.campaignId, actorId: user.id, action: 'token.owner_changed', targetId: tokenId });
    const projection = publicToken(updated, true); const playerProjection = publicToken(updated);
    ((updated.hidden || !row.scene.isActive) ? io.to(`campaign:${row.scene.campaignId}:gm`) : io.to(`campaign:${row.scene.campaignId}`)).emit('token:updated', updated.hidden || !row.scene.isActive ? projection : playerProjection);
    if (!updated.hidden && row.scene.isActive && updated.ownerUserId) {
      io.to(campaignMemberRoom(row.scene.campaignId, updated.ownerUserId)).emit('token:owner_note', { id: updated.id, ownerUserId: updated.ownerUserId, ownerNote: updated.ownerNote, version: updated.version });
    }
    return { token: projection };
  });
}

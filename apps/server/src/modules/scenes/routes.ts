import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { createSceneSchema } from '@nri/contracts';
import { db } from '../../db/index.js';
import { auditEvents, sceneLayers, sceneObjects, scenes, tokens } from '../../db/schema.js';
import { canListScene } from '../../domain/sceneAccess.js';
import type { FastifyInstance } from 'fastify';
import type { Server } from 'socket.io';
import { digest, parseBody } from '../../security/access.js';
import { defaultLayerRows } from '../../domain/defaultLayers.js';
import { commandSessionIsActive, lockCampaignActor, lockCampaignSceneActor } from '../../security/commandAccess.js';
import { cookieName } from '../../config/runtime.js';
import { invalidateSceneInitiative } from '../initiative/service.js';
import { publishInitiative } from '../../realtime/initiativeEvents.js';
import { publishSceneActivation, publishSceneUpdate } from '../../realtime/sceneEvents.js';
import { lockOperationReceipt, operationRequestId, saveOperationReceipt } from '../../security/operationReceipts.js';

export function registerSceneRoutes(app: FastifyInstance, io: Server) {
  app.get('/api/campaigns/:campaignId/scenes', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const { campaignId } = request.params as { campaignId: string };
    const archived = (request.query as { archived?: string }).archived === 'true';
    const result = await db.transaction(async (tx) => {
      const actor = await lockCampaignActor(tx, digest(cookie), campaignId);
      if ('error' in actor) return actor;
      if (archived && actor.role !== 'OWNER' && actor.role !== 'GM') return { error: 'FORBIDDEN' } as const;
      const rows = await tx.select().from(scenes).where(eq(scenes.campaignId, campaignId)).orderBy(asc(scenes.sortOrder), asc(scenes.id));
      if (!await commandSessionIsActive(tx, digest(cookie))) return { error: 'UNAUTHENTICATED' } as const;
      return { scenes: rows.filter((scene) => canListScene(actor.role, scene.isActive, scene.archivedAt !== null, archived)) } as const;
    });
    if ('error' in result) return reply.code(result.error === 'UNAUTHENTICATED' ? 401 : result.error === 'FORBIDDEN' ? 403 : 404).send({ error: result.error });
    return result.scenes;
  });

  app.patch('/api/scenes/:sceneId', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const { sceneId } = request.params as { sceneId: string };
    const input = parseBody(z.object({
      title: z.string().trim().min(1).max(80).optional(), gridSize: z.number().int().min(8).max(256).optional(), width: z.number().int().min(256).max(16384).optional(), height: z.number().int().min(256).max(16384).optional(),
      gridColor: z.string().regex(/^#[\da-fA-F]{6}$/).optional(), gridOpacity: z.number().min(0).max(1).optional(), gridOffsetX: z.number().min(-16384).max(16384).optional(), gridOffsetY: z.number().min(-16384).max(16384).optional(), gridEnabled: z.boolean().optional(), snapToGrid: z.boolean().optional(), unitsPerCell: z.number().min(0.01).max(100000).optional(), unitLabel: z.string().trim().min(1).max(24).optional(), cameraX: z.number().min(-32768).max(32768).optional(), cameraY: z.number().min(-32768).max(32768).optional(), cameraZoom: z.number().min(0.25).max(4).optional(), expectedVersion: z.number().int().positive(),
    }).refine(({ expectedVersion: _expectedVersion, ...fields }) => Object.values(fields).some((value) => value !== undefined)), request.body);
    const { expectedVersion, ...patch } = input;
    const result = await db.transaction(async (tx) => {
      const context = await lockCampaignSceneActor(tx, digest(cookie), sceneId, { sceneStrength: 'update' });
      if ('error' in context) return context;
      if (context.role !== 'OWNER' && context.role !== 'GM') return { error: 'FORBIDDEN' } as const;
      if (context.scene.version !== expectedVersion) return { error: 'CONFLICT' } as const;
      const [updated] = await tx.update(scenes).set({ ...patch, version: expectedVersion + 1 })
        .where(and(eq(scenes.id, sceneId), eq(scenes.version, expectedVersion), isNull(scenes.archivedAt))).returning();
      if (!updated) return { error: 'CONFLICT' } as const;
      await tx.insert(auditEvents).values({ campaignId: context.scene.campaignId, actorId: context.userId, action: 'scene.updated', targetId: sceneId });
      return { updated, campaignId: context.scene.campaignId } as const;
    });
    if ('error' in result) return reply.code(result.error === 'UNAUTHENTICATED' ? 401 : result.error === 'NOT_FOUND' ? 404 : result.error === 'CONFLICT' ? 409 : 403).send({ error: result.error });
    const { updated } = result;
    if (updated.isActive) void publishSceneUpdate(io, result.campaignId, sceneId, updated.version).catch(() => request.log.error('Scene update could not be published'));
    return { scene: updated };
  });
  app.post('/api/scenes/:sceneId/duplicate', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const { sceneId } = request.params as { sceneId: string };
    const requestId = operationRequestId(request.headers['idempotency-key']);
    if (requestId === 'invalid') return reply.code(400).send({ error: 'INVALID_REQUEST_ID' });
    const duplicate = await db.transaction(async (tx) => {
      const context = await lockCampaignSceneActor(tx, digest(cookie), sceneId, { sceneStrength: 'update', includeArchived: Boolean(requestId) });
      if ('error' in context) return context;
      if (context.role !== 'OWNER' && context.role !== 'GM') return { error: 'FORBIDDEN' } as const;
      const source = context.scene;
      const receipt = requestId ? await lockOperationReceipt(tx, { actorId: context.userId, campaignId: source.campaignId, operationType: 'scene.duplicate', requestId }, { sceneId }) : null;
      if (receipt?.kind === 'conflict') return { error: 'CONFLICT' } as const;
      if (receipt?.kind === 'replay') {
        const [scene] = await tx.select().from(scenes).where(and(eq(scenes.id, receipt.resultIds[0]!), eq(scenes.campaignId, source.campaignId), isNull(scenes.archivedAt))).limit(1);
        return scene ? { scene, replayed: true } as const : { error: 'RESULT_UNAVAILABLE' } as const;
      }
      if (source.archivedAt) return { error: 'NOT_FOUND' as const };
      const [last] = await tx.select({ sortOrder: scenes.sortOrder }).from(scenes).where(eq(scenes.campaignId, source.campaignId)).orderBy(desc(scenes.sortOrder), desc(scenes.id)).limit(1);
      const { id: _id, archivedAt: _archivedAt, version: _version, isActive: _isActive, published: _published, sortOrder: _sortOrder, ...copy } = source;
      const [scene] = await tx.insert(scenes).values({ ...copy, title: `${source.title} (copy)`.slice(0, 80), sortOrder: (last?.sortOrder ?? -1) + 1, isActive: false, published: false, archivedAt: null, version: 1 }).returning();
      if (!scene) throw new Error('Scene duplication failed');
      const sourceLayers = await tx.select().from(sceneLayers).where(eq(sceneLayers.sceneId, source.id)).orderBy(asc(sceneLayers.id)).for('share');
      const copiedLayers = await tx.insert(sceneLayers).values(sourceLayers.map(({ id: _layerId, sceneId: _sceneId, ...layer }) => ({ ...layer, sceneId: scene.id, version: 1 }))).returning();
      const layerMap = new Map(sourceLayers.map((layer, index) => [layer.id, copiedLayers[index]!.id]));
      const sourceObjects = await tx.select().from(sceneObjects).where(and(eq(sceneObjects.sceneId, source.id), isNull(sceneObjects.deletedAt))).orderBy(asc(sceneObjects.id)).for('share');
      if (sourceObjects.length) await tx.insert(sceneObjects).values(sourceObjects.map(({ id: _objectId, sceneId: _sceneId, layerId, ...object }) => ({ ...object, sceneId: scene.id, layerId: layerMap.get(layerId)!, version: 1 })));
      const sourceTokens = await tx.select().from(tokens).where(and(eq(tokens.sceneId, source.id), isNull(tokens.deletedAt))).orderBy(asc(tokens.id)).for('share');
      if (sourceTokens.length) await tx.insert(tokens).values(sourceTokens.map(({ id: _id, sceneId: _sceneId, ...token }) => ({ ...token, sceneId: scene.id })));
      await tx.insert(auditEvents).values({ campaignId: source.campaignId, actorId: context.userId, action: 'scene.duplicated', targetId: scene.id });
      if (receipt?.kind === 'new') await saveOperationReceipt(tx, receipt, [scene.id]);
      return { scene, replayed: false } as const;
    });
    if ('error' in duplicate) return reply.code(duplicate.error === 'UNAUTHENTICATED' ? 401 : duplicate.error === 'NOT_FOUND' ? 404 : duplicate.error === 'CONFLICT' || duplicate.error === 'RESULT_UNAVAILABLE' ? 409 : 403).send({ error: duplicate.error });
    return reply.code(duplicate.replayed ? 200 : 201).send({ scene: duplicate.scene });
  });
  app.put('/api/scenes/:sceneId/archive', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const { sceneId } = request.params as { sceneId: string };
    const input = parseBody(z.object({ expectedVersion: z.number().int().positive() }), request.body);
    const result = await db.transaction(async (tx) => {
        const context = await lockCampaignSceneActor(tx, digest(cookie), sceneId, { campaignStrength: 'no key update', sceneStrength: 'update', includeArchived: true });
        if ('error' in context) return context;
        if (context.role !== 'OWNER' && context.role !== 'GM') return { error: 'FORBIDDEN' } as const;
        const scene = context.scene;
        if (scene.archivedAt) return { error: 'CONFLICT' } as const;
        if (scene.version !== input.expectedVersion) return { error: 'CONFLICT' } as const;
        const [updated] = await tx.update(scenes).set({ archivedAt: new Date(), isActive: false, version: input.expectedVersion + 1 })
          .where(and(eq(scenes.id, sceneId), eq(scenes.version, input.expectedVersion), isNull(scenes.archivedAt))).returning();
        if (!updated) return { error: 'CONFLICT' } as const;
        let activated: typeof scene | null = null;
        if (scene.isActive) {
          const [fallback] = await tx.select().from(scenes).where(and(eq(scenes.campaignId, scene.campaignId), isNull(scenes.archivedAt), eq(scenes.published, true), sql`${scenes.id} <> ${sceneId}`)).orderBy(desc(scenes.sortOrder), desc(scenes.id)).for('update').limit(1);
          if (fallback) { const [next] = await tx.update(scenes).set({ isActive: true, version: fallback.version + 1 }).where(and(eq(scenes.id, fallback.id), eq(scenes.version, fallback.version))).returning(); if (!next) throw new Error('Scene archive fallback lost its locked version'); activated = next; }
        }
        await tx.insert(auditEvents).values({ campaignId: scene.campaignId, actorId: context.userId, action: 'scene.archived', targetId: sceneId });
        const initiativeVersion = await invalidateSceneInitiative(tx, scene.campaignId, sceneId, 'archive');
        return { scene: updated, activated, initiativeVersion, campaignId: scene.campaignId, wasActive: scene.isActive } as const;
    });
    if ('error' in result) return reply.code(result.error === 'UNAUTHENTICATED' ? 401 : result.error === 'NOT_FOUND' ? 404 : result.error === 'CONFLICT' ? 409 : 403).send({ error: result.error });
    if (result.wasActive) void publishSceneActivation(io, result.campaignId).catch(() => request.log.error('Scene activation could not be published'));
    if (result.initiativeVersion !== undefined) void publishInitiative(io, result.campaignId, result.initiativeVersion).catch(() => request.log.error('Scene initiative could not be published'));
    return { scene: result.scene };
  });
  app.post('/api/scenes', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const input = parseBody(createSceneSchema, request.body);
    const requestId = operationRequestId(request.headers['idempotency-key']);
    if (requestId === 'invalid') return reply.code(400).send({ error: 'INVALID_REQUEST_ID' });
    const result = await db.transaction(async (tx) => {
      const actor = await lockCampaignActor(tx, digest(cookie), input.campaignId, { strength: 'no key update' });
      if ('error' in actor) return actor;
      if (actor.role !== 'OWNER' && actor.role !== 'GM') return { error: 'FORBIDDEN' } as const;
      const receipt = requestId ? await lockOperationReceipt(tx, { actorId: actor.userId, campaignId: input.campaignId, operationType: 'scene.create', requestId }, input) : null;
      if (receipt?.kind === 'conflict') return { error: 'CONFLICT' } as const;
      if (receipt?.kind === 'replay') {
        const [scene] = await tx.select().from(scenes).where(and(eq(scenes.id, receipt.resultIds[0]!), eq(scenes.campaignId, input.campaignId), isNull(scenes.archivedAt))).limit(1);
        return scene ? { scene, replayed: true } as const : { error: 'RESULT_UNAVAILABLE' } as const;
      }
      const [last] = await tx.select({ sortOrder: scenes.sortOrder }).from(scenes).where(eq(scenes.campaignId, input.campaignId)).orderBy(desc(scenes.sortOrder)).limit(1);
      const [active] = await tx.select({ id: scenes.id }).from(scenes).where(and(eq(scenes.campaignId, input.campaignId), eq(scenes.isActive, true), isNull(scenes.archivedAt))).limit(1);
      const [created] = await tx.insert(scenes).values({ campaignId: input.campaignId, title: input.title, gridSize: input.gridSize, sortOrder: (last?.sortOrder ?? -1) + 1, isActive: !active, published: !active }).returning();
      if (created) await tx.insert(sceneLayers).values(defaultLayerRows.map((layer) => ({ ...layer, sceneId: created.id })));
      if (!created) throw new Error('Scene creation failed');
      await tx.insert(auditEvents).values({ campaignId: input.campaignId, actorId: actor.userId, action: 'scene.created', targetId: created.id });
      if (receipt?.kind === 'new') await saveOperationReceipt(tx, receipt, [created.id]);
      return { scene: created, replayed: false } as const;
    });
    if ('error' in result) return reply.code(result.error === 'UNAUTHENTICATED' ? 401 : result.error === 'NOT_FOUND' ? 404 : result.error === 'CONFLICT' || result.error === 'RESULT_UNAVAILABLE' ? 409 : 403).send({ error: result.error });
    const { scene } = result;
    if (!result.replayed && scene.isActive) void publishSceneActivation(io, input.campaignId).catch(() => request.log.error('Scene activation could not be published'));
    return reply.code(result.replayed ? 200 : 201).send({ scene });
  });
  app.put('/api/scenes/:sceneId/activate', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const { sceneId } = request.params as { sceneId: string };
    const input = parseBody(z.object({ expectedVersion: z.number().int().positive() }), request.body);
    const result = await db.transaction(async (tx) => {
      const context = await lockCampaignSceneActor(tx, digest(cookie), sceneId, { campaignStrength: 'no key update', sceneStrength: 'update' });
      if ('error' in context) return context;
      if (context.role !== 'OWNER' && context.role !== 'GM') return { error: 'FORBIDDEN' } as const;
      const scene = context.scene;
      if (scene.version !== input.expectedVersion) return { error: 'CONFLICT' } as const;
      if (scene.isActive) return { activated: scene, campaignId: scene.campaignId, changed: false, initiativeVersion: undefined } as const;
      await tx.update(scenes).set({ isActive: false, version: sql`${scenes.version} + 1` }).where(and(eq(scenes.campaignId, scene.campaignId), eq(scenes.isActive, true)));
      const [updated] = await tx.update(scenes).set({ isActive: true, published: true, version: scene.version + 1 })
        .where(and(eq(scenes.id, scene.id), eq(scenes.version, input.expectedVersion), isNull(scenes.archivedAt))).returning();
      if (!updated) throw new Error('Scene activation lost its locked version');
      await tx.insert(auditEvents).values({ campaignId: scene.campaignId, actorId: context.userId, action: 'scene.activated', targetId: sceneId });
      const initiativeVersion = await invalidateSceneInitiative(tx, scene.campaignId, sceneId, 'activate');
      return { activated: updated, campaignId: scene.campaignId, changed: true, initiativeVersion } as const;
    });
    if ('error' in result) return reply.code(result.error === 'UNAUTHENTICATED' ? 401 : result.error === 'NOT_FOUND' ? 404 : result.error === 'CONFLICT' ? 409 : 403).send({ error: result.error });
    if (result.changed) void publishSceneActivation(io, result.campaignId).catch(() => request.log.error('Scene activation could not be published'));
    if (result.initiativeVersion !== undefined) void publishInitiative(io, result.campaignId, result.initiativeVersion).catch(() => request.log.error('Scene initiative could not be published'));
    return { scene: result.activated };
  });
  app.put('/api/scenes/:sceneId/restore', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const { sceneId } = request.params as { sceneId: string };
    const input = parseBody(z.object({ expectedVersion: z.number().int().positive() }), request.body);
    const result = await db.transaction(async (tx) => {
      const context = await lockCampaignSceneActor(tx, digest(cookie), sceneId, { campaignStrength: 'no key update', sceneStrength: 'update', includeArchived: true });
      if ('error' in context) return context;
      if (context.role !== 'OWNER' && context.role !== 'GM') return { error: 'FORBIDDEN' } as const;
      const scene = context.scene;
      if (!scene.archivedAt || scene.version !== input.expectedVersion) return { error: 'CONFLICT' } as const;
      const [last] = await tx.select({ sortOrder: scenes.sortOrder }).from(scenes).where(eq(scenes.campaignId, scene.campaignId)).orderBy(desc(scenes.sortOrder), desc(scenes.id)).limit(1);
      const [restored] = await tx.update(scenes).set({ archivedAt: null, sortOrder: (last?.sortOrder ?? -1) + 1, version: scene.version + 1 })
        .where(and(eq(scenes.id, sceneId), eq(scenes.version, input.expectedVersion))).returning();
      if (!restored) return { error: 'CONFLICT' } as const;
      await tx.insert(auditEvents).values({ campaignId: scene.campaignId, actorId: context.userId, action: 'scene.restored', targetId: sceneId });
      return { scene: restored } as const;
    });
    if ('error' in result) return reply.code(result.error === 'UNAUTHENTICATED' ? 401 : result.error === 'NOT_FOUND' ? 404 : result.error === 'CONFLICT' ? 409 : 403).send({ error: result.error });
    return { scene: result.scene };
  });
  app.put('/api/campaigns/:campaignId/scenes/reorder', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const { campaignId } = request.params as { campaignId: string };
    const input = parseBody(z.object({ scenes: z.array(z.object({ id: z.uuid(), expectedVersion: z.number().int().positive() })).min(1).max(100) }), request.body);
    if (new Set(input.scenes.map(({ id }) => id)).size !== input.scenes.length) return reply.code(400).send({ error: 'INVALID' });
    try {
      const result = await db.transaction(async (tx) => {
        const actor = await lockCampaignActor(tx, digest(cookie), campaignId, { strength: 'no key update' });
        if ('error' in actor) return actor;
        if (actor.role !== 'OWNER' && actor.role !== 'GM') return { error: 'FORBIDDEN' } as const;
        const current = await tx.select().from(scenes).where(and(eq(scenes.campaignId, campaignId), isNull(scenes.archivedAt))).orderBy(asc(scenes.id)).for('update');
        if (current.length !== input.scenes.length || input.scenes.some((item) => !current.some((scene) => scene.id === item.id && scene.version === item.expectedVersion))) return { error: 'CONFLICT' } as const;
        for (const [sortOrder, item] of input.scenes.entries()) {
          const [updated] = await tx.update(scenes).set({ sortOrder, version: item.expectedVersion + 1 }).where(and(eq(scenes.id, item.id), eq(scenes.version, item.expectedVersion))).returning({ id: scenes.id });
          if (!updated) throw new Error('Scene reorder lost its locked version');
        }
        await tx.insert(auditEvents).values({ campaignId, actorId: actor.userId, action: 'scenes.reordered' });
        return { ok: true } as const;
      });
      if ('error' in result) return reply.code(result.error === 'UNAUTHENTICATED' ? 401 : result.error === 'NOT_FOUND' ? 404 : result.error === 'CONFLICT' ? 409 : 403).send({ error: result.error });
    } catch (error) {
      throw error;
    }
    return db.select().from(scenes).where(and(eq(scenes.campaignId, campaignId), isNull(scenes.archivedAt))).orderBy(asc(scenes.sortOrder), asc(scenes.id));
  });
}

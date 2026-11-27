import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { createSceneLayerSchema, createSceneObjectSchema, duplicateSceneObjectsSchema, idSchema, updateSceneLayerSchema, updateSceneObjectSchema } from '@nri/contracts';
import { db } from '../../db/index.js';
import { assets, auditEvents, campaigns, sceneLayers, sceneObjects } from '../../db/schema.js';
import { canReadSceneLayer, canReadSceneTokens } from '../../domain/sceneAccess.js';
import type { FastifyInstance } from 'fastify';
import type { Server } from 'socket.io';
import { digest, parseBody } from '../../security/access.js';
import { sceneObjectProjection } from '../../domain/projections.js';
import { baseLayerKinds } from '../../domain/defaultLayers.js';
import { cookieName } from '../../config/runtime.js';
import { commandSessionIsActive, lockCommandSession } from '../../security/commandAccess.js';
import { lockObjectLayers, lockObjectScene, lockSceneObjects } from '../objects/access.js';
import { changeObjectLifecycle, clearOwnDrawings, deleteSceneObject } from '../objects/lifecycle.js';
import { publishObjectLifecycle } from '../../realtime/objectLifecycleEvents.js';
import { isPublicLayer, publishSceneLayer, publishSceneObjects } from '../../realtime/sceneContentEvents.js';

const lifecycleStatus = { INVALID: 400, UNAUTHENTICATED: 401, NOT_FOUND: 404, FORBIDDEN: 403, CONFLICT: 409, LAYER_LOCKED: 409, OBJECT_LOCKED: 409 };

async function readSceneContent(tokenHash: string, sceneId: string, resource: 'layers' | 'objects') {
  return db.transaction(async (tx) => {
    const session = await lockCommandSession(tx, tokenHash);
    if (!session) return { error: 'UNAUTHENTICATED' } as const;
    const context = await lockObjectScene(tx, sceneId, session.userId);
    if ('error' in context || !canReadSceneTokens(context.role, context.scene.isActive, false)) return { error: 'NOT_FOUND' } as const;
    const { role, scene } = context;
    if (!await commandSessionIsActive(tx, tokenHash)) return { error: 'UNAUTHENTICATED' } as const;
    if (resource === 'layers') {
      const rows = await tx.select().from(sceneLayers).where(eq(sceneLayers.sceneId, scene.id))
        .orderBy(asc(sceneLayers.sortOrder), asc(sceneLayers.id));
      return { rows: rows.filter((layer) => role !== 'PLAYER' || isPublicLayer(scene.isActive, layer)) };
    }
    const rows = await tx.select({ object: sceneObjects, layer: sceneLayers }).from(sceneObjects)
      .innerJoin(sceneLayers, and(eq(sceneObjects.layerId, sceneLayers.id), eq(sceneLayers.sceneId, scene.id)))
      .where(and(eq(sceneObjects.sceneId, scene.id), isNull(sceneObjects.deletedAt)))
      .orderBy(asc(sceneObjects.zIndex), asc(sceneObjects.id));
    return { rows: rows.filter(({ object, layer }) => role !== 'PLAYER' || (object.visible && isPublicLayer(scene.isActive, layer)))
      .map(({ object }) => sceneObjectProjection(object, role, session.userId)) };
  }, { isolationLevel: 'read committed' });
}

export function registerSceneContentRoutes(app: FastifyInstance, io: Server) {
  app.get('/api/scenes/:sceneId/layers', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const sceneId = parseBody(idSchema, (request.params as { sceneId: string }).sceneId);
    const result = await readSceneContent(digest(cookie), sceneId, 'layers');
    if ('error' in result && result.error) return reply.code(lifecycleStatus[result.error]).send({ error: result.error });
    return result.rows;
  });
  app.post('/api/scenes/:sceneId/layers', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const sceneId = parseBody(idSchema, (request.params as { sceneId: string }).sceneId);
    const input = parseBody(createSceneLayerSchema, request.body);
    const tokenHash = digest(cookie);
    const result = await db.transaction(async (tx) => {
      const session = await lockCommandSession(tx, tokenHash);
      if (!session) return { error: 'UNAUTHENTICATED' } as const;
      const context = await lockObjectScene(tx, sceneId, session.userId);
      if ('error' in context) return context;
      const { scene, role } = context;
      if (role === 'PLAYER') return { error: 'FORBIDDEN' } as const;
      if (!await commandSessionIsActive(tx, tokenHash)) return { error: 'UNAUTHENTICATED' } as const;
      const [layer] = await tx.insert(sceneLayers).values({ ...input, sceneId: scene.id }).returning();
      if (!layer) throw new Error('Layer creation failed');
      await tx.insert(auditEvents).values({ campaignId: scene.campaignId, actorId: session.userId, action: 'scene.layer_created', targetId: layer.id });
      return { scene, layer };
    }, { isolationLevel: 'read committed' });
    if ('error' in result) return reply.code(lifecycleStatus[result.error]).send({ error: result.error });
    void publishSceneLayer(io, result.scene, 'create', result.layer).catch(() => request.log.error('Committed layer creation could not be published'));
    return reply.code(201).send({ layer: result.layer });
  });
  app.patch('/api/layers/:layerId', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const tokenHash = digest(cookie);
    const layerId = parseBody(idSchema, (request.params as { layerId: string }).layerId);
    const { expectedVersion, ...patch } = parseBody(updateSceneLayerSchema, request.body);
    const result = await db.transaction(async (tx) => {
      const session = await lockCommandSession(tx, tokenHash);
      if (!session) return { error: 'UNAUTHENTICATED' } as const;
      const [location] = await tx.select({ sceneId: sceneLayers.sceneId }).from(sceneLayers).where(eq(sceneLayers.id, layerId)).limit(1);
      if (!location) return { error: 'NOT_FOUND' } as const;
      const context = await lockObjectScene(tx, location.sceneId, session.userId);
      if ('error' in context) return context;
      const { scene, role } = context;
      if (role === 'PLAYER') return { error: 'FORBIDDEN' } as const;
      const [layer] = await tx.select().from(sceneLayers)
        .where(and(eq(sceneLayers.id, layerId), eq(sceneLayers.sceneId, scene.id))).for('no key update').limit(1);
      if (!layer) return { error: 'NOT_FOUND' } as const;
      if (!await commandSessionIsActive(tx, tokenHash)) return { error: 'UNAUTHENTICATED' } as const;
      if (layer.kind === 'BACKGROUND' && patch.locked === false) return { error: 'BACKGROUND_LAYER_LOCKED' } as const;
      if (layer.kind === 'GM' && patch.visibleToPlayers === true) return { error: 'GM_LAYER_PRIVATE' } as const;
      if (layer.version !== expectedVersion) return { error: 'CONFLICT' } as const;
      const [updated] = await tx.update(sceneLayers).set({ ...patch, version: expectedVersion + 1 })
        .where(and(eq(sceneLayers.id, layerId), eq(sceneLayers.version, expectedVersion))).returning();
      if (!updated) throw new Error('Locked scene layer changed before edit');
      await tx.insert(auditEvents).values({ campaignId: scene.campaignId, actorId: session.userId, action: 'scene.layer_updated', targetId: layerId });
      return { layer, scene, updated };
    }, { isolationLevel: 'read committed' });
    if ('error' in result) {
      const status = result.error === 'BACKGROUND_LAYER_LOCKED' || result.error === 'GM_LAYER_PRIVATE' ? 400 : lifecycleStatus[result.error];
      return reply.code(status).send({ error: result.error });
    }
    const { updated, layer, scene } = result;
    void publishSceneLayer(io, scene, 'update', { ...updated, wasPublic: isPublicLayer(scene.isActive, layer) })
      .catch(() => request.log.error('Committed layer update could not be published'));
    return { layer: updated };
  });
  app.delete('/api/layers/:layerId', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const tokenHash = digest(cookie);
    const layerId = parseBody(idSchema, (request.params as { layerId: string }).layerId);
    const input = parseBody(z.object({ expectedVersion: z.number().int().positive() }), request.body);
    const result = await db.transaction(async (tx) => {
      const session = await lockCommandSession(tx, tokenHash);
      if (!session) return { error: 'UNAUTHENTICATED' } as const;
      const [location] = await tx.select({ sceneId: sceneLayers.sceneId }).from(sceneLayers).where(eq(sceneLayers.id, layerId)).limit(1);
      if (!location) return { error: 'NOT_FOUND' } as const;
      const context = await lockObjectScene(tx, location.sceneId, session.userId);
      if ('error' in context) return context;
      const { scene, role } = context;
      if (role === 'PLAYER') return { error: 'FORBIDDEN' } as const;
      const [layer] = await tx.select().from(sceneLayers)
        .where(and(eq(sceneLayers.id, layerId), eq(sceneLayers.sceneId, scene.id))).for('update').limit(1);
      if (!layer) return { error: 'NOT_FOUND' } as const;
      if (!await commandSessionIsActive(tx, tokenHash)) return { error: 'UNAUTHENTICATED' } as const;
      if (baseLayerKinds.includes(layer.kind as typeof baseLayerKinds[number])) return { error: 'BASE_LAYER_REQUIRED' } as const;
      if (layer.version !== input.expectedVersion) return { error: 'CONFLICT' } as const;
      const [object] = await tx.select({ id: sceneObjects.id }).from(sceneObjects)
        .where(and(eq(sceneObjects.layerId, layerId), isNull(sceneObjects.deletedAt))).limit(1);
      if (object) return { error: 'LAYER_NOT_EMPTY' } as const;
      await tx.delete(sceneObjects).where(and(eq(sceneObjects.layerId, layerId), isNotNull(sceneObjects.deletedAt)));
      await tx.delete(sceneLayers).where(eq(sceneLayers.id, layerId));
      await tx.insert(auditEvents).values({ campaignId: scene.campaignId, actorId: session.userId, action: 'scene.layer_deleted', targetId: layerId });
      return { layer, scene };
    }, { isolationLevel: 'read committed' });
    if ('error' in result) {
      const status = result.error === 'BASE_LAYER_REQUIRED' || result.error === 'LAYER_NOT_EMPTY' ? 409 : lifecycleStatus[result.error];
      return reply.code(status).send({ error: result.error });
    }
    const { layer, scene } = result;
    void publishSceneLayer(io, scene, 'delete', { ...layer, wasPublic: isPublicLayer(scene.isActive, layer) })
      .catch(() => request.log.error('Committed layer deletion could not be published'));
    return reply.code(204).send();
  });
  app.get('/api/scenes/:sceneId/objects', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const sceneId = parseBody(idSchema, (request.params as { sceneId: string }).sceneId);
    const result = await readSceneContent(digest(cookie), sceneId, 'objects');
    if ('error' in result && result.error) return reply.code(lifecycleStatus[result.error]).send({ error: result.error });
    return result.rows;
  });
  app.delete('/api/scenes/:sceneId/my-drawings', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const { sceneId } = request.params as { sceneId: string };
    const result = await clearOwnDrawings(digest(cookie), sceneId);
    if ('error' in result) return reply.code(lifecycleStatus[result.error]).send({ error: result.error });
    void publishObjectLifecycle(io, result.publication).catch(() => request.log.error('Committed drawing cleanup could not be published'));
    return { deletedCount: result.objects.length };
  });
  app.post('/api/scenes/:sceneId/objects', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const sceneId = parseBody(idSchema, (request.params as { sceneId: string }).sceneId);
    const input = parseBody(createSceneObjectSchema, request.body);
    const tokenHash = digest(cookie);
    const result = await db.transaction(async (tx) => {
      const session = await lockCommandSession(tx, tokenHash);
      if (!session) return { error: 'UNAUTHENTICATED' } as const;
      const context = await lockObjectScene(tx, sceneId, session.userId);
      if ('error' in context) return context;
      const { scene, role } = context;
      if (role === 'PLAYER') {
        const [campaign] = await tx.select({ playersCanDraw: campaigns.playersCanDraw }).from(campaigns).where(eq(campaigns.id, scene.campaignId)).limit(1);
        if (!campaign?.playersCanDraw || !scene.isActive) return { error: 'FORBIDDEN' } as const;
      }
      const layer = (await lockObjectLayers(tx, scene.id, [input.layerId])).get(input.layerId.toLowerCase());
      if (!layer) return { error: 'INVALID_LAYER' } as const;
      if (layer.locked) return { error: 'LAYER_LOCKED' } as const;
      if (role === 'PLAYER' && (input.kind !== 'FREEHAND' || layer.kind !== 'OBJECTS' || !isPublicLayer(scene.isActive, layer) ||
        !input.points || input.points.length < 2 || input.points.length > 2000)) return { error: 'FORBIDDEN' } as const;
      if (role === 'PLAYER') Object.assign(input, { visible: true, locked: false, opacity: 1, rotation: 0, assetId: null, text: null });
      if (layer.kind === 'GM') input.visible = false;
      if (input.assetId) {
        const [asset] = await tx.select({ id: assets.id }).from(assets)
          .where(and(eq(assets.id, input.assetId), eq(assets.campaignId, scene.campaignId))).limit(1);
        if (!asset) return { error: 'INVALID_ASSET' } as const;
      }
      if (!await commandSessionIsActive(tx, tokenHash)) return { error: 'UNAUTHENTICATED' } as const;
      const [object] = await tx.insert(sceneObjects).values({ ...input, sceneId: scene.id, createdBy: session.userId }).returning();
      if (!object) throw new Error('Scene object creation failed');
      await tx.insert(auditEvents).values({ campaignId: scene.campaignId, actorId: session.userId, action: 'scene.object_created', targetId: object.id });
      return { scene, object, role, userId: session.userId };
    }, { isolationLevel: 'read committed' });
    if ('error' in result) {
      const status = result.error === 'INVALID_LAYER' || result.error === 'INVALID_ASSET' ? 400 : lifecycleStatus[result.error];
      return reply.code(status).send({ error: result.error });
    }
    void publishSceneObjects(io, result.scene, 'scene:object_created', [result.object])
      .catch(() => request.log.error('Committed object creation could not be published'));
    return reply.code(201).send({ object: sceneObjectProjection(result.object, result.role, result.userId) });
  });
  app.post('/api/scenes/:sceneId/objects/duplicate', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const sceneId = parseBody(idSchema, (request.params as { sceneId: string }).sceneId);
    const input = parseBody(duplicateSceneObjectsSchema, request.body);
    const tokenHash = digest(cookie);
    const targets = input.objects.map((target) => ({ ...target, objectId: target.objectId.toLowerCase() }));
    if (new Set(targets.map(({ objectId }) => objectId)).size !== targets.length) return reply.code(400).send({ error: 'INVALID' });
    const ids = targets.map(({ objectId }) => objectId);
    const result = await db.transaction(async (tx) => {
      const session = await lockCommandSession(tx, tokenHash);
      if (!session) return { error: 'UNAUTHENTICATED' } as const;
      const context = await lockObjectScene(tx, sceneId, session.userId);
      if ('error' in context) return context;
      const { scene, role } = context;
      if (role === 'PLAYER') return { error: 'FORBIDDEN' } as const;
      const locations = await tx.select({ layerId: sceneObjects.layerId }).from(sceneObjects)
        .where(and(eq(sceneObjects.sceneId, scene.id), isNull(sceneObjects.deletedAt), inArray(sceneObjects.id, ids)));
      const layers = await lockObjectLayers(tx, scene.id, [input.layerId, ...locations.map(({ layerId }) => layerId)]);
      const layer = layers.get(input.layerId.toLowerCase());
      if (!layer || layer.kind === 'BACKGROUND') return { error: 'INVALID_LAYER' } as const;
      if (layer.locked) return { error: 'LAYER_LOCKED' } as const;
      const sourceRows = (await lockSceneObjects(tx, scene.id, ids, 'share')).filter((object) => !object.deletedAt);
      if (sourceRows.length !== targets.length) return { error: 'NOT_FOUND' } as const;
      const sources = new Map(sourceRows.map((object) => [object.id, object]));
      if (targets.some((item) => sources.get(item.objectId)?.version !== item.expectedVersion) ||
          sourceRows.some((object) => !layers.has(object.layerId))) return { error: 'CONFLICT' } as const;
      if (!await commandSessionIsActive(tx, tokenHash)) return { error: 'UNAUTHENTICATED' } as const;
      const duplicateRows = targets.map((item) => {
        const source = sources.get(item.objectId)!;
        const { id: _sourceId, version: _sourceVersion, ...copy } = source;
        return { ...copy, id: randomUUID(), layerId: layer.id, x: item.x, y: item.y, visible: layer.kind !== 'GM' && source.visible && isPublicLayer(true, layers.get(source.layerId)!), locked: false, version: 1 };
      });
      const created = await tx.insert(sceneObjects).values(duplicateRows).returning();
      const createdById = new Map(created.map((object) => [object.id, object]));
      const objects = duplicateRows.map((object) => createdById.get(object.id)!);
      await tx.insert(auditEvents).values(objects.map((object, index) => ({ campaignId: scene.campaignId, actorId: session.userId, action: 'scene.object_duplicated', targetId: object.id, detail: `source:${targets[index]!.objectId}` })));
      return { objects, scene };
    }, { isolationLevel: 'read committed' });
    if ('error' in result) {
      const status = result.error === 'INVALID_LAYER' ? 400 : lifecycleStatus[result.error];
      return reply.code(status).send({ error: result.error });
    }
    void publishSceneObjects(io, result.scene, 'scene:object_created', result.objects)
      .catch(() => request.log.error('Committed object copy could not be published'));
    return reply.code(201).send({ objects: result.objects.map((object) => sceneObjectProjection(object, 'OWNER')) });
  });
  app.patch('/api/scenes/:sceneId/object-lifecycle', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const { sceneId } = request.params as { sceneId: string };
    const result = await changeObjectLifecycle(digest(cookie), sceneId, request.body);
    if ('error' in result) return reply.code(lifecycleStatus[result.error]).send({ error: result.error });
    void publishObjectLifecycle(io, result.publication).catch(() => request.log.error('Committed object lifecycle change could not be published'));
    return { objects: result.objects };
  });
  app.patch('/api/objects/:objectId', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const tokenHash = digest(cookie);
    const objectId = parseBody(idSchema, (request.params as { objectId: string }).objectId);
    const { expectedVersion, ...patch } = parseBody(updateSceneObjectSchema, request.body);
    const requestedFields = Object.keys(request.body as Record<string, unknown>).filter((field) => field !== 'expectedVersion');
    const result = await db.transaction(async (tx) => {
      const session = await lockCommandSession(tx, tokenHash);
      if (!session) return { error: 'UNAUTHENTICATED' } as const;
      const [location] = await tx.select({ sceneId: sceneObjects.sceneId, layerId: sceneObjects.layerId }).from(sceneObjects)
        .where(and(eq(sceneObjects.id, objectId), isNull(sceneObjects.deletedAt))).limit(1);
      if (!location) return { error: 'NOT_FOUND' } as const;
      const context = await lockObjectScene(tx, location.sceneId, session.userId);
      if ('error' in context) return context;
      const { role, scene } = context;
      const layers = await lockObjectLayers(tx, scene.id, patch.layerId ? [location.layerId, patch.layerId.toLowerCase()] : [location.layerId]);
      const [object] = await lockSceneObjects(tx, scene.id, [objectId]);
      if (!object || object.deletedAt) return { error: 'NOT_FOUND' } as const;
      if (!await commandSessionIsActive(tx, tokenHash)) return { error: 'UNAUTHENTICATED' } as const;
      const layer = layers.get(object.layerId);
      if (role === 'PLAYER') {
        if (!layer || !object.visible || !canReadSceneLayer(role, scene.isActive, false, layer.visibleToPlayers, layer.kind)) return { error: 'FORBIDDEN' } as const;
        const [campaign] = await tx.select({ playersCanDraw: campaigns.playersCanDraw }).from(campaigns).where(eq(campaigns.id, scene.campaignId)).limit(1);
        if (!campaign?.playersCanDraw || object.createdBy !== session.userId || object.kind !== 'FREEHAND' || layer.kind !== 'OBJECTS' ||
            requestedFields.some((field) => !['x', 'y', 'width', 'height', 'color', 'strokeWidth', 'points'].includes(field))) return { error: 'FORBIDDEN' } as const;
      }
      if (object.layerId !== location.layerId || object.version !== expectedVersion) return { error: 'CONFLICT' } as const;
      if (!layer) return { error: 'NOT_FOUND' } as const;
      if (layer.locked) return { error: 'LAYER_LOCKED' } as const;
      if (object.locked && !(patch.locked === false && requestedFields.length === 1 && requestedFields[0] === 'locked')) return { error: 'OBJECT_LOCKED' } as const;
      const target = patch.layerId ? layers.get(patch.layerId.toLowerCase()) : layer;
      if (!target) return { error: 'INVALID_LAYER' } as const;
      if (target.locked) return { error: 'LAYER_LOCKED' } as const;
      if (patch.assetId) {
        const [asset] = await tx.select({ id: assets.id }).from(assets)
          .where(and(eq(assets.id, patch.assetId), eq(assets.campaignId, scene.campaignId))).limit(1);
        if (!asset) return { error: 'INVALID_ASSET' } as const;
      }
      const [updated] = await tx.update(sceneObjects).set({ ...patch, ...(target.kind === 'GM' ? { visible: false } : {}), version: expectedVersion + 1 })
        .where(and(eq(sceneObjects.id, objectId), eq(sceneObjects.version, expectedVersion), isNull(sceneObjects.deletedAt))).returning();
      if (!updated) throw new Error('Locked scene object changed before edit');
      await tx.insert(auditEvents).values({ campaignId: scene.campaignId, actorId: session.userId, action: 'scene.object_updated', targetId: objectId });
      const lostPublicVisibility = object.visible && isPublicLayer(scene.isActive, layer) &&
        !(updated.visible && isPublicLayer(scene.isActive, target));
      return { updated, lostPublicVisibility, scene, role, userId: session.userId };
    }, { isolationLevel: 'read committed' });
    if ('error' in result) {
      const status = result.error === 'INVALID_LAYER' || result.error === 'INVALID_ASSET' ? 400 : lifecycleStatus[result.error];
      return reply.code(status).send({ error: result.error });
    }
    const { updated, lostPublicVisibility, scene, role, userId } = result;
    void publishSceneObjects(io, scene, 'scene:object_updated', [{ ...updated, wasPublic: lostPublicVisibility }])
      .catch(() => request.log.error('Committed object update could not be published'));
    return { object: sceneObjectProjection(updated, role, userId) };
  });
  app.delete('/api/objects/:objectId', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const { objectId } = request.params as { objectId: string };
    const result = await deleteSceneObject(digest(cookie), objectId, request.body);
    if ('error' in result) return reply.code(lifecycleStatus[result.error]).send({ error: result.error });
    void publishObjectLifecycle(io, result.publication).catch(() => request.log.error('Committed object deletion could not be published'));
    return reply.code(204).send();
  });
}

import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { createSceneLayerSchema, createSceneObjectSchema, duplicateSceneObjectsSchema, idSchema, updateSceneLayerSchema, updateSceneObjectSchema } from '@nri/contracts';
import { db } from '../../db/index.js';
import { assets, auditEvents, campaigns, sceneLayers, sceneObjects, scenes } from '../../db/schema.js';
import { canReadSceneLayer, canReadSceneTokens } from '../../domain/sceneAccess.js';
import type { FastifyInstance } from 'fastify';
import type { Server } from 'socket.io';
import { digest, parseBody, requireUser, roleFor } from '../../security/access.js';
import { sceneObjectProjection } from '../../domain/projections.js';
import { baseLayerKinds } from '../../domain/defaultLayers.js';
import { cookieName } from '../../config/runtime.js';
import { commandSessionIsActive, lockCommandSession } from '../../security/commandAccess.js';
import { lockObjectLayers, lockObjectScene, lockSceneObjects } from '../objects/access.js';
import { changeObjectLifecycle, clearOwnDrawings, deleteSceneObject } from '../objects/lifecycle.js';
import { publishObjectLifecycle } from '../../realtime/objectLifecycleEvents.js';

const lifecycleStatus = { INVALID: 400, UNAUTHENTICATED: 401, NOT_FOUND: 404, FORBIDDEN: 403, CONFLICT: 409, LAYER_LOCKED: 409, OBJECT_LOCKED: 409 };

export function registerSceneContentRoutes(app: FastifyInstance, io: Server) {
  app.get('/api/scenes/:sceneId/layers', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { sceneId } = request.params as { sceneId: string };
    const [scene] = await db.select().from(scenes).where(eq(scenes.id, sceneId)).limit(1);
    if (!scene) return reply.code(404).send({ error: 'NOT_FOUND' });
    const role = await roleFor(scene.campaignId, user.id);
    if (!role || !canReadSceneTokens(role, scene.isActive, scene.archivedAt !== null)) return reply.code(404).send({ error: 'NOT_FOUND' });
    const rows = await db.select().from(sceneLayers).where(eq(sceneLayers.sceneId, sceneId)).orderBy(asc(sceneLayers.sortOrder), asc(sceneLayers.id));
    return rows.filter((layer) => canReadSceneLayer(role, scene.isActive, false, layer.visibleToPlayers, layer.kind));
  });
  app.post('/api/scenes/:sceneId/layers', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { sceneId } = request.params as { sceneId: string };
    const input = parseBody(createSceneLayerSchema, request.body);
    const [scene] = await db.select().from(scenes).where(eq(scenes.id, sceneId)).limit(1);
    if (!scene) return reply.code(404).send({ error: 'NOT_FOUND' });
    const role = await roleFor(scene.campaignId, user.id);
    if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
    if (scene.archivedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
    const [layer] = await db.insert(sceneLayers).values({ ...input, sceneId }).returning();
    if (!layer) throw new Error('Layer creation failed');
    await db.insert(auditEvents).values({ campaignId: scene.campaignId, actorId: user.id, action: 'scene.layer_created', targetId: layer.id });
    const room = `campaign:${scene.campaignId}`;
    ((layer.visibleToPlayers && scene.isActive) ? io.to(room) : io.to(`${room}:gm`)).emit('scene:layer_created', { sceneId, layer });
    return reply.code(201).send({ layer });
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
    const { updated, ...row } = result;
    const room = `campaign:${row.scene.campaignId}`;
    let publicProjection = false;
    if (row.scene.isActive && row.layer.visibleToPlayers) {
      if (updated.visibleToPlayers) io.to(room).emit('scene:layer_updated', { sceneId: row.scene.id, layer: updated });
      else io.to(room).emit('scene:layer_hidden', { sceneId: row.scene.id, layerId: updated.id });
      publicProjection = true;
    }
    if (row.scene.isActive && updated.visibleToPlayers && !row.layer.visibleToPlayers) { io.to(room).emit('scene:layer_updated', { sceneId: row.scene.id, layer: updated }); publicProjection = true; }
    if (!publicProjection) io.to(`${room}:gm`).emit('scene:layer_updated', { sceneId: row.scene.id, layer: updated });
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
      return { layer, scene };
    }, { isolationLevel: 'read committed' });
    if ('error' in result) {
      const status = result.error === 'BASE_LAYER_REQUIRED' || result.error === 'LAYER_NOT_EMPTY' ? 409 : lifecycleStatus[result.error];
      return reply.code(status).send({ error: result.error });
    }
    const row = result;
    const room = `campaign:${row.scene.campaignId}`;
    if (row.scene.isActive && row.layer.visibleToPlayers) io.to(room).emit('scene:layer_deleted', { sceneId: row.scene.id, layerId });
    else io.to(`${room}:gm`).emit('scene:layer_deleted', { sceneId: row.scene.id, layerId });
    return reply.code(204).send();
  });
  app.get('/api/scenes/:sceneId/objects', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { sceneId } = request.params as { sceneId: string };
    const [scene] = await db.select().from(scenes).where(eq(scenes.id, sceneId)).limit(1);
    if (!scene) return reply.code(404).send({ error: 'NOT_FOUND' });
    const role = await roleFor(scene.campaignId, user.id);
    if (!role || !canReadSceneTokens(role, scene.isActive, scene.archivedAt !== null)) return reply.code(404).send({ error: 'NOT_FOUND' });
    const rows = await db.select({ object: sceneObjects, layer: sceneLayers }).from(sceneObjects).innerJoin(sceneLayers, eq(sceneObjects.layerId, sceneLayers.id)).where(and(eq(sceneObjects.sceneId, sceneId), isNull(sceneObjects.deletedAt))).orderBy(asc(sceneObjects.zIndex), asc(sceneObjects.id));
    return rows.filter(({ object, layer }) => role !== 'PLAYER' || (object.visible && canReadSceneLayer(role, scene.isActive, false, layer.visibleToPlayers, layer.kind))).map(({ object }) => sceneObjectProjection(object, role, user.id));
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
    const user = await requireUser(request, reply); if (!user) return;
    const { sceneId } = request.params as { sceneId: string };
    const input = parseBody(createSceneObjectSchema, request.body);
    const [scene] = await db.select().from(scenes).where(eq(scenes.id, sceneId)).limit(1);
    if (!scene) return reply.code(404).send({ error: 'NOT_FOUND' });
    const role = await roleFor(scene.campaignId, user.id);
    if (!role) return reply.code(403).send({ error: 'FORBIDDEN' });
    const canManage = role === 'OWNER' || role === 'GM';
    const [campaign] = await db.select({ playersCanDraw: campaigns.playersCanDraw }).from(campaigns).where(eq(campaigns.id, scene.campaignId)).limit(1);
    const playerDrawingAllowed = role === 'PLAYER' && campaign?.playersCanDraw === true && scene.isActive;
    if (!canManage && !playerDrawingAllowed) return reply.code(403).send({ error: 'FORBIDDEN' });
    if (scene.archivedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
    const [layer] = await db.select().from(sceneLayers).where(and(eq(sceneLayers.id, input.layerId), eq(sceneLayers.sceneId, sceneId))).limit(1);
    if (!layer) return reply.code(400).send({ error: 'INVALID_LAYER' });
    if (layer.locked) return reply.code(409).send({ error: 'LAYER_LOCKED' });
    if (!canManage && (input.kind !== 'FREEHAND' || layer.kind !== 'OBJECTS' || !layer.visibleToPlayers || !input.points || input.points.length < 2 || input.points.length > 2000)) return reply.code(403).send({ error: 'FORBIDDEN' });
    if (layer.kind === 'GM') input.visible = false;
    if (!canManage) { input.visible = true; input.locked = false; input.opacity = 1; input.rotation = 0; input.assetId = null; input.text = null; }
    if (input.assetId) {
      const [asset] = await db.select({ id: assets.id }).from(assets).where(and(eq(assets.id, input.assetId), eq(assets.campaignId, scene.campaignId))).limit(1);
      if (!asset) return reply.code(400).send({ error: 'INVALID_ASSET' });
    }
    const [object] = await db.insert(sceneObjects).values({ ...input, sceneId, createdBy: user.id }).returning();
    if (!object) throw new Error('Scene object creation failed');
    await db.insert(auditEvents).values({ campaignId: scene.campaignId, actorId: user.id, action: 'scene.object_created', targetId: object.id });
    const room = `campaign:${scene.campaignId}`;
    const playerVisible = scene.isActive && layer.visibleToPlayers && object.visible && layer.kind !== 'GM';
    (playerVisible ? io.to(room) : io.to(`${room}:gm`)).emit('scene:object_created', { object: sceneObjectProjection(object, playerVisible ? 'PLAYER' : 'OWNER') });
    return reply.code(201).send({ object: sceneObjectProjection(object, role, user.id) });
  });
  app.post('/api/scenes/:sceneId/objects/duplicate', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { sceneId } = request.params as { sceneId: string };
    const input = parseBody(duplicateSceneObjectsSchema, request.body);
    const result = await db.transaction(async (tx) => {
      const context = await lockObjectScene(tx, sceneId, user.id);
      if ('error' in context) return context;
      const { scene, role } = context;
      if (role === 'PLAYER') return { error: 'FORBIDDEN' as const };
      const layer = (await lockObjectLayers(tx, scene.id, [input.layerId])).get(input.layerId.toLowerCase());
      if (!layer) return { error: 'INVALID_LAYER' as const };
      if (layer.locked) return { error: 'LAYER_LOCKED' as const };
      if (layer.kind === 'BACKGROUND') return { error: 'INVALID_LAYER' as const };
      const sourceRows = await tx.select().from(sceneObjects)
        .where(and(eq(sceneObjects.sceneId, sceneId), isNull(sceneObjects.deletedAt), inArray(sceneObjects.id, input.objects.map((item) => item.objectId))))
        .orderBy(asc(sceneObjects.id)).for('share');
      if (sourceRows.length !== input.objects.length) return { error: 'NOT_FOUND' as const };
      const sources = new Map(sourceRows.map((object) => [object.id, object]));
      if (input.objects.some((item) => sources.get(item.objectId)?.version !== item.expectedVersion)) return { error: 'CONFLICT' as const };
      const duplicateRows = input.objects.map((item) => {
        const source = sources.get(item.objectId)!;
        const { id: _sourceId, version: _sourceVersion, ...copy } = source;
        return { ...copy, id: randomUUID(), layerId: layer.id, x: item.x, y: item.y, visible: layer.kind === 'GM' ? false : source.visible, locked: false, version: 1 };
      });
      const created = await tx.insert(sceneObjects).values(duplicateRows).returning();
      const createdById = new Map(created.map((object) => [object.id, object]));
      const objects = duplicateRows.map((object) => createdById.get(object.id)!);
      await tx.insert(auditEvents).values(objects.map((object, index) => ({ campaignId: scene.campaignId, actorId: user.id, action: 'scene.object_duplicated', targetId: object.id, detail: `source:${input.objects[index]!.objectId}` })));
      return { objects, campaignId: scene.campaignId, isActive: scene.isActive, layerVisible: layer.visibleToPlayers, layerKind: layer.kind };
    });
    if ('error' in result) {
      const status = result.error === 'FORBIDDEN' ? 403 : result.error === 'CONFLICT' || result.error === 'LAYER_LOCKED' ? 409 : result.error === 'INVALID_LAYER' ? 400 : 404;
      return reply.code(status).send({ error: result.error });
    }
    const room = `campaign:${result.campaignId}`;
    for (const object of result.objects) {
      if (result.isActive && result.layerVisible && result.layerKind !== 'GM' && object.visible) io.to(room).emit('scene:object_created', { object: sceneObjectProjection(object, 'PLAYER') });
      else io.to(`${room}:gm`).emit('scene:object_created', { object });
    }
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
      return { updated, object, layer, target, scene, role, userId: session.userId };
    }, { isolationLevel: 'read committed' });
    if ('error' in result) {
      const status = result.error === 'INVALID_LAYER' || result.error === 'INVALID_ASSET' ? 400 : lifecycleStatus[result.error];
      return reply.code(status).send({ error: result.error });
    }
    const { updated, object, layer, target, scene, role, userId } = result;
    const room = `campaign:${scene.campaignId}`;
    const wasPublic = scene.isActive && layer.visibleToPlayers && layer.kind !== 'GM' && object.visible;
    const isPublic = scene.isActive && target.visibleToPlayers && target.kind !== 'GM' && updated.visible;
    if (wasPublic && !isPublic) io.to(room).emit('scene:object_deleted', { sceneId: scene.id, objectId });
    if (isPublic) io.to(room).emit('scene:object_updated', { object: sceneObjectProjection(updated, 'PLAYER') });
    else io.to(`${room}:gm`).emit('scene:object_updated', { object: sceneObjectProjection(updated, 'OWNER') });
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

import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { createSceneLayerSchema, createSceneObjectSchema, duplicateSceneObjectsSchema, updateSceneLayerSchema, updateSceneObjectSchema } from '@nri/contracts';
import { db } from '../../db/index.js';
import { assets, auditEvents, campaigns, memberships, sceneLayers, sceneObjects, scenes } from '../../db/schema.js';
import { canReadSceneLayer, canReadSceneTokens } from '../../domain/sceneAccess.js';
import type { FastifyInstance } from 'fastify';
import type { Server } from 'socket.io';
import { parseBody, requireUser, roleFor } from '../../security/access.js';
import { sceneObjectProjection } from '../../domain/projections.js';
import { baseLayerKinds } from '../../domain/defaultLayers.js';

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
    const user = await requireUser(request, reply); if (!user) return;
    const { layerId } = request.params as { layerId: string };
    const input = parseBody(updateSceneLayerSchema, request.body);
    const [row] = await db.select({ layer: sceneLayers, scene: scenes }).from(sceneLayers).innerJoin(scenes, eq(sceneLayers.sceneId, scenes.id)).where(eq(sceneLayers.id, layerId)).limit(1);
    if (!row) return reply.code(404).send({ error: 'NOT_FOUND' });
    const role = await roleFor(row.scene.campaignId, user.id);
    if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
    if (row.scene.archivedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (row.layer.kind === 'BACKGROUND' && input.locked === false) return reply.code(400).send({ error: 'BACKGROUND_LAYER_LOCKED' });
    const { expectedVersion, ...patch } = input;
    if (row.layer.kind === 'GM' && patch.visibleToPlayers === true) return reply.code(400).send({ error: 'GM_LAYER_PRIVATE' });
    const [updated] = await db.update(sceneLayers).set({ ...patch, version: row.layer.version + 1 }).where(and(eq(sceneLayers.id, layerId), eq(sceneLayers.version, expectedVersion))).returning();
    if (!updated) return reply.code(409).send({ error: 'CONFLICT' });
    await db.insert(auditEvents).values({ campaignId: row.scene.campaignId, actorId: user.id, action: 'scene.layer_updated', targetId: layerId });
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
    const user = await requireUser(request, reply); if (!user) return;
    const { layerId } = request.params as { layerId: string };
    const input = parseBody(z.object({ expectedVersion: z.number().int().positive() }), request.body);
    const [row] = await db.select({ layer: sceneLayers, scene: scenes }).from(sceneLayers).innerJoin(scenes, eq(sceneLayers.sceneId, scenes.id)).where(eq(sceneLayers.id, layerId)).limit(1);
    if (!row) return reply.code(404).send({ error: 'NOT_FOUND' });
    const role = await roleFor(row.scene.campaignId, user.id);
    if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
    if (row.scene.archivedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (baseLayerKinds.includes(row.layer.kind as typeof baseLayerKinds[number])) return reply.code(409).send({ error: 'BASE_LAYER_REQUIRED' });
    const [object] = await db.select({ id: sceneObjects.id }).from(sceneObjects).where(eq(sceneObjects.layerId, layerId)).limit(1);
    if (object) return reply.code(409).send({ error: 'LAYER_NOT_EMPTY' });
    const [deleted] = await db.delete(sceneLayers).where(and(eq(sceneLayers.id, layerId), eq(sceneLayers.version, input.expectedVersion))).returning({ id: sceneLayers.id });
    if (!deleted) return reply.code(409).send({ error: 'CONFLICT' });
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
    const rows = await db.select({ object: sceneObjects, layer: sceneLayers }).from(sceneObjects).innerJoin(sceneLayers, eq(sceneObjects.layerId, sceneLayers.id)).where(eq(sceneObjects.sceneId, sceneId)).orderBy(asc(sceneObjects.zIndex), asc(sceneObjects.id));
    return rows.filter(({ object, layer }) => role !== 'PLAYER' || (object.visible && canReadSceneLayer(role, scene.isActive, false, layer.visibleToPlayers, layer.kind))).map(({ object }) => sceneObjectProjection(object, role, user.id));
  });
  app.delete('/api/scenes/:sceneId/my-drawings', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { sceneId } = request.params as { sceneId: string };
    const [scene] = await db.select().from(scenes).where(eq(scenes.id, sceneId)).limit(1);
    if (!scene || scene.archivedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
    const role = await roleFor(scene.campaignId, user.id);
    if (!role) return reply.code(403).send({ error: 'FORBIDDEN' });
    if (role === 'PLAYER' && !scene.isActive) return reply.code(404).send({ error: 'NOT_FOUND' });
    const removed = await db.transaction(async (tx) => {
      const owned = await tx.select().from(sceneObjects).where(and(eq(sceneObjects.sceneId, sceneId), eq(sceneObjects.createdBy, user.id), eq(sceneObjects.kind, 'FREEHAND'))).for('update');
      if (owned.length === 0) return [];
      const layerRows = await tx.select().from(sceneLayers).where(inArray(sceneLayers.id, owned.map((object) => object.layerId)));
      const layerById = new Map(layerRows.map((layer) => [layer.id, layer]));
      const deleted = await tx.delete(sceneObjects).where(and(eq(sceneObjects.sceneId, sceneId), inArray(sceneObjects.id, owned.map((object) => object.id)), eq(sceneObjects.createdBy, user.id))).returning({ id: sceneObjects.id, layerId: sceneObjects.layerId, visible: sceneObjects.visible });
      if (deleted.length) await tx.insert(auditEvents).values({ campaignId: scene.campaignId, actorId: user.id, action: 'scene.own_drawings_cleared', targetId: sceneId, detail: String(deleted.length) });
      return deleted.map((object) => ({ ...object, layer: layerById.get(object.layerId) }));
    });
    const room = `campaign:${scene.campaignId}`;
    for (const object of removed) {
      if (scene.isActive && object.visible && object.layer?.visibleToPlayers && object.layer.kind !== 'GM') io.to(room).emit('scene:object_deleted', { sceneId, objectId: object.id });
      else io.to(`${room}:gm`).emit('scene:object_deleted', { sceneId, objectId: object.id });
    }
    return { deletedCount: removed.length };
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
      const [scene] = await tx.select().from(scenes).where(eq(scenes.id, sceneId)).for('update').limit(1);
      if (!scene || scene.archivedAt) return { error: 'NOT_FOUND' as const };
      const [membership] = await tx.select({ role: memberships.role }).from(memberships)
        .where(and(eq(memberships.campaignId, scene.campaignId), eq(memberships.userId, user.id))).limit(1);
      if (!membership || !['OWNER', 'GM'].includes(membership.role)) return { error: 'FORBIDDEN' as const };
      const [layer] = await tx.select().from(sceneLayers).where(and(eq(sceneLayers.id, input.layerId), eq(sceneLayers.sceneId, sceneId))).for('update').limit(1);
      if (!layer) return { error: 'INVALID_LAYER' as const };
      if (layer.locked) return { error: 'LAYER_LOCKED' as const };
      if (layer.kind === 'BACKGROUND') return { error: 'INVALID_LAYER' as const };
      const sourceRows = await tx.select().from(sceneObjects)
        .where(and(eq(sceneObjects.sceneId, sceneId), inArray(sceneObjects.id, input.objects.map((item) => item.objectId))))
        .orderBy(asc(sceneObjects.id)).for('update');
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
    return reply.code(201).send({ objects: result.objects });
  });
  app.patch('/api/objects/:objectId', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { objectId } = request.params as { objectId: string };
    const input = parseBody(updateSceneObjectSchema, request.body);
    const [row] = await db.select({ object: sceneObjects, layer: sceneLayers, scene: scenes }).from(sceneObjects).innerJoin(sceneLayers, eq(sceneObjects.layerId, sceneLayers.id)).innerJoin(scenes, eq(sceneObjects.sceneId, scenes.id)).where(eq(sceneObjects.id, objectId)).limit(1);
    if (!row) return reply.code(404).send({ error: 'NOT_FOUND' });
    const role = await roleFor(row.scene.campaignId, user.id);
    if (!role) return reply.code(403).send({ error: 'FORBIDDEN' });
    const canManage = role === 'OWNER' || role === 'GM';
    if (!canManage) {
      const [campaign] = await db.select({ playersCanDraw: campaigns.playersCanDraw }).from(campaigns).where(eq(campaigns.id, row.scene.campaignId)).limit(1);
      if (role !== 'PLAYER' || !campaign?.playersCanDraw || !row.scene.isActive || row.object.createdBy !== user.id || row.object.kind !== 'FREEHAND' || row.layer.kind !== 'OBJECTS' || !row.layer.visibleToPlayers) return reply.code(403).send({ error: 'FORBIDDEN' });
    }
    if (row.scene.archivedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (row.layer.locked) return reply.code(409).send({ error: 'LAYER_LOCKED' });
    const { expectedVersion, ...patch } = input;
    const requestedFields = Object.keys(request.body as Record<string, unknown>).filter((field) => field !== 'expectedVersion');
    if (!canManage && requestedFields.some((field) => !['x', 'y', 'width', 'height', 'color', 'strokeWidth', 'points'].includes(field))) return reply.code(403).send({ error: 'FORBIDDEN' });
    if (row.object.locked && !(patch.locked === false && requestedFields.length === 1 && requestedFields[0] === 'locked')) return reply.code(409).send({ error: 'OBJECT_LOCKED' });
    let targetLayerKind = row.layer.kind;
    if (patch.layerId) {
      const [nextLayer] = await db.select().from(sceneLayers).where(and(eq(sceneLayers.id, patch.layerId), eq(sceneLayers.sceneId, row.scene.id))).limit(1);
      if (!nextLayer) return reply.code(400).send({ error: 'INVALID_LAYER' });
      if (nextLayer.locked) return reply.code(409).send({ error: 'LAYER_LOCKED' });
      targetLayerKind = nextLayer.kind;
    }
    if (targetLayerKind === 'GM') patch.visible = false;
    if (patch.assetId) {
      const [asset] = await db.select({ id: assets.id }).from(assets).where(and(eq(assets.id, patch.assetId), eq(assets.campaignId, row.scene.campaignId))).limit(1);
      if (!asset) return reply.code(400).send({ error: 'INVALID_ASSET' });
    }
    const [updated] = await db.update(sceneObjects).set({ ...patch, version: row.object.version + 1 }).where(and(eq(sceneObjects.id, objectId), eq(sceneObjects.version, expectedVersion))).returning();
    if (!updated) return reply.code(409).send({ error: 'CONFLICT' });
    await db.insert(auditEvents).values({ campaignId: row.scene.campaignId, actorId: user.id, action: 'scene.object_updated', targetId: objectId });
    const newLayerId = updated.layerId;
    const [newLayer] = newLayerId === row.layer.id ? [row.layer] : await db.select().from(sceneLayers).where(eq(sceneLayers.id, newLayerId)).limit(1);
    const room = `campaign:${row.scene.campaignId}`;
    const wasPublic = row.scene.isActive && row.layer.visibleToPlayers && row.layer.kind !== 'GM' && row.object.visible;
    const isPublic = row.scene.isActive && newLayer?.visibleToPlayers && newLayer.kind !== 'GM' && updated.visible;
    if (wasPublic && !isPublic) io.to(room).emit('scene:object_deleted', { sceneId: row.scene.id, objectId });
    if (isPublic) io.to(room).emit('scene:object_updated', { object: sceneObjectProjection(updated, 'PLAYER') });
    else io.to(`${room}:gm`).emit('scene:object_updated', { object: updated });
    return { object: sceneObjectProjection(updated, role, user.id) };
  });
  app.delete('/api/objects/:objectId', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { objectId } = request.params as { objectId: string };
    const input = parseBody(z.object({ expectedVersion: z.number().int().positive() }), request.body);
    const [row] = await db.select({ object: sceneObjects, layer: sceneLayers, scene: scenes }).from(sceneObjects).innerJoin(sceneLayers, eq(sceneObjects.layerId, sceneLayers.id)).innerJoin(scenes, eq(sceneObjects.sceneId, scenes.id)).where(eq(sceneObjects.id, objectId)).limit(1);
    if (!row) return reply.code(404).send({ error: 'NOT_FOUND' });
    const role = await roleFor(row.scene.campaignId, user.id);
    if (!role) return reply.code(403).send({ error: 'FORBIDDEN' });
    const canManage = role === 'OWNER' || role === 'GM';
    if (!canManage && (role !== 'PLAYER' || row.object.kind !== 'FREEHAND' || row.object.createdBy !== user.id)) return reply.code(403).send({ error: 'FORBIDDEN' });
    if (row.scene.archivedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (row.layer.locked) return reply.code(409).send({ error: 'LAYER_LOCKED' });
    if (row.object.locked) return reply.code(409).send({ error: 'OBJECT_LOCKED' });
    const [deleted] = await db.delete(sceneObjects).where(and(eq(sceneObjects.id, objectId), eq(sceneObjects.version, input.expectedVersion))).returning({ id: sceneObjects.id });
    if (!deleted) return reply.code(409).send({ error: 'CONFLICT' });
    const room = `campaign:${row.scene.campaignId}`;
    if (row.scene.isActive && row.layer.visibleToPlayers && row.layer.kind !== 'GM' && row.object.visible) io.to(room).emit('scene:object_deleted', { sceneId: row.scene.id, objectId });
    else io.to(`${room}:gm`).emit('scene:object_deleted', { sceneId: row.scene.id, objectId });
    await db.insert(auditEvents).values({ campaignId: row.scene.campaignId, actorId: user.id, action: 'scene.object_deleted', targetId: objectId });
    return reply.code(204).send();
  });
}

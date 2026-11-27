import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { createSceneSchema } from '@nri/contracts';
import { db } from '../../db/index.js';
import { auditEvents, sceneLayers, sceneObjects, scenes, tokens } from '../../db/schema.js';
import { canListScene } from '../../domain/sceneAccess.js';
import type { FastifyInstance } from 'fastify';
import type { Server } from 'socket.io';
import { parseBody, requireUser, roleFor } from '../../security/access.js';
import { publicScene } from '../../domain/projections.js';
import { defaultLayerRows } from '../../domain/defaultLayers.js';

export function registerSceneRoutes(app: FastifyInstance, io: Server) {
  app.get('/api/campaigns/:campaignId/scenes', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { campaignId } = request.params as { campaignId: string };
    const role = await roleFor(campaignId, user.id);
    if (!role) return reply.code(404).send({ error: 'NOT_FOUND' });
    const archived = (request.query as { archived?: string }).archived === 'true';
    if (archived && !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
    const rows = await db.select().from(scenes).where(eq(scenes.campaignId, campaignId)).orderBy(asc(scenes.sortOrder), asc(scenes.id));
    return rows.filter((scene) => canListScene(role, scene.isActive, scene.archivedAt !== null, archived));
  });

  app.patch('/api/scenes/:sceneId', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { sceneId } = request.params as { sceneId: string };
    const input = parseBody(z.object({
      title: z.string().trim().min(1).max(80).optional(), gridSize: z.number().int().min(8).max(256).optional(), width: z.number().int().min(256).max(16384).optional(), height: z.number().int().min(256).max(16384).optional(),
      gridColor: z.string().regex(/^#[\da-fA-F]{6}$/).optional(), gridOpacity: z.number().min(0).max(1).optional(), gridOffsetX: z.number().min(-16384).max(16384).optional(), gridOffsetY: z.number().min(-16384).max(16384).optional(), gridEnabled: z.boolean().optional(), snapToGrid: z.boolean().optional(), unitsPerCell: z.number().min(0.01).max(100000).optional(), unitLabel: z.string().trim().min(1).max(24).optional(), cameraX: z.number().min(-32768).max(32768).optional(), cameraY: z.number().min(-32768).max(32768).optional(), cameraZoom: z.number().min(0.25).max(4).optional(), expectedVersion: z.number().int().positive(),
    }).refine(({ expectedVersion: _expectedVersion, ...fields }) => Object.values(fields).some((value) => value !== undefined)), request.body);
    const [scene] = await db.select().from(scenes).where(eq(scenes.id, sceneId)).limit(1);
    if (!scene) return reply.code(404).send({ error: 'NOT_FOUND' });
    const role = await roleFor(scene.campaignId, user.id);
    if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
    if (scene.archivedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
    const { expectedVersion, ...patch } = input;
    const [updated] = await db.update(scenes).set({ ...patch, version: scene.version + 1 }).where(and(eq(scenes.id, sceneId), eq(scenes.version, expectedVersion), isNull(scenes.archivedAt))).returning();
    if (!updated) return reply.code(409).send({ error: 'CONFLICT' });
    await db.insert(auditEvents).values({ campaignId: scene.campaignId, actorId: user.id, action: 'scene.updated', targetId: sceneId });
    if (updated.isActive) io.to(`campaign:${scene.campaignId}`).emit('scene:updated', { scene: publicScene(updated) });
    return { scene: updated };
  });
  app.post('/api/scenes/:sceneId/duplicate', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { sceneId } = request.params as { sceneId: string };
    const [source] = await db.select().from(scenes).where(eq(scenes.id, sceneId)).limit(1);
    if (!source) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (source.archivedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
    const role = await roleFor(source.campaignId, user.id);
    if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
    const duplicate = await db.transaction(async (tx) => {
      const [last] = await tx.select({ sortOrder: scenes.sortOrder }).from(scenes).where(eq(scenes.campaignId, source.campaignId)).orderBy(desc(scenes.sortOrder)).limit(1);
      const { id: _id, archivedAt: _archivedAt, version: _version, isActive: _isActive, published: _published, sortOrder: _sortOrder, ...copy } = source;
      const [scene] = await tx.insert(scenes).values({ ...copy, title: `${source.title} (copy)`.slice(0, 80), sortOrder: (last?.sortOrder ?? -1) + 1, isActive: false, published: false, archivedAt: null, version: 1 }).returning();
      if (!scene) throw new Error('Scene duplication failed');
      const sourceLayers = await tx.select().from(sceneLayers).where(eq(sceneLayers.sceneId, source.id)).orderBy(asc(sceneLayers.sortOrder));
      const copiedLayers = await tx.insert(sceneLayers).values(sourceLayers.map(({ id: _layerId, sceneId: _sceneId, ...layer }) => ({ ...layer, sceneId: scene.id, version: 1 }))).returning();
      const layerMap = new Map(sourceLayers.map((layer, index) => [layer.id, copiedLayers[index]!.id]));
      const sourceObjects = await tx.select().from(sceneObjects).where(and(eq(sceneObjects.sceneId, source.id), isNull(sceneObjects.deletedAt)));
      if (sourceObjects.length) await tx.insert(sceneObjects).values(sourceObjects.map(({ id: _objectId, sceneId: _sceneId, layerId, ...object }) => ({ ...object, sceneId: scene.id, layerId: layerMap.get(layerId)!, version: 1 })));
      const sourceTokens = await tx.select().from(tokens).where(and(eq(tokens.sceneId, source.id), isNull(tokens.deletedAt)));
      if (sourceTokens.length) await tx.insert(tokens).values(sourceTokens.map(({ id: _id, sceneId: _sceneId, ...token }) => ({ ...token, sceneId: scene.id })));
      await tx.insert(auditEvents).values({ campaignId: source.campaignId, actorId: user.id, action: 'scene.duplicated', targetId: scene.id });
      return scene;
    });
    return reply.code(201).send({ scene: duplicate });
  });
  app.put('/api/scenes/:sceneId/archive', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { sceneId } = request.params as { sceneId: string };
    const input = parseBody(z.object({ expectedVersion: z.number().int().positive() }), request.body);
    const [scene] = await db.select().from(scenes).where(eq(scenes.id, sceneId)).limit(1);
    if (!scene) return reply.code(404).send({ error: 'NOT_FOUND' });
    const role = await roleFor(scene.campaignId, user.id);
    if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
    if (scene.archivedAt) return reply.code(409).send({ error: 'CONFLICT' });
    let result: { scene: typeof scene; activated: typeof scene | null };
    try {
      result = await db.transaction(async (tx) => {
        const [updated] = await tx.update(scenes).set({ archivedAt: new Date(), isActive: false, version: scene.version + 1 }).where(and(eq(scenes.id, sceneId), eq(scenes.version, input.expectedVersion), isNull(scenes.archivedAt))).returning();
        if (!updated) throw new Error('SCENE_CONFLICT');
        let activated: typeof scene | null = null;
        if (scene.isActive) {
          const [fallback] = await tx.select().from(scenes).where(and(eq(scenes.campaignId, scene.campaignId), isNull(scenes.archivedAt), eq(scenes.published, true), sql`${scenes.id} <> ${sceneId}`)).orderBy(desc(scenes.sortOrder)).limit(1);
          if (fallback) { const [next] = await tx.update(scenes).set({ isActive: true, version: fallback.version + 1 }).where(and(eq(scenes.id, fallback.id), eq(scenes.version, fallback.version))).returning(); if (!next) throw new Error('SCENE_CONFLICT'); activated = next; }
        }
        await tx.insert(auditEvents).values({ campaignId: scene.campaignId, actorId: user.id, action: 'scene.archived', targetId: sceneId });
        return { scene: updated, activated };
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'SCENE_CONFLICT') return reply.code(409).send({ error: 'CONFLICT' });
      throw error;
    }
    if (scene.isActive) io.to(`campaign:${scene.campaignId}`).emit('scene:activated', { campaignId: scene.campaignId, sceneId: result.activated?.id ?? null });
    return { scene: result.scene };
  });
  app.post('/api/scenes', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const input = parseBody(createSceneSchema, request.body);
    const role = await roleFor(input.campaignId, user.id);
    if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
    const scene = await db.transaction(async (tx) => {
      const [last] = await tx.select({ sortOrder: scenes.sortOrder }).from(scenes).where(eq(scenes.campaignId, input.campaignId)).orderBy(desc(scenes.sortOrder)).limit(1);
      const [active] = await tx.select({ id: scenes.id }).from(scenes).where(and(eq(scenes.campaignId, input.campaignId), eq(scenes.isActive, true), isNull(scenes.archivedAt))).limit(1);
      const [created] = await tx.insert(scenes).values({ campaignId: input.campaignId, title: input.title, gridSize: input.gridSize, sortOrder: (last?.sortOrder ?? -1) + 1, isActive: !active, published: !active }).returning();
      if (created) await tx.insert(sceneLayers).values(defaultLayerRows.map((layer) => ({ ...layer, sceneId: created.id })));
      if (created) await tx.insert(auditEvents).values({ campaignId: input.campaignId, actorId: user.id, action: 'scene.created', targetId: created.id });
      return created;
    });
    if (!scene) throw new Error('Scene creation failed');
    if (scene.isActive) io.to(`campaign:${input.campaignId}`).emit('scene:activated', { campaignId: input.campaignId, sceneId: scene.id });
    return reply.code(201).send({ scene });
  });
  app.put('/api/scenes/:sceneId/activate', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { sceneId } = request.params as { sceneId: string };
    const input = parseBody(z.object({ expectedVersion: z.number().int().positive() }), request.body);
    const [scene] = await db.select().from(scenes).where(and(eq(scenes.id, sceneId), isNull(scenes.archivedAt))).limit(1);
    if (!scene) return reply.code(404).send({ error: 'NOT_FOUND' });
    const role = await roleFor(scene.campaignId, user.id);
    if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
    if (scene.version !== input.expectedVersion) return reply.code(409).send({ error: 'CONFLICT' });
    if (scene.isActive) return { scene };
    let activated: typeof scene;
    try {
      activated = await db.transaction(async (tx) => {
        await tx.update(scenes).set({ isActive: false, version: sql`${scenes.version} + 1` }).where(and(eq(scenes.campaignId, scene.campaignId), eq(scenes.isActive, true)));
        const [updated] = await tx.update(scenes).set({ isActive: true, published: true, version: scene.version + 1 }).where(and(eq(scenes.id, scene.id), eq(scenes.version, input.expectedVersion), isNull(scenes.archivedAt))).returning();
        if (!updated) throw new Error('SCENE_CONFLICT');
        await tx.insert(auditEvents).values({ campaignId: scene.campaignId, actorId: user.id, action: 'scene.activated', targetId: sceneId });
        return updated;
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'SCENE_CONFLICT') return reply.code(409).send({ error: 'CONFLICT' });
      throw error;
    }
    io.to(`campaign:${scene.campaignId}`).emit('scene:activated', { campaignId: scene.campaignId, sceneId: activated.id });
    return { scene: activated };
  });
  app.put('/api/scenes/:sceneId/restore', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { sceneId } = request.params as { sceneId: string };
    const input = parseBody(z.object({ expectedVersion: z.number().int().positive() }), request.body);
    const [scene] = await db.select().from(scenes).where(eq(scenes.id, sceneId)).limit(1);
    if (!scene) return reply.code(404).send({ error: 'NOT_FOUND' });
    const role = await roleFor(scene.campaignId, user.id);
    if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
    if (!scene.archivedAt || scene.version !== input.expectedVersion) return reply.code(409).send({ error: 'CONFLICT' });
    const [last] = await db.select({ sortOrder: scenes.sortOrder }).from(scenes).where(eq(scenes.campaignId, scene.campaignId)).orderBy(desc(scenes.sortOrder)).limit(1);
    const [restored] = await db.update(scenes).set({ archivedAt: null, sortOrder: (last?.sortOrder ?? -1) + 1, version: scene.version + 1 }).where(and(eq(scenes.id, sceneId), eq(scenes.version, input.expectedVersion))).returning();
    if (!restored) return reply.code(409).send({ error: 'CONFLICT' });
    await db.insert(auditEvents).values({ campaignId: scene.campaignId, actorId: user.id, action: 'scene.restored', targetId: sceneId });
    return { scene: restored };
  });
  app.put('/api/campaigns/:campaignId/scenes/reorder', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { campaignId } = request.params as { campaignId: string };
    const role = await roleFor(campaignId, user.id);
    if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
    const input = parseBody(z.object({ scenes: z.array(z.object({ id: z.uuid(), expectedVersion: z.number().int().positive() })).min(1).max(100) }), request.body);
    if (new Set(input.scenes.map(({ id }) => id)).size !== input.scenes.length) return reply.code(400).send({ error: 'INVALID' });
    try {
      await db.transaction(async (tx) => {
        const current = await tx.select().from(scenes).where(and(eq(scenes.campaignId, campaignId), isNull(scenes.archivedAt)));
        if (current.length !== input.scenes.length || input.scenes.some((item) => !current.some((scene) => scene.id === item.id && scene.version === item.expectedVersion))) throw new Error('SCENE_CONFLICT');
        for (const [sortOrder, item] of input.scenes.entries()) {
          const [updated] = await tx.update(scenes).set({ sortOrder, version: item.expectedVersion + 1 }).where(and(eq(scenes.id, item.id), eq(scenes.version, item.expectedVersion))).returning({ id: scenes.id });
          if (!updated) throw new Error('SCENE_CONFLICT');
        }
        await tx.insert(auditEvents).values({ campaignId, actorId: user.id, action: 'scenes.reordered' });
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'SCENE_CONFLICT') return reply.code(409).send({ error: 'CONFLICT' });
      throw error;
    }
    return db.select().from(scenes).where(and(eq(scenes.campaignId, campaignId), isNull(scenes.archivedAt))).orderBy(asc(scenes.sortOrder), asc(scenes.id));
  });
}

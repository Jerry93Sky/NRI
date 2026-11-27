import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { assetCategorySchema, createAssetFolderSchema, updateAssetFolderSchema, updateAssetSchema } from '@nri/contracts';
import { db } from '../../db/index.js';
import { assetFolders, assets, auditEvents, sceneLayers, sceneObjects, scenes, tokens } from '../../db/schema.js';
import { decodeImage, inspectImage } from '../../domain/imageMetadata.js';
import { assetThumbnailKey, makeAssetThumbnail } from '../../domain/assetThumbnail.js';
import type { FastifyInstance } from 'fastify';
import type { Server } from 'socket.io';
import { parseBody, requireUser, roleFor } from '../../security/access.js';
import { uploadDirectory } from '../../config/runtime.js';
import { publicScene } from '../../domain/projections.js';

export function registerAssetRoutes(app: FastifyInstance, io: Server) {
  app.post('/api/campaigns/:campaignId/assets', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { campaignId } = request.params as { campaignId: string };
    const role = await roleFor(campaignId, user.id);
    if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
    const category = assetCategorySchema.safeParse((request.query as { category?: string }).category ?? 'OTHER');
    if (!category.success) return reply.code(400).send({ error: 'INVALID_CATEGORY' });
    const uploaded: Array<{ id: string; name: string; category: string; mediaType: string; size: number; width: number; height: number }> = [];
    const failures: Array<{ filename: string; error: string }> = [];
    for await (const file of request.files()) {
      let buffer: Buffer;
      try { buffer = await file.toBuffer(); }
      catch { failures.push({ filename: file.filename, error: 'FILE_TOO_LARGE' }); continue; }
      let metadata: ReturnType<typeof inspectImage>;
      try {
        metadata = inspectImage(buffer);
        await decodeImage(buffer, metadata);
      }
      catch (error) { failures.push({ filename: file.filename, error: error instanceof Error ? error.message : 'INVALID_IMAGE' }); continue; }
      const extension = metadata.mediaType === 'image/png' ? '.png' : metadata.mediaType === 'image/jpeg' ? '.jpg' : '.webp';
      const storageKey = `${randomBytes(24).toString('hex')}${extension}`;
      const thumbnailKey = assetThumbnailKey(storageKey);
      const filename = file.filename.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) || 'Untitled image';
      await mkdir(uploadDirectory, { recursive: true });
      const destination = resolve(uploadDirectory, storageKey);
      const thumbnailDestination = resolve(uploadDirectory, thumbnailKey);
      try {
        await writeFile(destination, buffer, { flag: 'wx', mode: 0o600 });
        await writeFile(thumbnailDestination, await makeAssetThumbnail(buffer), { flag: 'wx', mode: 0o600 });
        const [asset] = await db.insert(assets).values({ campaignId, name: filename, category: category.data, storageKey, mediaType: metadata.mediaType, size: buffer.byteLength, checksum: createHash('sha256').update(buffer).digest('hex'), uploaderId: user.id }).returning();
        if (!asset) throw new Error('Asset metadata creation failed');
        await db.insert(auditEvents).values({ campaignId, actorId: user.id, action: 'asset.uploaded', targetId: asset.id });
        uploaded.push({ id: asset.id, name: asset.name, category: asset.category, mediaType: asset.mediaType, size: asset.size, width: metadata.width, height: metadata.height });
      } catch (error) {
        await Promise.all([unlink(destination).catch(() => {}), unlink(thumbnailDestination).catch(() => {})]);
        throw error;
      }
    }
    if (!uploaded.length && !failures.length) return reply.code(400).send({ error: 'FILE_REQUIRED' });
    const status = failures.length ? uploaded.length ? 207 : failures[0]?.error === 'FILE_TOO_LARGE' ? 413 : 415 : 201;
    if (!uploaded.length) return reply.code(status).send({ error: failures[0]?.error ?? 'UPLOAD_FAILED', assets: uploaded, failures });
    return reply.code(status).send({ assets: uploaded, asset: uploaded[0], failures });
  });
  app.get('/api/campaigns/:campaignId/assets', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { campaignId } = request.params as { campaignId: string };
    const role = await roleFor(campaignId, user.id);
    if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
    const [rows, folders, mapRefs, objectRefs, tokenRefs] = await Promise.all([
      db.select().from(assets).where(eq(assets.campaignId, campaignId)).orderBy(asc(assets.name)),
      db.select().from(assetFolders).where(eq(assetFolders.campaignId, campaignId)).orderBy(asc(assetFolders.name)),
      db.select({ assetId: scenes.backgroundAssetId, uses: sql<number>`count(*)::int` }).from(scenes).where(eq(scenes.campaignId, campaignId)).groupBy(scenes.backgroundAssetId),
      db.select({ assetId: sceneObjects.assetId, uses: sql<number>`count(*)::int` }).from(sceneObjects).innerJoin(scenes, eq(sceneObjects.sceneId, scenes.id)).where(eq(scenes.campaignId, campaignId)).groupBy(sceneObjects.assetId),
      db.select({ assetId: tokens.imageAssetId, uses: sql<number>`count(*)::int` }).from(tokens).innerJoin(scenes, eq(tokens.sceneId, scenes.id)).where(eq(scenes.campaignId, campaignId)).groupBy(tokens.imageAssetId),
    ]);
    const uses = new Map<string, number>();
    for (const ref of [...mapRefs, ...objectRefs, ...tokenRefs]) if (ref.assetId) uses.set(ref.assetId, (uses.get(ref.assetId) ?? 0) + ref.uses);
    const storageBytes = rows.reduce((total, asset) => total + asset.size, 0);
    return { assets: rows.map((asset) => ({ id: asset.id, name: asset.name, category: asset.category, folderId: asset.folderId, mediaType: asset.mediaType, size: asset.size, checksum: asset.checksum, usageCount: uses.get(asset.id) ?? 0 })), folders, storageBytes, assetCount: rows.length };
  });
  app.post('/api/campaigns/:campaignId/asset-folders', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { campaignId } = request.params as { campaignId: string };
    const role = await roleFor(campaignId, user.id);
    if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
    const input = parseBody(createAssetFolderSchema, request.body);
    const [folder] = await db.insert(assetFolders).values({ campaignId, name: input.name }).onConflictDoNothing({ target: [assetFolders.campaignId, assetFolders.name] }).returning();
    if (!folder) return reply.code(409).send({ error: 'ASSET_FOLDER_EXISTS' });
    await db.insert(auditEvents).values({ campaignId, actorId: user.id, action: 'asset_folder.created', targetId: folder.id });
    return reply.code(201).send({ folder });
  });
  app.patch('/api/asset-folders/:folderId', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { folderId } = request.params as { folderId: string };
    const input = parseBody(updateAssetFolderSchema, request.body);
    const [folder] = await db.select().from(assetFolders).where(eq(assetFolders.id, folderId)).limit(1);
    if (!folder) return reply.code(404).send({ error: 'NOT_FOUND' });
    const role = await roleFor(folder.campaignId, user.id);
    if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
    let updated;
    try {
      [updated] = await db.update(assetFolders).set({ name: input.name }).where(and(eq(assetFolders.id, folder.id), eq(assetFolders.campaignId, folder.campaignId))).returning();
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') return reply.code(409).send({ error: 'ASSET_FOLDER_EXISTS' });
      throw error;
    }
    if (!updated) return reply.code(404).send({ error: 'NOT_FOUND' });
    await db.insert(auditEvents).values({ campaignId: folder.campaignId, actorId: user.id, action: 'asset_folder.renamed', targetId: folder.id });
    return { folder: updated };
  });
  app.delete('/api/asset-folders/:folderId', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { folderId } = request.params as { folderId: string };
    const [folder] = await db.select().from(assetFolders).where(eq(assetFolders.id, folderId)).limit(1);
    if (!folder) return reply.code(404).send({ error: 'NOT_FOUND' });
    const role = await roleFor(folder.campaignId, user.id);
    if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
    await db.transaction(async (tx) => {
      await tx.update(assets).set({ folderId: null }).where(and(eq(assets.campaignId, folder.campaignId), eq(assets.folderId, folder.id)));
      await tx.delete(assetFolders).where(and(eq(assetFolders.id, folder.id), eq(assetFolders.campaignId, folder.campaignId)));
      await tx.insert(auditEvents).values({ campaignId: folder.campaignId, actorId: user.id, action: 'asset_folder.deleted', targetId: folder.id });
    });
    return reply.code(204).send();
  });
  app.patch('/api/assets/:assetId', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { assetId } = request.params as { assetId: string };
    const input = parseBody(updateAssetSchema, request.body);
    const [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
    if (!asset) return reply.code(404).send({ error: 'NOT_FOUND' });
    const role = await roleFor(asset.campaignId, user.id);
    if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
    if (input.folderId) {
      const [folder] = await db.select({ id: assetFolders.id }).from(assetFolders).where(and(eq(assetFolders.id, input.folderId), eq(assetFolders.campaignId, asset.campaignId))).limit(1);
      if (!folder) return reply.code(400).send({ error: 'INVALID_ASSET_FOLDER' });
    }
    const [updated] = await db.update(assets).set(input).where(eq(assets.id, assetId)).returning();
    if (!updated) return reply.code(404).send({ error: 'NOT_FOUND' });
    await db.insert(auditEvents).values({ campaignId: asset.campaignId, actorId: user.id, action: 'asset.updated', targetId: asset.id });
    return { asset: { id: updated.id, name: updated.name, category: updated.category, folderId: updated.folderId, mediaType: updated.mediaType, size: updated.size } };
  });
  app.delete('/api/assets/:assetId', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { assetId } = request.params as { assetId: string };
    const [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
    if (!asset) return reply.code(404).send({ error: 'NOT_FOUND' });
    const role = await roleFor(asset.campaignId, user.id);
    if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
    const removed = await db.transaction(async (tx) => {
      const [lockedAsset] = await tx.select({ id: assets.id }).from(assets).where(and(eq(assets.id, asset.id), eq(assets.campaignId, asset.campaignId))).for('update').limit(1);
      if (!lockedAsset) return false;
      const refs = await Promise.all([
        tx.select({ id: scenes.id }).from(scenes).where(eq(scenes.backgroundAssetId, asset.id)).limit(1),
        tx.select({ id: sceneObjects.id }).from(sceneObjects).where(eq(sceneObjects.assetId, asset.id)).limit(1),
        tx.select({ id: tokens.id }).from(tokens).where(eq(tokens.imageAssetId, asset.id)).limit(1),
      ]);
      if (refs.some((items) => items.length)) return false;
      const [deleted] = await tx.delete(assets).where(and(eq(assets.id, asset.id), eq(assets.campaignId, asset.campaignId))).returning({ id: assets.id });
      if (!deleted) return false;
      await tx.insert(auditEvents).values({ campaignId: asset.campaignId, actorId: user.id, action: 'asset.deleted', targetId: asset.id });
      return true;
    });
    if (!removed) return reply.code(409).send({ error: 'ASSET_IN_USE' });
    await Promise.all([
      unlink(resolve(uploadDirectory, asset.storageKey)).catch((error: unknown) => app.log.error({ err: error, assetId: asset.id }, 'Deleted asset file cleanup failed')),
      unlink(resolve(uploadDirectory, assetThumbnailKey(asset.storageKey))).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') app.log.error({ err: error, assetId: asset.id }, 'Deleted asset thumbnail cleanup failed'); }),
    ]);
    return reply.code(204).send();
  });
  app.put('/api/scenes/:sceneId/background', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { sceneId } = request.params as { sceneId: string };
    const input = parseBody(z.object({ assetId: z.uuid().nullable(), expectedVersion: z.number().int().positive() }), request.body);
    const [scene] = await db.select().from(scenes).where(eq(scenes.id, sceneId)).limit(1);
    if (!scene) return reply.code(404).send({ error: 'NOT_FOUND' });
    const role = await roleFor(scene.campaignId, user.id);
    if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
    if (scene.archivedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (input.assetId) {
      const [asset] = await db.select({ id: assets.id }).from(assets).where(and(eq(assets.id, input.assetId), eq(assets.campaignId, scene.campaignId))).limit(1);
      if (!asset) return reply.code(400).send({ error: 'INVALID_ASSET' });
    }
    const [updated] = await db.update(scenes).set({ backgroundAssetId: input.assetId, version: scene.version + 1 }).where(and(eq(scenes.id, sceneId), eq(scenes.version, input.expectedVersion))).returning();
    if (!updated) return reply.code(409).send({ error: 'CONFLICT' });
    await db.insert(auditEvents).values({ campaignId: scene.campaignId, actorId: user.id, action: 'scene.background_changed', targetId: sceneId });
    if (updated.isActive) io.to(`campaign:${scene.campaignId}`).emit('scene:updated', { scene: publicScene(updated) });
    return { scene: updated };
  });
  app.get('/api/assets/:assetId', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { assetId } = request.params as { assetId: string };
    const variant = (request.query as { variant?: string }).variant;
    if (variant !== undefined && variant !== 'thumbnail') return reply.code(400).send({ error: 'INVALID_VARIANT' });
    const [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
    if (!asset) return reply.code(404).send({ error: 'NOT_FOUND' });
    const role = await roleFor(asset.campaignId, user.id);
    if (!role) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (!['OWNER', 'GM'].includes(role)) {
      const [visibleMap] = await db.select({ id: scenes.id }).from(scenes).where(and(eq(scenes.campaignId, asset.campaignId), eq(scenes.backgroundAssetId, asset.id), eq(scenes.isActive, true), isNull(scenes.archivedAt))).limit(1);
      const [visibleObject] = await db.select({ id: sceneObjects.id }).from(sceneObjects).innerJoin(sceneLayers, eq(sceneObjects.layerId, sceneLayers.id)).innerJoin(scenes, eq(sceneObjects.sceneId, scenes.id)).where(and(eq(scenes.campaignId, asset.campaignId), eq(scenes.isActive, true), isNull(scenes.archivedAt), eq(sceneObjects.assetId, asset.id), eq(sceneObjects.visible, true), eq(sceneLayers.visibleToPlayers, true), sql`${sceneLayers.kind} <> 'GM'`)).limit(1);
      const [visibleToken] = await db.select({ id: tokens.id }).from(tokens).innerJoin(scenes, eq(tokens.sceneId, scenes.id)).where(and(eq(scenes.campaignId, asset.campaignId), eq(scenes.isActive, true), isNull(scenes.archivedAt), eq(tokens.imageAssetId, asset.id), eq(tokens.hidden, false))).limit(1);
      if (!visibleMap && !visibleObject && !visibleToken) return reply.code(404).send({ error: 'NOT_FOUND' });
    }
    if (variant === 'thumbnail') {
      const thumbnailPath = resolve(uploadDirectory, assetThumbnailKey(asset.storageKey));
      let thumbnail: Buffer;
      try { thumbnail = await readFile(thumbnailPath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const original = await readFile(resolve(uploadDirectory, asset.storageKey));
        thumbnail = await makeAssetThumbnail(original);
        try { await writeFile(thumbnailPath, thumbnail, { flag: 'wx', mode: 0o600 }); }
        catch (writeError) {
          if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
          thumbnail = await readFile(thumbnailPath);
        }
      }
      return reply.type('image/webp').header('x-content-type-options', 'nosniff').header('cache-control', 'private, no-store').send(thumbnail);
    }
    return reply.type(asset.mediaType).header('x-content-type-options', 'nosniff').header('cache-control', 'private, no-store').send(createReadStream(resolve(uploadDirectory, asset.storageKey)));
  });
}

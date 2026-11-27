import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { assetCategorySchema, createAssetFolderSchema, updateAssetFolderSchema, updateAssetSchema } from '@nri/contracts';
import { db } from '../../db/index.js';
import { assetFolders, assets, auditEvents, sceneLayers, sceneObjects, scenes, tokens } from '../../db/schema.js';
import { decodeImage, inspectImage } from '../../domain/imageMetadata.js';
import { assetThumbnailKey, makeAssetThumbnail } from '../../domain/assetThumbnail.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Server } from 'socket.io';
import { cookieName, uploadDirectory } from '../../config/runtime.js';
import { digest, parseBody } from '../../security/access.js';
import { commandSessionIsActive, lockCampaign, lockCampaignActor, lockCampaignRoles, lockCampaignSceneActor, lockCommandSession } from '../../security/commandAccess.js';
import { publishSceneUpdate } from '../../realtime/sceneEvents.js';

const errorStatus = { UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409 } as const;
const assetResponse = (asset: typeof assets.$inferSelect) => ({ id: asset.id, name: asset.name, category: asset.category, folderId: asset.folderId, mediaType: asset.mediaType, size: asset.size });
type AssetCommandError = { error: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' };

async function lockAssetActor(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], tokenHash: string, assetId: string): Promise<AssetCommandError | { userId: string; role: string; asset: typeof assets.$inferSelect }> {
  const session = await lockCommandSession(tx, tokenHash);
  if (!session) return { error: 'UNAUTHENTICATED' } as const;
  const [location] = await tx.select({ campaignId: assets.campaignId }).from(assets).where(eq(assets.id, assetId)).limit(1);
  if (!location) return { error: 'NOT_FOUND' } as const;
  if (!await lockCampaign(tx, location.campaignId)) return { error: 'FORBIDDEN' } as const;
  const role = (await lockCampaignRoles(tx, location.campaignId, [session.userId])).get(session.userId);
  const [asset] = await tx.select().from(assets).where(and(eq(assets.id, assetId), eq(assets.campaignId, location.campaignId))).for('update').limit(1);
  if (!role || !asset) return { error: 'NOT_FOUND' } as const;
  if (!await commandSessionIsActive(tx, tokenHash)) return { error: 'UNAUTHENTICATED' } as const;
  return { userId: session.userId, role, asset } as const;
}

async function lockFolderActor(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], tokenHash: string, folderId: string, campaignStrength: 'share' | 'update' = 'share'): Promise<AssetCommandError | { userId: string; role: string; folder: typeof assetFolders.$inferSelect }> {
  const session = await lockCommandSession(tx, tokenHash);
  if (!session) return { error: 'UNAUTHENTICATED' } as const;
  const [location] = await tx.select({ campaignId: assetFolders.campaignId }).from(assetFolders).where(eq(assetFolders.id, folderId)).limit(1);
  if (!location) return { error: 'NOT_FOUND' } as const;
  if (!await lockCampaign(tx, location.campaignId, campaignStrength)) return { error: 'FORBIDDEN' } as const;
  const role = (await lockCampaignRoles(tx, location.campaignId, [session.userId])).get(session.userId);
  const [folder] = await tx.select().from(assetFolders).where(and(eq(assetFolders.id, folderId), eq(assetFolders.campaignId, location.campaignId))).for('update').limit(1);
  if (!role || !folder) return { error: 'NOT_FOUND' } as const;
  if (!await commandSessionIsActive(tx, tokenHash)) return { error: 'UNAUTHENTICATED' } as const;
  return { userId: session.userId, role, folder } as const;
}

function requireManager(role: string) { return role === 'OWNER' || role === 'GM'; }
function testFault(request: FastifyRequest, stage: string) {
  if (process.env.NODE_ENV === 'test' && request.headers['x-nri-test-asset-fault'] === stage) throw new Error(`Injected test asset failure: ${stage}`);
}

export function registerAssetRoutes(app: FastifyInstance, io: Server) {
  app.post('/api/campaigns/:campaignId/assets', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const { campaignId } = request.params as { campaignId: string };
    const category = assetCategorySchema.safeParse((request.query as { category?: string }).category ?? 'OTHER');
    if (!category.success) return reply.code(400).send({ error: 'INVALID_CATEGORY' });
    const preflight = await db.transaction(async (tx) => {
      const actor = await lockCampaignActor(tx, digest(cookie), campaignId);
      if ('error' in actor) return actor;
      return requireManager(actor.role) ? { ok: true } as const : { error: 'FORBIDDEN' } as const;
    });
    if ('error' in preflight) return reply.code(errorStatus[preflight.error]).send({ error: preflight.error });

    const uploaded: Array<{ id: string; name: string; category: string; mediaType: string; size: number; width: number; height: number }> = [];
    const failures: Array<{ filename: string; error: string }> = [];
    for await (const file of request.files()) {
      let buffer: Buffer;
      try { buffer = await file.toBuffer(); }
      catch { failures.push({ filename: file.filename, error: 'FILE_TOO_LARGE' }); continue; }
      let metadata: ReturnType<typeof inspectImage>;
      let thumbnail: Buffer;
      try {
        metadata = inspectImage(buffer);
        await decodeImage(buffer, metadata);
        thumbnail = await makeAssetThumbnail(buffer);
      } catch (error) {
        failures.push({ filename: file.filename, error: error instanceof Error ? error.message : 'INVALID_IMAGE' });
        continue;
      }
      testFault(request, 'after-thumbnail-generation');
      const extension = metadata.mediaType === 'image/png' ? '.png' : metadata.mediaType === 'image/jpeg' ? '.jpg' : '.webp';
      const storageKey = `${randomBytes(24).toString('hex')}${extension}`;
      const thumbnailKey = assetThumbnailKey(storageKey);
      const filename = file.filename.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) || 'Untitled image';
      const originalTemp = resolve(uploadDirectory, `.asset-${randomBytes(16).toString('hex')}.pending`);
      const thumbnailTemp = resolve(uploadDirectory, `.asset-${randomBytes(16).toString('hex')}.pending`);
      const destination = resolve(uploadDirectory, storageKey);
      const thumbnailDestination = resolve(uploadDirectory, thumbnailKey);
      let committed = false;
      try {
        await mkdir(uploadDirectory, { recursive: true });
        await writeFile(originalTemp, buffer, { flag: 'wx', mode: 0o600 });
        testFault(request, 'after-original-stage');
        await writeFile(thumbnailTemp, thumbnail, { flag: 'wx', mode: 0o600 });
        testFault(request, 'after-thumbnail-stage');
        const result = await db.transaction(async (tx) => {
          const actor = await lockCampaignActor(tx, digest(cookie), campaignId);
          if ('error' in actor) return actor;
          if (!requireManager(actor.role)) return { error: 'FORBIDDEN' } as const;
          const [asset] = await tx.insert(assets).values({ campaignId, name: filename, category: category.data, storageKey, mediaType: metadata.mediaType,
            size: buffer.byteLength, checksum: createHash('sha256').update(buffer).digest('hex'), uploaderId: actor.userId }).returning();
          if (!asset) throw new Error('Asset metadata creation failed');
          testFault(request, 'after-db-insert');
          testFault(request, 'before-file-rename');
          await rename(originalTemp, destination);
          testFault(request, 'after-original-rename');
          await rename(thumbnailTemp, thumbnailDestination);
          testFault(request, 'after-thumbnail-rename');
          await tx.insert(auditEvents).values({ campaignId, actorId: actor.userId, action: 'asset.uploaded', targetId: asset.id });
          return { asset } as const;
        });
        if ('error' in result) {
          await Promise.all([unlink(originalTemp).catch(() => {}), unlink(thumbnailTemp).catch(() => {})]);
          return reply.code(errorStatus[result.error]).send({ error: result.error });
        }
        committed = true;
        uploaded.push({ id: result.asset.id, name: result.asset.name, category: result.asset.category, mediaType: result.asset.mediaType,
          size: result.asset.size, width: metadata.width, height: metadata.height });
      } catch (error) {
        await Promise.all([unlink(originalTemp).catch(() => {}), unlink(thumbnailTemp).catch(() => {}), unlink(destination).catch(() => {}), unlink(thumbnailDestination).catch(() => {})]);
        if (request.headers['x-nri-test-asset-fault'] !== undefined && process.env.NODE_ENV === 'test') throw error;
        failures.push({ filename: file.filename, error: 'UPLOAD_FAILED' });
      } finally {
        if (!committed) await Promise.all([unlink(originalTemp).catch(() => {}), unlink(thumbnailTemp).catch(() => {})]);
      }
    }
    if (!uploaded.length && !failures.length) return reply.code(400).send({ error: 'FILE_REQUIRED' });
    const status = failures.length ? uploaded.length ? 207 : failures[0]?.error === 'FILE_TOO_LARGE' ? 413 : 415 : 201;
    if (!uploaded.length) return reply.code(status).send({ error: failures[0]?.error ?? 'UPLOAD_FAILED', assets: uploaded, failures });
    return reply.code(status).send({ assets: uploaded, asset: uploaded[0], failures });
  });

  app.get('/api/campaigns/:campaignId/assets', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const { campaignId } = request.params as { campaignId: string };
    const result = await db.transaction(async (tx) => {
      const actor = await lockCampaignActor(tx, digest(cookie), campaignId);
      if ('error' in actor) return actor;
      if (!requireManager(actor.role)) return { error: 'FORBIDDEN' } as const;
      const [rows, folders, mapRefs, objectRefs, tokenRefs] = await Promise.all([
        tx.select().from(assets).where(eq(assets.campaignId, campaignId)).orderBy(asc(assets.name)),
        tx.select().from(assetFolders).where(eq(assetFolders.campaignId, campaignId)).orderBy(asc(assetFolders.name)),
        tx.select({ assetId: scenes.backgroundAssetId, uses: sql<number>`count(*)::int` }).from(scenes).where(eq(scenes.campaignId, campaignId)).groupBy(scenes.backgroundAssetId),
        tx.select({ assetId: sceneObjects.assetId, uses: sql<number>`count(*)::int` }).from(sceneObjects).innerJoin(scenes, eq(sceneObjects.sceneId, scenes.id)).where(eq(scenes.campaignId, campaignId)).groupBy(sceneObjects.assetId),
        tx.select({ assetId: tokens.imageAssetId, uses: sql<number>`count(*)::int` }).from(tokens).innerJoin(scenes, eq(tokens.sceneId, scenes.id)).where(eq(scenes.campaignId, campaignId)).groupBy(tokens.imageAssetId),
      ]);
      if (!await commandSessionIsActive(tx, digest(cookie))) return { error: 'UNAUTHENTICATED' } as const;
      const uses = new Map<string, number>();
      for (const ref of [...mapRefs, ...objectRefs, ...tokenRefs]) if (ref.assetId) uses.set(ref.assetId, (uses.get(ref.assetId) ?? 0) + ref.uses);
      return { assets: rows.map((asset) => ({ id: asset.id, name: asset.name, category: asset.category, folderId: asset.folderId, mediaType: asset.mediaType, size: asset.size, checksum: asset.checksum, usageCount: uses.get(asset.id) ?? 0 })), folders, storageBytes: rows.reduce((total, asset) => total + asset.size, 0), assetCount: rows.length } as const;
    });
    if ('error' in result) return reply.code(errorStatus[result.error]).send({ error: result.error });
    return result;
  });

  app.post('/api/campaigns/:campaignId/asset-folders', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const { campaignId } = request.params as { campaignId: string };
    const input = parseBody(createAssetFolderSchema, request.body);
    const result = await db.transaction(async (tx) => {
      const actor = await lockCampaignActor(tx, digest(cookie), campaignId, { strength: 'update' });
      if ('error' in actor) return actor;
      if (!requireManager(actor.role)) return { error: 'FORBIDDEN' } as const;
      const [folder] = await tx.insert(assetFolders).values({ campaignId, name: input.name }).onConflictDoNothing({ target: [assetFolders.campaignId, assetFolders.name] }).returning();
      if (!folder) return { error: 'CONFLICT' } as const;
      await tx.insert(auditEvents).values({ campaignId, actorId: actor.userId, action: 'asset_folder.created', targetId: folder.id });
      return { folder } as const;
    });
    if ('error' in result) return reply.code(result.error === 'CONFLICT' ? 409 : errorStatus[result.error]).send({ error: result.error === 'CONFLICT' ? 'ASSET_FOLDER_EXISTS' : result.error });
    return reply.code(201).send({ folder: result.folder });
  });

  app.patch('/api/asset-folders/:folderId', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const { folderId } = request.params as { folderId: string };
    const input = parseBody(updateAssetFolderSchema, request.body);
    const result = await db.transaction(async (tx) => {
      const actor = await lockFolderActor(tx, digest(cookie), folderId, 'update');
      if ('error' in actor) return actor;
      if (!requireManager(actor.role)) return { error: 'FORBIDDEN' } as const;
      const [conflict] = await tx.select({ id: assetFolders.id }).from(assetFolders)
        .where(and(eq(assetFolders.campaignId, actor.folder.campaignId), eq(assetFolders.name, input.name), sql`${assetFolders.id} <> ${folderId}`)).limit(1);
      if (conflict) return { error: 'CONFLICT' } as const;
      const [updated] = await tx.update(assetFolders).set({ name: input.name }).where(and(eq(assetFolders.id, folderId), eq(assetFolders.campaignId, actor.folder.campaignId))).returning();
      if (!updated) return { error: 'NOT_FOUND' } as const;
      await tx.insert(auditEvents).values({ campaignId: actor.folder.campaignId, actorId: actor.userId, action: 'asset_folder.renamed', targetId: folderId });
      return { folder: updated } as const;
    });
    if ('error' in result) return reply.code(result.error === 'UNAUTHENTICATED' ? 401 : result.error === 'NOT_FOUND' ? 404 : result.error === 'CONFLICT' ? 409 : 403).send({ error: result.error });
    return { folder: result.folder };
  });

  app.delete('/api/asset-folders/:folderId', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const { folderId } = request.params as { folderId: string };
    const result = await db.transaction(async (tx) => {
      const actor = await lockFolderActor(tx, digest(cookie), folderId, 'update');
      if ('error' in actor) return actor;
      if (!requireManager(actor.role)) return { error: 'FORBIDDEN' } as const;
      const folderAssets = await tx.select({ id: assets.id }).from(assets).where(and(eq(assets.campaignId, actor.folder.campaignId), eq(assets.folderId, folderId))).orderBy(asc(assets.id)).for('update');
      if (folderAssets.length) await tx.update(assets).set({ folderId: null }).where(and(eq(assets.campaignId, actor.folder.campaignId), eq(assets.folderId, folderId)));
      await tx.delete(assetFolders).where(and(eq(assetFolders.id, folderId), eq(assetFolders.campaignId, actor.folder.campaignId)));
      await tx.insert(auditEvents).values({ campaignId: actor.folder.campaignId, actorId: actor.userId, action: 'asset_folder.deleted', targetId: folderId });
      return { ok: true } as const;
    });
    if ('error' in result) return reply.code(errorStatus[result.error]).send({ error: result.error });
    return reply.code(204).send();
  });

  app.patch('/api/assets/:assetId', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const { assetId } = request.params as { assetId: string };
    const input = parseBody(updateAssetSchema, request.body);
    const result = await db.transaction(async (tx) => {
      const session = await lockCommandSession(tx, digest(cookie));
      if (!session) return { error: 'UNAUTHENTICATED' } as const;
      const [location] = await tx.select({ campaignId: assets.campaignId, folderId: assets.folderId }).from(assets).where(eq(assets.id, assetId)).limit(1);
      if (!location) return { error: 'NOT_FOUND' } as const;
      if (!await lockCampaign(tx, location.campaignId)) return { error: 'FORBIDDEN' } as const;
      const role = (await lockCampaignRoles(tx, location.campaignId, [session.userId])).get(session.userId);
      if (!role) return { error: 'NOT_FOUND' } as const;
      if (!requireManager(role)) return { error: 'FORBIDDEN' } as const;
      const folderIds = [...new Set([location.folderId, input.folderId].filter((id): id is string => Boolean(id)))].sort();
      const folders = folderIds.length ? await tx.select({ id: assetFolders.id }).from(assetFolders).where(and(eq(assetFolders.campaignId, location.campaignId), inArray(assetFolders.id, folderIds))).orderBy(asc(assetFolders.id)).for('share') : [];
      if (input.folderId && !folders.some(({ id }) => id === input.folderId)) return { error: 'INVALID_FOLDER' } as const;
      const [asset] = await tx.select().from(assets).where(and(eq(assets.id, assetId), eq(assets.campaignId, location.campaignId))).for('update').limit(1);
      if (!asset) return { error: 'NOT_FOUND' } as const;
      if (!await commandSessionIsActive(tx, digest(cookie))) return { error: 'UNAUTHENTICATED' } as const;
      const [updated] = await tx.update(assets).set(input).where(and(eq(assets.id, assetId), eq(assets.campaignId, location.campaignId))).returning();
      if (!updated) return { error: 'NOT_FOUND' } as const;
      await tx.insert(auditEvents).values({ campaignId: location.campaignId, actorId: session.userId, action: 'asset.updated', targetId: assetId });
      return { asset: updated } as const;
    });
    if ('error' in result) return reply.code(result.error === 'INVALID_FOLDER' ? 400 : errorStatus[result.error]).send({ error: result.error === 'INVALID_FOLDER' ? 'INVALID_ASSET_FOLDER' : result.error });
    return { asset: assetResponse(result.asset) };
  });

  app.delete('/api/assets/:assetId', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const { assetId } = request.params as { assetId: string };
    const result = await db.transaction(async (tx) => {
      const actor = await lockAssetActor(tx, digest(cookie), assetId);
      if ('error' in actor) return actor;
      if (!requireManager(actor.role)) return { error: 'FORBIDDEN' } as const;
      const references = await Promise.all([
        tx.select({ id: scenes.id }).from(scenes).where(eq(scenes.backgroundAssetId, assetId)).limit(1),
        tx.select({ id: sceneObjects.id }).from(sceneObjects).where(eq(sceneObjects.assetId, assetId)).limit(1),
        tx.select({ id: tokens.id }).from(tokens).where(eq(tokens.imageAssetId, assetId)).limit(1),
      ]);
      if (references.some((rows) => rows.length)) return { error: 'IN_USE' } as const;
      const [deleted] = await tx.delete(assets).where(and(eq(assets.id, assetId), eq(assets.campaignId, actor.asset.campaignId))).returning({ id: assets.id });
      if (!deleted) return { error: 'NOT_FOUND' } as const;
      await tx.insert(auditEvents).values({ campaignId: actor.asset.campaignId, actorId: actor.userId, action: 'asset.deleted', targetId: assetId });
      return { asset: actor.asset } as const;
    });
    if ('error' in result) return reply.code(result.error === 'IN_USE' ? 409 : errorStatus[result.error]).send({ error: result.error === 'IN_USE' ? 'ASSET_IN_USE' : result.error });
    await Promise.all([
      unlink(resolve(uploadDirectory, result.asset.storageKey)).catch((error: unknown) => app.log.error({ err: error, assetId }, 'Deleted asset file cleanup failed')),
      unlink(resolve(uploadDirectory, assetThumbnailKey(result.asset.storageKey))).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') app.log.error({ err: error, assetId }, 'Deleted asset thumbnail cleanup failed'); }),
    ]);
    return reply.code(204).send();
  });

  app.put('/api/scenes/:sceneId/background', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const { sceneId } = request.params as { sceneId: string };
    const input = parseBody(z.object({ assetId: z.uuid().nullable(), expectedVersion: z.number().int().positive() }), request.body);
    const result = await db.transaction(async (tx) => {
      const actor = await lockCampaignSceneActor(tx, digest(cookie), sceneId, { sceneStrength: 'update' });
      if ('error' in actor) return actor;
      if (!requireManager(actor.role)) return { error: 'FORBIDDEN' } as const;
      if (actor.scene.version !== input.expectedVersion) return { error: 'CONFLICT' } as const;
      if (input.assetId) {
        const [asset] = await tx.select({ id: assets.id }).from(assets).where(and(eq(assets.id, input.assetId), eq(assets.campaignId, actor.scene.campaignId))).for('share').limit(1);
        if (!asset) return { error: 'INVALID_ASSET' } as const;
      }
      const [updated] = await tx.update(scenes).set({ backgroundAssetId: input.assetId, version: input.expectedVersion + 1 })
        .where(and(eq(scenes.id, sceneId), eq(scenes.version, input.expectedVersion), isNull(scenes.archivedAt))).returning();
      if (!updated) return { error: 'CONFLICT' } as const;
      await tx.insert(auditEvents).values({ campaignId: actor.scene.campaignId, actorId: actor.userId, action: 'scene.background_changed', targetId: sceneId });
      return { scene: updated, campaignId: actor.scene.campaignId } as const;
    });
    if ('error' in result) return reply.code(result.error === 'UNAUTHENTICATED' ? 401 : result.error === 'INVALID_ASSET' ? 400 : result.error === 'NOT_FOUND' ? 404 : result.error === 'CONFLICT' ? 409 : 403).send({ error: result.error });
    if (result.scene.isActive) void publishSceneUpdate(io, result.campaignId, sceneId, result.scene.version).catch(() => request.log.error('Scene update could not be published'));
    return { scene: result.scene };
  });

  const authorizeAsset = async (tokenHash: string, assetId: string, variant: 'original' | 'thumbnail', openFile: boolean, readBytes = false) => db.transaction(async (tx) => {
    const session = await lockCommandSession(tx, tokenHash);
    if (!session) return { error: 'UNAUTHENTICATED' } as const;
    const [location] = await tx.select({ campaignId: assets.campaignId }).from(assets).where(eq(assets.id, assetId)).limit(1);
    if (!location || !await lockCampaign(tx, location.campaignId)) return { error: 'NOT_FOUND' } as const;
    const role = (await lockCampaignRoles(tx, location.campaignId, [session.userId])).get(session.userId);
    const [asset] = await tx.select().from(assets).where(and(eq(assets.id, assetId), eq(assets.campaignId, location.campaignId))).for('share').limit(1);
    if (!role || !asset) return { error: 'NOT_FOUND' } as const;
    if (!requireManager(role)) {
      const activeScenes = await tx.select({ id: scenes.id }).from(scenes).where(and(eq(scenes.campaignId, location.campaignId), eq(scenes.isActive, true), isNull(scenes.archivedAt))).orderBy(asc(scenes.id)).for('share');
      const activeIds = activeScenes.map(({ id }) => id);
      if (!activeIds.length) return { error: 'NOT_FOUND' } as const;
      const [visibleMap] = await tx.select({ id: scenes.id }).from(scenes).where(and(inArray(scenes.id, activeIds), eq(scenes.backgroundAssetId, asset.id))).limit(1);
      const [visibleObject] = await tx.select({ id: sceneObjects.id }).from(sceneObjects).innerJoin(sceneLayers, eq(sceneObjects.layerId, sceneLayers.id))
        .where(and(inArray(sceneObjects.sceneId, activeIds), isNull(sceneObjects.deletedAt), eq(sceneObjects.assetId, asset.id), eq(sceneObjects.visible, true), eq(sceneLayers.visibleToPlayers, true), sql`${sceneLayers.kind} <> 'GM'`))
        .for('share', { of: [sceneObjects, sceneLayers] }).limit(1);
      const [visibleToken] = await tx.select({ id: tokens.id }).from(tokens).where(and(inArray(tokens.sceneId, activeIds), eq(tokens.imageAssetId, asset.id), eq(tokens.hidden, false), isNull(tokens.deletedAt))).for('share').limit(1);
      if (!visibleMap && !visibleObject && !visibleToken) return { error: 'NOT_FOUND' } as const;
    }
    if (!await commandSessionIsActive(tx, tokenHash)) return { error: 'UNAUTHENTICATED' } as const;
    if (!openFile) return { asset, role } as const;
    const fileKey = variant === 'thumbnail' ? assetThumbnailKey(asset.storageKey) : asset.storageKey;
    const handle = await open(resolve(uploadDirectory, fileKey), 'r');
    if (readBytes) {
      try { return { asset, role, bytes: await handle.readFile() } as const; }
      finally { await handle.close(); }
    }
    return { asset, role, stream: handle.createReadStream({ autoClose: true }) } as const;
  });

  app.get('/api/assets/:assetId', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const { assetId } = request.params as { assetId: string };
    const variant = (request.query as { variant?: string }).variant;
    if (variant !== undefined && variant !== 'thumbnail') return reply.code(400).send({ error: 'INVALID_VARIANT' });
    const tokenHash = digest(cookie);
    const first = await authorizeAsset(tokenHash, assetId, variant === 'thumbnail' ? 'thumbnail' : 'original', false);
    if ('error' in first) return reply.code(first.error === 'UNAUTHENTICATED' ? 401 : 404).send({ error: first.error === 'UNAUTHENTICATED' ? first.error : 'NOT_FOUND' });
    if (variant === 'thumbnail') {
      const thumbnailPath = resolve(uploadDirectory, assetThumbnailKey(first.asset.storageKey));
      try { await readFile(thumbnailPath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const original = await readFile(resolve(uploadDirectory, first.asset.storageKey));
        const thumbnail = await makeAssetThumbnail(original);
        try { await writeFile(thumbnailPath, thumbnail, { flag: 'wx', mode: 0o600 }); }
        catch (writeError) { if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError; }
      }
      const current = await authorizeAsset(tokenHash, assetId, 'thumbnail', true, true);
      if ('error' in current) return reply.code(current.error === 'UNAUTHENTICATED' ? 401 : 404).send({ error: current.error === 'UNAUTHENTICATED' ? current.error : 'NOT_FOUND' });
      return reply.type('image/webp').header('x-content-type-options', 'nosniff').header('cache-control', 'private, no-store').header('accept-ranges', 'none').send(current.bytes);
    }
    const current = await authorizeAsset(tokenHash, assetId, 'original', true);
    if ('error' in current) return reply.code(current.error === 'UNAUTHENTICATED' ? 401 : 404).send({ error: current.error === 'UNAUTHENTICATED' ? current.error : 'NOT_FOUND' });
    return reply.type(current.asset.mediaType).header('x-content-type-options', 'nosniff').header('cache-control', 'private, no-store').header('accept-ranges', 'none').send(current.stream);
  });
}

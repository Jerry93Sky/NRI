import { constants as fsConstants } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { campaignDrawingPermissionSchema, createCampaignSchema } from '@nri/contracts';
import { db } from '../../db/index.js';
import { assetFolders, assets, auditEvents, campaigns, memberships, sceneLayers, sceneObjects, scenes, tokens } from '../../db/schema.js';
import type { FastifyInstance } from 'fastify';
import type { Server } from 'socket.io';
import { parseBody, requireUser, roleFor } from '../../security/access.js';
import { uploadDirectory } from '../../config/runtime.js';
import { archiveCampaignSockets } from '../../realtime/campaignRooms.js';
import { publishDrawingPermission } from '../../realtime/campaignEvents.js';

export function registerCampaignRoutes(app: FastifyInstance, io: Server) {
  app.get('/api/campaigns', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const archived = (request.query as { archived?: string }).archived === 'true';
    return db.select({ campaign: campaigns, role: memberships.role }).from(memberships).innerJoin(campaigns, eq(memberships.campaignId, campaigns.id)).where(and(eq(memberships.userId, user.id), archived ? isNotNull(campaigns.archivedAt) : isNull(campaigns.archivedAt)));
  });
  app.post('/api/campaigns', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const input = parseBody(createCampaignSchema, request.body);
    const created = await db.transaction(async (tx) => {
      const [campaign] = await tx.insert(campaigns).values({ ...input, ownerId: user.id }).returning();
      if (!campaign) throw new Error('Campaign creation failed');
      await tx.insert(memberships).values({ campaignId: campaign.id, userId: user.id, role: 'OWNER' });
      await tx.insert(auditEvents).values({ campaignId: campaign.id, actorId: user.id, action: 'campaign.created', targetId: campaign.id });
      return campaign;
    });
    return reply.code(201).send({ campaign: created });
  });
  app.post('/api/campaigns/:campaignId/duplicate', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { campaignId } = request.params as { campaignId: string };
    const role = await roleFor(campaignId, user.id);
    if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });

    const sourceAssets = await db.select().from(assets).where(eq(assets.campaignId, campaignId));
    const sourceBytes = sourceAssets.reduce((total, asset) => total + asset.size, 0);
    if (sourceAssets.length > 250 || sourceBytes > 256 * 1024 * 1024) return reply.code(413).send({ error: 'CAMPAIGN_COPY_TOO_LARGE' });
    const prepared: Array<{ sourceId: string; storageKey: string; tempPath: string; finalPath: string }> = [];
    try {
      await mkdir(uploadDirectory, { recursive: true });
      for (const asset of sourceAssets) {
        if (basename(asset.storageKey) !== asset.storageKey || !/^[\w.-]{1,80}$/.test(asset.storageKey)) throw new Error('Campaign contains an invalid asset storage key.');
        const sourcePath = resolve(uploadDirectory, asset.storageKey);
        const bytes = await readFile(sourcePath);
        if (bytes.byteLength !== asset.size || createHash('sha256').update(bytes).digest('hex') !== asset.checksum) throw new Error('Campaign asset integrity check failed.');
        const storageKey = `${randomBytes(24).toString('hex')}${extname(asset.storageKey)}`;
        const tempPath = resolve(uploadDirectory, `.campaign-copy-${randomUUID()}.pending`);
        const finalPath = resolve(uploadDirectory, storageKey);
        prepared.push({ sourceId: asset.id, storageKey, tempPath, finalPath });
        await writeFile(tempPath, bytes, { flag: 'wx', mode: 0o600 });
      }

      const copied = await db.transaction(async (tx) => {
        const [source] = await tx.select().from(campaigns).where(and(eq(campaigns.id, campaignId), isNull(campaigns.archivedAt))).for('update').limit(1);
        if (!source) return { error: 'NOT_FOUND' as const };
        const [membership] = await tx.select({ role: memberships.role }).from(memberships)
          .where(and(eq(memberships.campaignId, campaignId), eq(memberships.userId, user.id))).limit(1);
        if (!membership || !['OWNER', 'GM'].includes(membership.role)) return { error: 'FORBIDDEN' as const };

        const sourceSceneRows = await tx.select().from(scenes).where(eq(scenes.campaignId, campaignId)).orderBy(asc(scenes.sortOrder), asc(scenes.id));
        const sourceSceneIds = sourceSceneRows.map((scene) => scene.id);
        const sourceAssetRows = await tx.select().from(assets).where(eq(assets.campaignId, campaignId));
        const sourceFolderRows = await tx.select().from(assetFolders).where(eq(assetFolders.campaignId, campaignId));
        if (sourceAssetRows.length !== prepared.length || sourceAssetRows.some((asset) => !prepared.some((file) => file.sourceId === asset.id))) throw new Error('Campaign assets changed while the copy was being prepared.');
        const sourceLayerRows = sourceSceneIds.length ? await tx.select().from(sceneLayers).where(inArray(sceneLayers.sceneId, sourceSceneIds)) : [];
        const sourceTokenRows = sourceSceneIds.length ? await tx.select().from(tokens).where(and(inArray(tokens.sceneId, sourceSceneIds), isNull(tokens.deletedAt))) : [];
        const sourceObjectRows = sourceSceneIds.length ? await tx.select().from(sceneObjects).where(and(inArray(sceneObjects.sceneId, sourceSceneIds), isNull(sceneObjects.deletedAt))) : [];

        const [campaign] = await tx.insert(campaigns).values({
          ownerId: user.id,
          title: `Copy of ${source.title}`.slice(0, 80),
          description: source.description,
          playersCanDraw: source.playersCanDraw,
        }).returning();
        if (!campaign) throw new Error('Campaign copy creation failed.');
        await tx.insert(memberships).values({ campaignId: campaign.id, userId: user.id, role: 'OWNER' });

        const folderIds = new Map<string, string>();
        for (const sourceFolder of sourceFolderRows) {
          const [folder] = await tx.insert(assetFolders).values({ campaignId: campaign.id, name: sourceFolder.name }).returning({ id: assetFolders.id });
          if (!folder) throw new Error('Campaign copy asset folder insert failed.');
          folderIds.set(sourceFolder.id, folder.id);
        }
        const assetIds = new Map<string, string>();
        for (const sourceAsset of sourceAssetRows) {
          const file = prepared.find((item) => item.sourceId === sourceAsset.id)!;
          const [asset] = await tx.insert(assets).values({
            campaignId: campaign.id,
            name: sourceAsset.name,
            category: sourceAsset.category,
            folderId: sourceAsset.folderId ? folderIds.get(sourceAsset.folderId) ?? null : null,
            storageKey: file.storageKey,
            mediaType: sourceAsset.mediaType,
            size: sourceAsset.size,
            checksum: sourceAsset.checksum,
            uploaderId: user.id,
          }).returning({ id: assets.id });
          if (!asset) throw new Error('Campaign copy asset insert failed.');
          assetIds.set(sourceAsset.id, asset.id);
        }

        const sceneIds = new Map<string, string>();
        for (const sourceScene of sourceSceneRows) {
          const { id: sourceId, campaignId: _sourceCampaignId, ...sceneValues } = sourceScene;
          const [scene] = await tx.insert(scenes).values({
            ...sceneValues,
            campaignId: campaign.id,
            backgroundAssetId: sourceScene.backgroundAssetId ? assetIds.get(sourceScene.backgroundAssetId) ?? null : null,
            version: 1,
          }).returning({ id: scenes.id });
          if (!scene) throw new Error('Campaign copy scene insert failed.');
          sceneIds.set(sourceId, scene.id);
        }

        const layerIds = new Map<string, string>();
        for (const sourceLayer of sourceLayerRows) {
          const { id: sourceId, sceneId: sourceSceneId, ...layerValues } = sourceLayer;
          const [layer] = await tx.insert(sceneLayers).values({ ...layerValues, sceneId: sceneIds.get(sourceSceneId)!, version: 1 }).returning({ id: sceneLayers.id });
          if (!layer) throw new Error('Campaign copy layer insert failed.');
          layerIds.set(sourceId, layer.id);
        }

        for (const sourceToken of sourceTokenRows) {
          const { id: _id, sceneId: sourceSceneId, imageAssetId, ownerUserId: _ownerUserId, ownerNote: _ownerNote, deletedAt: _deletedAt, ...tokenValues } = sourceToken;
          await tx.insert(tokens).values({
            ...tokenValues,
            sceneId: sceneIds.get(sourceSceneId)!,
            imageAssetId: imageAssetId ? assetIds.get(imageAssetId) ?? null : null,
            ownerUserId: null,
            ownerNote: '',
            deletedAt: null,
            version: 1,
          });
        }

        for (const sourceObject of sourceObjectRows) {
          const { id: _id, sceneId: sourceSceneId, layerId: sourceLayerId, assetId, createdBy: _createdBy, ...objectValues } = sourceObject;
          await tx.insert(sceneObjects).values({
            ...objectValues,
            sceneId: sceneIds.get(sourceSceneId)!,
            layerId: layerIds.get(sourceLayerId)!,
            assetId: assetId ? assetIds.get(assetId) ?? null : null,
            createdBy: user.id,
            version: 1,
          });
        }

        await tx.insert(auditEvents).values({ campaignId: campaign.id, actorId: user.id, action: 'campaign.duplicated', targetId: campaign.id, detail: `Copied from ${campaignId}` });
        for (const file of prepared) {
          await copyFile(file.tempPath, file.finalPath, fsConstants.COPYFILE_EXCL);
        }
        return { campaign };
      }, { isolationLevel: 'repeatable read' });

      if ('error' in copied) return reply.code(copied.error === 'FORBIDDEN' ? 403 : 404).send({ error: copied.error });
      return reply.code(201).send({ campaign: copied.campaign });
    } catch (error) {
      await Promise.allSettled(prepared.map(async (file) => {
        await unlink(file.tempPath).catch(() => undefined);
        await unlink(file.finalPath).catch(() => undefined);
      }));
      throw error;
    } finally {
      await Promise.allSettled(prepared.map((file) => unlink(file.tempPath)));
    }
  });
  app.put('/api/campaigns/:campaignId/player-drawing', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { campaignId } = request.params as { campaignId: string };
    const input = parseBody(campaignDrawingPermissionSchema, request.body);
    const role = await roleFor(campaignId, user.id);
    if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
    const updated = await db.transaction(async (tx) => {
      const [result] = await tx.update(campaigns).set({ playersCanDraw: input.enabled }).where(eq(campaigns.id, campaignId)).returning({ id: campaigns.id, playersCanDraw: campaigns.playersCanDraw });
      if (result) await tx.insert(auditEvents).values({ campaignId, actorId: user.id, action: 'campaign.player_drawing_changed', targetId: campaignId, detail: input.enabled ? 'enabled' : 'disabled' });
      return result;
    });
    if (!updated) return reply.code(404).send({ error: 'NOT_FOUND' });
    void publishDrawingPermission(io, campaignId).catch(() => request.log.error('Drawing permission could not be published'));
    return { playersCanDraw: updated.playersCanDraw };
  });
  app.put('/api/campaigns/:campaignId/archive', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { campaignId } = request.params as { campaignId: string };
    const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
    if (!campaign) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (campaign.ownerId !== user.id) return reply.code(403).send({ error: 'FORBIDDEN' });
    const [updated] = await db.update(campaigns).set({ archivedAt: new Date() }).where(eq(campaigns.id, campaignId)).returning();
    archiveCampaignSockets(io, campaignId);
    await db.insert(auditEvents).values({ campaignId, actorId: user.id, action: 'campaign.archived', targetId: campaignId });
    return { campaign: updated };
  });
  app.put('/api/campaigns/:campaignId/restore', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { campaignId } = request.params as { campaignId: string };
    const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
    if (!campaign) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (campaign.ownerId !== user.id) return reply.code(403).send({ error: 'FORBIDDEN' });
    const [updated] = await db.update(campaigns).set({ archivedAt: null }).where(eq(campaigns.id, campaignId)).returning();
    await db.insert(auditEvents).values({ campaignId, actorId: user.id, action: 'campaign.restored', targetId: campaignId });
    return { campaign: updated };
  });
}

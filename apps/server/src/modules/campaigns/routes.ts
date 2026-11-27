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
import { digest, parseBody, requireUser, roleFor } from '../../security/access.js';
import { cookieName, uploadDirectory } from '../../config/runtime.js';
import { archiveCampaignSockets } from '../../realtime/campaignRooms.js';
import { publishDrawingPermission } from '../../realtime/campaignEvents.js';
import { commandSessionIsActive, lockCampaignActor, lockCommandSession } from '../../security/commandAccess.js';
import { lockOperationReceipt, operationRequestId, saveOperationReceipt } from '../../security/operationReceipts.js';

export function registerCampaignRoutes(app: FastifyInstance, io: Server) {
  app.get('/api/campaigns', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const archived = (request.query as { archived?: string }).archived === 'true';
    const tokenHash = digest(cookie);
    const result = await db.transaction(async (tx) => {
      const session = await lockCommandSession(tx, tokenHash);
      if (!session) return { error: 'UNAUTHENTICATED' } as const;
      const memberLocations = await tx.select({ campaignId: memberships.campaignId }).from(memberships).where(eq(memberships.userId, session.userId)).orderBy(asc(memberships.campaignId));
      const campaignIds = memberLocations.map(({ campaignId }) => campaignId);
      if (!campaignIds.length) return { campaigns: [] } as const;
      const campaignRows = await tx.select().from(campaigns).where(inArray(campaigns.id, campaignIds)).orderBy(asc(campaigns.id)).for('share');
      const memberRows = await tx.select({ campaignId: memberships.campaignId, role: memberships.role }).from(memberships)
        .where(and(eq(memberships.userId, session.userId), inArray(memberships.campaignId, campaignIds))).orderBy(asc(memberships.campaignId)).for('share');
      if (!await commandSessionIsActive(tx, tokenHash)) return { error: 'UNAUTHENTICATED' } as const;
      const byId = new Map(campaignRows.map((campaign) => [campaign.id, campaign]));
      return { campaigns: memberRows.flatMap(({ campaignId, role }) => {
        const campaign = byId.get(campaignId);
        return campaign && (archived ? campaign.archivedAt !== null : campaign.archivedAt === null) ? [{ campaign, role }] : [];
      }) } as const;
    });
    if ('error' in result) return reply.code(401).send({ error: result.error });
    return result.campaigns;
  });
  app.post('/api/campaigns', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const input = parseBody(createCampaignSchema, request.body);
    const requestId = operationRequestId(request.headers['idempotency-key']);
    if (requestId === 'invalid') return reply.code(400).send({ error: 'INVALID_REQUEST_ID' });
    const created = await db.transaction(async (tx) => {
      const session = await lockCommandSession(tx, digest(cookie));
      if (!session) return { error: 'UNAUTHENTICATED' } as const;
      const receipt = requestId ? await lockOperationReceipt(tx, { actorId: session.userId, campaignId: null, operationType: 'campaign.create', requestId }, input) : null;
      if (receipt?.kind === 'conflict') return { error: 'CONFLICT' } as const;
      if (receipt?.kind === 'replay') {
        const [campaign] = await tx.select().from(campaigns).innerJoin(memberships, and(eq(memberships.campaignId, campaigns.id), eq(memberships.userId, session.userId), eq(memberships.role, 'OWNER')))
          .where(and(eq(campaigns.id, receipt.resultIds[0]!), eq(campaigns.ownerId, session.userId))).limit(1);
        return campaign ? { campaign: campaign.campaigns, replayed: true } as const : { error: 'RESULT_UNAVAILABLE' } as const;
      }
      if (receipt?.kind === 'invalid') return { error: 'INVALID_REQUEST_ID' } as const;
      const [campaign] = await tx.insert(campaigns).values({ ...input, ownerId: session.userId }).returning();
      if (!campaign) throw new Error('Campaign creation failed');
      await tx.insert(memberships).values({ campaignId: campaign.id, userId: session.userId, role: 'OWNER' });
      await tx.insert(auditEvents).values({ campaignId: campaign.id, actorId: session.userId, action: 'campaign.created', targetId: campaign.id });
      if (receipt?.kind === 'new') await saveOperationReceipt(tx, receipt, [campaign.id]);
      return { campaign, replayed: false } as const;
    });
    if ('error' in created) return reply.code(created.error === 'UNAUTHENTICATED' ? 401 : created.error === 'CONFLICT' || created.error === 'RESULT_UNAVAILABLE' ? 409 : 400).send({ error: created.error });
    return reply.code(created.replayed ? 200 : 201).send({ campaign: created.campaign });
  });
  app.post('/api/campaigns/:campaignId/duplicate', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const { campaignId } = request.params as { campaignId: string };
    const requestId = operationRequestId(request.headers['idempotency-key']);
    if (requestId === 'invalid') return reply.code(400).send({ error: 'INVALID_REQUEST_ID' });
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

      const copyWithSnapshot = () => db.transaction(async (tx) => {
        const actor = await lockCampaignActor(tx, digest(cookie), campaignId, { strength: 'update' });
        if ('error' in actor) return actor;
        if (actor.userId !== user.id || (actor.role !== 'OWNER' && actor.role !== 'GM')) return { error: 'FORBIDDEN' as const };
        const [source] = await tx.select().from(campaigns).where(and(eq(campaigns.id, campaignId), isNull(campaigns.archivedAt))).limit(1);
        if (!source) return { error: 'NOT_FOUND' as const };
        const receipt = requestId ? await lockOperationReceipt(tx, { actorId: actor.userId, campaignId, operationType: 'campaign.duplicate', requestId }, { campaignId }) : null;
        if (receipt?.kind === 'conflict') return { error: 'CONFLICT' as const };
        if (receipt?.kind === 'replay') {
          const [existing] = await tx.select().from(campaigns).innerJoin(memberships, and(eq(memberships.campaignId, campaigns.id), eq(memberships.userId, actor.userId), eq(memberships.role, 'OWNER')))
            .where(and(eq(campaigns.id, receipt.resultIds[0]!), eq(campaigns.ownerId, actor.userId), isNull(campaigns.archivedAt))).limit(1);
          return existing ? { campaign: existing.campaigns, replayed: true } as const : { error: 'RESULT_UNAVAILABLE' as const };
        }

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
            uploaderId: actor.userId,
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
            createdBy: actor.userId,
            version: 1,
          });
        }

        await tx.insert(auditEvents).values({ campaignId: campaign.id, actorId: actor.userId, action: 'campaign.duplicated', targetId: campaign.id, detail: `Copied from ${campaignId}` });
        if (receipt?.kind === 'new') await saveOperationReceipt(tx, receipt, [campaign.id]);
        for (const file of prepared) {
          await copyFile(file.tempPath, file.finalPath, fsConstants.COPYFILE_EXCL);
        }
        return { campaign, replayed: false };
      }, { isolationLevel: 'repeatable read' });

      const copied = await copyWithSnapshot().catch((error: unknown) => {
        const databaseError = error instanceof Error ? error.cause ?? error : error;
        if (!requestId || typeof databaseError !== 'object' || databaseError === null ||
          !('code' in databaseError) || databaseError.code !== '23505' ||
          !('constraint' in databaseError) || databaseError.constraint !== 'rest_operation_receipts_scope_idx') throw error;
        // A competing commit can win after this REPEATABLE READ snapshot was taken.
        // The unique check ran before file copies. Take a fresh snapshot to read its receipt.
        return copyWithSnapshot();
      });
      if ('error' in copied) return reply.code(copied.error === 'FORBIDDEN' ? 403 : copied.error === 'CONFLICT' || copied.error === 'RESULT_UNAVAILABLE' ? 409 : 404).send({ error: copied.error });
      return reply.code(copied.replayed ? 200 : 201).send({ campaign: copied.campaign });
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
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const { campaignId } = request.params as { campaignId: string };
    const input = parseBody(campaignDrawingPermissionSchema, request.body);
    const updated = await db.transaction(async (tx) => {
      const actor = await lockCampaignActor(tx, digest(cookie), campaignId, { strength: 'no key update' });
      if ('error' in actor) return actor;
      if (actor.role !== 'OWNER' && actor.role !== 'GM') return { error: 'FORBIDDEN' } as const;
      const [result] = await tx.update(campaigns).set({ playersCanDraw: input.enabled }).where(eq(campaigns.id, campaignId)).returning({ id: campaigns.id, playersCanDraw: campaigns.playersCanDraw });
      if (!result) return { error: 'NOT_FOUND' } as const;
      await tx.insert(auditEvents).values({ campaignId, actorId: actor.userId, action: 'campaign.player_drawing_changed', targetId: campaignId, detail: input.enabled ? 'enabled' : 'disabled' });
      return { result } as const;
    });
    if ('error' in updated) return reply.code(updated.error === 'UNAUTHENTICATED' ? 401 : updated.error === 'NOT_FOUND' ? 404 : 403).send({ error: updated.error });
    void publishDrawingPermission(io, campaignId).catch(() => request.log.error('Drawing permission could not be published'));
    return { playersCanDraw: updated.result.playersCanDraw };
  });
  app.put('/api/campaigns/:campaignId/archive', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const { campaignId } = request.params as { campaignId: string };
    const result = await db.transaction(async (tx) => {
      const actor = await lockCampaignActor(tx, digest(cookie), campaignId, { strength: 'update' });
      if ('error' in actor) return actor;
      const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
      if (!campaign) return { error: 'NOT_FOUND' } as const;
      if (campaign.ownerId !== actor.userId || actor.role !== 'OWNER') return { error: 'FORBIDDEN' } as const;
      if (campaign.archivedAt) return { error: 'CONFLICT' } as const;
      const [updated] = await tx.update(campaigns).set({ archivedAt: new Date() }).where(and(eq(campaigns.id, campaignId), isNull(campaigns.archivedAt))).returning();
      if (!updated) return { error: 'CONFLICT' } as const;
      await tx.insert(auditEvents).values({ campaignId, actorId: actor.userId, action: 'campaign.archived', targetId: campaignId });
      return { campaign: updated } as const;
    });
    if ('error' in result) return reply.code(result.error === 'UNAUTHENTICATED' ? 401 : result.error === 'NOT_FOUND' ? 404 : result.error === 'CONFLICT' ? 409 : 403).send({ error: result.error });
    archiveCampaignSockets(io, campaignId);
    return { campaign: result.campaign };
  });
  app.put('/api/campaigns/:campaignId/restore', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const { campaignId } = request.params as { campaignId: string };
    const result = await db.transaction(async (tx) => {
      const session = await lockCommandSession(tx, digest(cookie));
      if (!session) return { error: 'UNAUTHENTICATED' } as const;
      const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, campaignId)).for('update').limit(1);
      if (!campaign) return { error: 'NOT_FOUND' } as const;
      const roles = await tx.select({ role: memberships.role }).from(memberships).where(and(eq(memberships.campaignId, campaignId), eq(memberships.userId, session.userId))).for('share').limit(1);
      if (campaign.ownerId !== session.userId || roles[0]?.role !== 'OWNER') return { error: 'FORBIDDEN' } as const;
      if (!campaign.archivedAt) return { error: 'CONFLICT' } as const;
      const [updated] = await tx.update(campaigns).set({ archivedAt: null }).where(and(eq(campaigns.id, campaignId), isNotNull(campaigns.archivedAt))).returning();
      if (!updated) return { error: 'CONFLICT' } as const;
      await tx.insert(auditEvents).values({ campaignId, actorId: session.userId, action: 'campaign.restored', targetId: campaignId });
      return { campaign: updated } as const;
    });
    if ('error' in result) return reply.code(result.error === 'UNAUTHENTICATED' ? 401 : result.error === 'NOT_FOUND' ? 404 : result.error === 'CONFLICT' ? 409 : 403).send({ error: result.error });
    return { campaign: result.campaign };
  });
}

import { and, eq, isNull } from 'drizzle-orm';
import type { Server } from 'socket.io';
import { db } from '../db/index.js';
import { scenes } from '../db/schema.js';
import { sceneObjectProjection } from '../domain/projections.js';
import { canReadSceneLayer } from '../domain/sceneAccess.js';
import { lockObjectLayers, lockSceneObjects } from '../modules/objects/access.js';
import type { ObjectLifecyclePublication } from '../modules/objects/lifecycle.js';
import { campaignDeliveryCandidates, lockCampaignAudience } from './campaignAudience.js';

export async function publishObjectLifecycle(io: Server, publication: ObjectLifecyclePublication) {
  const { campaignId, sceneId, changes, action } = publication;
  if (changes.length === 0) return;
  const { room, candidates } = campaignDeliveryCandidates(io, campaignId);
  if (candidates.length === 0) return;
  await db.transaction(async (tx) => {
    const audience = await lockCampaignAudience(tx, campaignId, candidates);
    if (audience.length === 0) return;
    const [scene] = await tx.select({ isActive: scenes.isActive }).from(scenes)
      .where(and(eq(scenes.id, sceneId), eq(scenes.campaignId, campaignId), isNull(scenes.archivedAt))).for('share').limit(1);
    if (!scene) return;
    const layers = await lockObjectLayers(tx, sceneId, changes.map(({ layerId }) => layerId));
    const current = await lockSceneObjects(tx, sceneId, changes.filter(({ permanent }) => !permanent).map(({ id }) => id), 'share');
    const byId = new Map(current.map((object) => [object.id, object]));
    for (const change of changes) {
      const layer = layers.get(change.layerId);
      if (!layer) continue;
      const object = byId.get(change.id);
      // Stale lifecycle events must not resurrect a newer tombstone or disclose an old layer.
      if (!change.permanent && (!object || object.layerId !== change.layerId || object.version !== change.version ||
        Boolean(object.deletedAt) !== (action === 'delete'))) continue;
      const publicLayer = canReadSceneLayer('PLAYER', scene.isActive, false, layer.visibleToPlayers, layer.kind);
      const isPublic = publicLayer && (action === 'delete' ? change.wasPublic : Boolean(object?.visible));
      const publicObject = object && isPublic ? sceneObjectProjection(object, 'PLAYER') : undefined;
      const privateObject = object && !isPublic ? sceneObjectProjection(object, 'GM') : undefined;
      for (const { socket, role, userId, expiresAt } of audience) {
        if (expiresAt <= Date.now() || !socket.rooms.has(room) || (role === 'PLAYER' && !isPublic)) continue;
        if (action === 'delete') socket.emit('scene:object_deleted', { sceneId, objectId: change.id });
        else if (object) socket.emit('scene:object_created', {
          object: publicObject && role === 'PLAYER' && object.createdBy === userId
            ? { ...publicObject, ownedByMe: true }
            : publicObject ?? privateObject,
        });
      }
    }
  }, { isolationLevel: 'read committed' });
}

import type { Server } from 'socket.io';
import { sceneObjectProjection } from '../domain/projections.js';
import { canReadSceneLayer } from '../domain/sceneAccess.js';
import { lockObjectLayers, lockSceneObjects } from '../modules/objects/access.js';
import type { ObjectLifecyclePublication } from '../modules/objects/lifecycle.js';
import { withSceneAudience } from './campaignAudience.js';

export async function publishObjectLifecycle(io: Server, publication: ObjectLifecyclePublication) {
  const { campaignId, sceneId, changes, action } = publication;
  if (changes.length === 0) return;
  await withSceneAudience(io, campaignId, sceneId, async (tx, scope) => {
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
      const publicLayer = canReadSceneLayer('PLAYER', scope.isActive, false, layer.visibleToPlayers, layer.kind);
      const isPublic = publicLayer && (action === 'delete' ? change.wasPublic : Boolean(object?.visible));
      const publicObject = object && isPublic ? sceneObjectProjection(object, 'PLAYER') : undefined;
      const privateObject = object && !isPublic ? sceneObjectProjection(object, 'GM') : undefined;
      for (const recipient of scope.recipients) {
        const { socket, role, userId } = recipient;
        if (!scope.canSend(recipient) || (role === 'PLAYER' && !isPublic)) continue;
        if (action === 'delete') socket.emit('scene:object_deleted', { sceneId, objectId: change.id });
        else if (object) socket.emit('scene:object_created', {
          object: publicObject && role === 'PLAYER' && object.createdBy === userId
            ? { ...publicObject, ownedByMe: true }
            : publicObject ?? privateObject,
        });
      }
    }
  });
}

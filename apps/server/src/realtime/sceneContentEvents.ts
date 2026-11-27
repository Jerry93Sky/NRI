import { and, eq, inArray } from 'drizzle-orm';
import type { Server } from 'socket.io';
import { sceneLayers, sceneObjects } from '../db/schema.js';
import { sceneObjectProjection } from '../domain/projections.js';
import { canReadSceneLayer } from '../domain/sceneAccess.js';
import { lockObjectLayers, lockSceneObjects } from '../modules/objects/access.js';
import { withSceneAudience } from './campaignAudience.js';

type SceneScope = { campaignId: string; id: string; isActive: boolean };
type Layer = typeof sceneLayers.$inferSelect;
type SceneObject = typeof sceneObjects.$inferSelect;
type ObjectChange = Pick<SceneObject, 'id' | 'layerId' | 'version'> & { wasPublic?: boolean };

export function isPublicLayer(isActive: boolean, layer: Pick<Layer, 'visibleToPlayers' | 'kind'>) {
  return canReadSceneLayer('PLAYER', isActive, false, layer.visibleToPlayers, layer.kind);
}

export async function publishSceneObjects(io: Server, scene: SceneScope, event: 'scene:object_created' | 'scene:object_updated',
  changes: ObjectChange[]) {
  // If an object moved between our discovery and row lock, release and try the lock order once more.
  for (let attempt = 0; attempt < 2; attempt++) {
    const retry = await withSceneAudience(io, scene.campaignId, scene.id, async (tx, scope) => {
      const ids = changes.map(({ id }) => id);
      const previousPublicIds = changes.filter(({ wasPublic }) => wasPublic).map(({ id }) => id);
      const locations = previousPublicIds.length ? await tx.select({ layerId: sceneObjects.layerId }).from(sceneObjects)
        .where(and(eq(sceneObjects.sceneId, scene.id), inArray(sceneObjects.id, previousPublicIds))) : [];
      const layers = await lockObjectLayers(tx, scene.id, [...changes, ...locations].map(({ layerId }) => layerId));
      const rows = await lockSceneObjects(tx, scene.id, ids, 'share');
      const current = new Map(rows.map((object) => [object.id, object]));
      if (rows.some((object) => object.visible && !object.deletedAt && !layers.has(object.layerId) && previousPublicIds.includes(object.id))) return true;
      for (const change of changes) {
        const object = current.get(change.id);
        const layer = object && layers.get(object.layerId);
        const live = object && !object.deletedAt ? object : undefined;
        const publicNow = Boolean(live?.visible && layer && isPublicLayer(scope.isActive, layer));
        const currentRevision = live && layer && live.layerId === change.layerId && live.version === change.version;
        // A stale positive projection is unsafe. A removal may still be needed after a later private edit.
        if (change.wasPublic && scope.isActive && !publicNow) {
          for (const recipient of scope.recipients) {
            if (recipient.role === 'PLAYER' && scope.canSend(recipient)) {
              recipient.socket.emit('scene:object_deleted', { sceneId: scene.id, objectId: change.id });
            }
          }
        }
        if (!currentRevision) continue;
        const manager = sceneObjectProjection(live, 'GM');
        const player = publicNow ? sceneObjectProjection(live, 'PLAYER') : undefined;
        for (const recipient of scope.recipients) {
          if (!scope.canSend(recipient)) continue;
          const { socket, role, userId } = recipient;
          if (role !== 'PLAYER') socket.emit(event, { object: manager });
          else if (player) socket.emit(event, { object: live.createdBy === userId ? { ...player, ownedByMe: true } : player });
        }
      }
      return false;
    });
    if (!retry) return;
  }
}

export async function publishSceneLayer(io: Server, scene: SceneScope, action: 'create' | 'update' | 'delete',
  change: Pick<Layer, 'id' | 'version'> & { wasPublic?: boolean }) {
  await withSceneAudience(io, scene.campaignId, scene.id, async (tx, scope) => {
    const layer = (await lockObjectLayers(tx, scene.id, [change.id])).get(change.id);
    const publicNow = Boolean(layer && isPublicLayer(scope.isActive, layer));
    for (const recipient of scope.recipients) {
      if (!scope.canSend(recipient)) continue;
      const { socket, role } = recipient;
      if (action === 'delete') {
        if (!layer && (role !== 'PLAYER' || (scope.isActive && change.wasPublic))) {
          socket.emit('scene:layer_deleted', { sceneId: scene.id, layerId: change.id });
        }
      } else if (role === 'PLAYER' && !publicNow) {
        if (scope.isActive && change.wasPublic) socket.emit('scene:layer_hidden', { sceneId: scene.id, layerId: change.id });
      } else if (layer?.version === change.version) {
        socket.emit(action === 'create' ? 'scene:layer_created' : 'scene:layer_updated', { sceneId: scene.id, layer });
      }
    }
  });
}

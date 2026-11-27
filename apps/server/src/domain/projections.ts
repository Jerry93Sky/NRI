import { sceneObjects, scenes, tokens } from '../db/schema.js';
import { type CampaignSceneRole } from '../domain/sceneAccess.js';

export function publicToken(token: typeof tokens.$inferSelect, includeHidden = false, viewerUserId?: string) {
  const { hidden: _hidden, resources: _resources, gmNote: _gmNote, ownerNote: _ownerNote, id, sceneId, name, x, y, color, imageAssetId, width, height, rotation, opacity, borderColor, zIndex, locked, showName, version, ownerUserId } = token;
  const result = { id, sceneId, name, x, y, color, imageAssetId, width, height, rotation, opacity, borderColor, zIndex, locked, showName, version, ownerUserId };
  const resources = includeHidden ? token.resources : token.resources.map((resource) => resource.visible ? { label: resource.label, current: resource.current, maximum: resource.maximum } : null);
  if (includeHidden) return { ...result, resources, hidden: token.hidden, gmNote: token.gmNote, ownerNote: token.ownerNote };
  return { ...result, resources, ...(viewerUserId && viewerUserId === token.ownerUserId ? { ownerNote: token.ownerNote } : {}) };
}

export function sceneObjectProjection(object: typeof sceneObjects.$inferSelect, role: CampaignSceneRole, viewerUserId?: string) {
  if (role === 'PLAYER') {
    const { createdBy: _createdBy, ...visibleObject } = object;
    return { ...visibleObject, ownedByMe: Boolean(viewerUserId && object.createdBy === viewerUserId) };
  }
  return object;
}

export const publicScene = (scene: typeof scenes.$inferSelect) => ({ id: scene.id, campaignId: scene.campaignId, title: scene.title, gridSize: scene.gridSize, width: scene.width, height: scene.height, gridColor: scene.gridColor, gridOpacity: scene.gridOpacity, gridOffsetX: scene.gridOffsetX, gridOffsetY: scene.gridOffsetY, gridEnabled: scene.gridEnabled, snapToGrid: scene.snapToGrid, unitsPerCell: scene.unitsPerCell, unitLabel: scene.unitLabel, backgroundAssetId: scene.backgroundAssetId, cameraX: scene.cameraX, cameraY: scene.cameraY, cameraZoom: scene.cameraZoom, version: scene.version });

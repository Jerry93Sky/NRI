import { and, asc, eq, inArray } from 'drizzle-orm';
import { sceneLayers, sceneObjects, scenes } from '../../db/schema.js';
import type { CampaignSceneRole } from '../../domain/sceneAccess.js';
import { lockCampaign, lockCampaignRoles, type Transaction } from '../../security/commandAccess.js';

type SceneAccess =
  | { scene: Pick<typeof scenes.$inferSelect, 'id' | 'campaignId' | 'isActive' | 'archivedAt'>; role: CampaignSceneRole }
  | { error: 'NOT_FOUND' | 'FORBIDDEN' };

export async function lockObjectScene(tx: Transaction, sceneId: string, userId: string): Promise<SceneAccess> {
  const [location] = await tx.select({ campaignId: scenes.campaignId }).from(scenes).where(eq(scenes.id, sceneId)).limit(1);
  if (!location) return { error: 'NOT_FOUND' } as const;
  if (!await lockCampaign(tx, location.campaignId)) return { error: 'FORBIDDEN' } as const;
  const role = (await lockCampaignRoles(tx, location.campaignId, [userId])).get(userId);
  const [scene] = await tx.select({ id: scenes.id, campaignId: scenes.campaignId, isActive: scenes.isActive, archivedAt: scenes.archivedAt })
    .from(scenes).where(and(eq(scenes.id, sceneId), eq(scenes.campaignId, location.campaignId))).for('share').limit(1);
  if (!scene || scene.archivedAt) return { error: 'NOT_FOUND' } as const;
  if (!role) return { error: 'FORBIDDEN' } as const;
  return { scene, role };
}

export async function lockObjectLayers(tx: Transaction, sceneId: string, layerIds: string[]) {
  const rows = await tx.select().from(sceneLayers).where(and(eq(sceneLayers.sceneId, sceneId),
    inArray(sceneLayers.id, [...new Set(layerIds)]))).orderBy(asc(sceneLayers.id)).for('share');
  return new Map(rows.map((layer) => [layer.id, layer]));
}

export function lockSceneObjects(tx: Transaction, sceneId: string, ids: string[], strength: 'share' | 'no key update' | 'update' = 'no key update') {
  return tx.select().from(sceneObjects).where(and(eq(sceneObjects.sceneId, sceneId), inArray(sceneObjects.id, ids)))
    .orderBy(asc(sceneObjects.id)).for(strength);
}

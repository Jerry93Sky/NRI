import { and, eq, isNull } from 'drizzle-orm';
import type { Server } from 'socket.io';
import { scenes } from '../db/schema.js';
import { publicScene } from '../domain/projections.js';
import { withCampaignAudience } from './campaignAudience.js';

export async function publishSceneUpdate(io: Server, campaignId: string, sceneId: string, expectedVersion: number) {
  await withCampaignAudience(io, campaignId, async (tx, audience) => {
    const [scene] = await tx.select().from(scenes).where(and(eq(scenes.id, sceneId), eq(scenes.campaignId, campaignId),
      isNull(scenes.archivedAt), eq(scenes.isActive, true))).for('share').limit(1);
    if (!scene || scene.version !== expectedVersion) return;
    for (const recipient of audience.recipients) {
      if (audience.canSend(recipient)) recipient.socket.emit('scene:updated', { scene: publicScene(scene) });
    }
  });
}

export async function publishSceneActivation(io: Server, campaignId: string) {
  await withCampaignAudience(io, campaignId, async (tx, audience) => {
    const [active] = await tx.select({ id: scenes.id }).from(scenes)
      .where(and(eq(scenes.campaignId, campaignId), eq(scenes.isActive, true), isNull(scenes.archivedAt))).limit(1);
    const event = { campaignId, sceneId: active?.id ?? null };
    for (const recipient of audience.recipients) {
      if (audience.canSend(recipient)) recipient.socket.emit('scene:activated', event);
    }
  });
}

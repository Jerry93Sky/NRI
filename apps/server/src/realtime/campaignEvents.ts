import type { Server } from 'socket.io';
import { eq } from 'drizzle-orm';
import { campaigns } from '../db/schema.js';
import { withCampaignAudience } from './campaignAudience.js';

export async function publishDrawingPermission(io: Server, campaignId: string) {
  await withCampaignAudience(io, campaignId, async (tx, audience) => {
    const [campaign] = await tx.select({ playersCanDraw: campaigns.playersCanDraw }).from(campaigns)
      .where(eq(campaigns.id, campaignId)).for('share').limit(1);
    if (!campaign) return;
    const event = { id: campaignId, playersCanDraw: campaign.playersCanDraw };
    for (const recipient of audience.recipients) {
      if (audience.canSend(recipient)) recipient.socket.emit('campaign:drawing_permission', event);
    }
  });
}

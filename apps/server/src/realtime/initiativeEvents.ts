import type { Server } from 'socket.io';
import { initiativeProjection, readInitiative } from '../modules/initiative/service.js';
import { withCampaignAudience } from './campaignAudience.js';

export async function publishInitiative(io: Server, campaignId: string, expectedVersion?: number) {
  await withCampaignAudience(io, campaignId, async (tx, scope) => {
    const snapshot = await readInitiative(tx, campaignId, expectedVersion);
    if (!snapshot?.tracker) return;
    const players = { ...initiativeProjection(snapshot, false), campaignId };
    const managers = { ...initiativeProjection(snapshot, true), campaignId };
    for (const recipient of scope.recipients) {
      if (!scope.canSend(recipient)) continue;
      // The public event remains available to all campaign subscribers.
      recipient.socket.emit('initiative:updated', players);
      if (recipient.role !== 'PLAYER') recipient.socket.emit('initiative:gm_updated', managers);
    }
  });
}

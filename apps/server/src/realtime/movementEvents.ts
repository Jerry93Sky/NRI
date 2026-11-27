import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Server } from 'socket.io';
import { db } from '../db/index.js';
import { scenes, tokens } from '../db/schema.js';
import { publicToken } from '../domain/projections.js';
import type { CommittedMovement } from '../modules/tokens/movement.js';
import { campaignDeliveryCandidates, lockCampaignAudience } from './campaignAudience.js';

export async function publishMovement(io: Server, movement: CommittedMovement) {
  const { campaignId, sceneId, changes, kind } = movement;
  const { room, candidates } = campaignDeliveryCandidates(io, campaignId);
  if (candidates.length === 0) return;

  await db.transaction(async (tx) => {
    const audience = await lockCampaignAudience(tx, campaignId, candidates);
    if (audience.length === 0) return;
    const [scene] = await tx.select({ isActive: scenes.isActive }).from(scenes)
      .where(and(eq(scenes.id, sceneId), eq(scenes.campaignId, campaignId), isNull(scenes.archivedAt))).for('share').limit(1);
    if (!scene) return;
    const current = await tx.select().from(tokens).where(and(eq(tokens.sceneId, sceneId), isNull(tokens.deletedAt),
      inArray(tokens.id, changes.map(({ tokenId }) => tokenId)))).orderBy(asc(tokens.id)).for('share');
    const currentById = new Map(current.map((token) => [token.id, token]));
    for (const { socket, role, expiresAt } of audience) {
      if (expiresAt <= Date.now() || !socket.rooms.has(room)) continue;
      for (const { tokenId, wasHidden, hidden } of changes) {
        const token = currentById.get(tokenId);
        if (!token) continue;
        if (kind === 'single') {
          if (scene.isActive && !token.hidden) socket.emit('token:moved', publicToken(token));
          else if (role !== 'PLAYER') socket.emit('token:moved', publicToken(token, true));
        } else {
          if (scene.isActive && !token.hidden) socket.emit(wasHidden ? 'token:created' : 'token:updated', publicToken(token));
          else if (scene.isActive && movement.isActive && !wasHidden && hidden) socket.emit('token:hidden', { id: token.id, sceneId });
          if (role !== 'PLAYER') socket.emit('token:updated', publicToken(token, true));
        }
      }
    }
  }, { isolationLevel: 'read committed' });
}

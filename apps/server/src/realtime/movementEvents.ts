import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Server } from 'socket.io';
import { tokens } from '../db/schema.js';
import { publicToken } from '../domain/projections.js';
import type { CommittedMovement } from '../modules/tokens/movement.js';
import { withSceneAudience } from './campaignAudience.js';

export async function publishMovement(io: Server, movement: CommittedMovement) {
  const { campaignId, sceneId, changes, kind } = movement;
  await withSceneAudience(io, campaignId, sceneId, async (tx, scope) => {
    const current = await tx.select().from(tokens).where(and(eq(tokens.sceneId, sceneId), isNull(tokens.deletedAt),
      inArray(tokens.id, changes.map(({ tokenId }) => tokenId)))).orderBy(asc(tokens.id)).for('share');
    const currentById = new Map(current.map((token) => [token.id, token]));
    for (const recipient of scope.recipients) {
      if (!scope.canSend(recipient)) continue;
      const { socket, role } = recipient;
      for (const { tokenId, wasHidden, hidden } of changes) {
        const token = currentById.get(tokenId);
        if (!token) continue;
        if (kind === 'single') {
          if (scope.isActive && !token.hidden) socket.emit('token:moved', publicToken(token));
          else if (role !== 'PLAYER') socket.emit('token:moved', publicToken(token, true));
        } else {
          if (scope.isActive && !token.hidden) socket.emit(wasHidden ? 'token:created' : 'token:updated', publicToken(token));
          else if (scope.isActive && movement.isActive && !wasHidden && hidden) socket.emit('token:hidden', { id: token.id, sceneId });
          if (role !== 'PLAYER') socket.emit('token:updated', publicToken(token, true));
        }
      }
    }
  });
}

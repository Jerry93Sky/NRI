import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Server } from 'socket.io';
import { tokens } from '../db/schema.js';
import { publicToken } from '../domain/projections.js';
import { withSceneAudience } from './campaignAudience.js';

type Change = { id: string; version: number; publication: 'create' | 'update' | 'delete'; wasPublic?: boolean; note?: boolean };

export async function publishTokenState(io: Server, campaignId: string, sceneId: string, changes: Change[]) {
  await withSceneAudience(io, campaignId, sceneId, async (tx, scope) => {
    const rows = await tx.select().from(tokens).where(and(eq(tokens.sceneId, sceneId), inArray(tokens.id, changes.map(({ id }) => id))))
      .orderBy(asc(tokens.id)).for('share');
    const byId = new Map(rows.map((token) => [token.id, token]));
    for (const change of changes) {
      const token = byId.get(change.id);
      if (!token) continue;
      const current = token.version === change.version;
      const publiclyVisible = scope.isActive && !token.hidden && !token.deletedAt;
      const hide = scope.isActive && change.wasPublic && !publiclyVisible;
      const live = current && !token.deletedAt;
      const playerView = publiclyVisible && live ? publicToken(token) : undefined;
      const managerView = live ? publicToken(token, true) : undefined;
      const event = change.publication === 'create' ? 'token:created' : 'token:updated';
      for (const recipient of scope.recipients) {
        const { socket, role, userId } = recipient;
        if (!scope.canSend(recipient)) continue;
        if (role === 'PLAYER') {
          if (hide) socket.emit('token:hidden', { id: token.id, sceneId });
          if (playerView) socket.emit(event, playerView);
        } else if (managerView) socket.emit(event, managerView);
        else if (current && token.deletedAt) socket.emit('token:hidden', { id: token.id, sceneId });

        if (live && publiclyVisible && change.note && token.ownerUserId === userId) {
          socket.emit('token:owner_note', { id: token.id, ownerUserId: userId, ownerNote: token.ownerNote, version: token.version });
        }
      }
    }
  });
}

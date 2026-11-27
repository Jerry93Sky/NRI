import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Server } from 'socket.io';
import { db } from '../db/index.js';
import { scenes, tokens } from '../db/schema.js';
import { publicToken } from '../domain/projections.js';
import type { CommittedMovement } from '../modules/tokens/movement.js';
import { lockCampaign, lockCampaignRoles, lockCommandSessions } from '../security/commandAccess.js';
import type { SocketSession } from './session.js';

export async function publishMovement(io: Server, movement: CommittedMovement) {
  const { campaignId, sceneId, changes, kind } = movement;
  const room = `campaign:${campaignId}`;
  const namespace = io.of('/');
  const candidates = [...(namespace.adapter.rooms.get(room) ?? [])].flatMap((id) => {
    const socket = namespace.sockets.get(id);
    const session = socket?.data.session as SocketSession | undefined;
    return socket && session ? [{ socket, tokenHash: session.tokenHash }] : [];
  });
  if (candidates.length === 0) return;

  // Rooms locate local sockets. PostgreSQL authorizes delivery, including during room eviction.
  await db.transaction(async (tx) => {
    const sessions = new Map((await lockCommandSessions(tx, candidates.map(({ tokenHash }) => tokenHash)))
      .map((session) => [session.tokenHash, session]));
    if (sessions.size === 0 || !await lockCampaign(tx, campaignId)) return;
    const roles = await lockCampaignRoles(tx, campaignId, [...sessions.values()].map(({ userId }) => userId));
    if (roles.size === 0) return;
    const [scene] = await tx.select({ isActive: scenes.isActive }).from(scenes)
      .where(and(eq(scenes.id, sceneId), eq(scenes.campaignId, campaignId), isNull(scenes.archivedAt))).for('share').limit(1);
    if (!scene) return;
    const current = await tx.select().from(tokens).where(and(eq(tokens.sceneId, sceneId), isNull(tokens.deletedAt),
      inArray(tokens.id, changes.map(({ tokenId }) => tokenId)))).orderBy(asc(tokens.id)).for('share');
    const currentById = new Map(current.map((token) => [token.id, token]));
    for (const { socket, tokenHash } of candidates) {
      const session = sessions.get(tokenHash);
      const role = session && roles.get(session.userId);
      if (!session || !role || session.expiresAt.getTime() <= Date.now() || !socket.rooms.has(room)) continue;
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

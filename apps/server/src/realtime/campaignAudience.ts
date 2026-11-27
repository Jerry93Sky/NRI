import type { Server, Socket } from 'socket.io';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { scenes } from '../db/schema.js';
import { lockCampaign, lockCampaignRoles, lockCommandSessions, type Transaction } from '../security/commandAccess.js';
import type { SocketSession } from './session.js';

type Candidate = { socket: Socket; tokenHash: string };

function deliveryCandidates(io: Server, rooms: string[]) {
  const namespace = io.of('/');
  const ids = new Set(rooms.flatMap((room) => [...(namespace.adapter.rooms.get(room) ?? [])]));
  return [...ids].flatMap((id) => {
    const socket = namespace.sockets.get(id);
    const session = socket?.data.session as SocketSession | undefined;
    return socket && session ? [{ socket, tokenHash: session.tokenHash }] : [];
  });
}

export async function lockCampaignAudience(tx: Transaction, campaignId: string, candidates: Candidate[]) {
  // Room membership locates sockets. The database authorizes delivery during concurrent revocation.
  const sessions = new Map((await lockCommandSessions(tx, [...new Set(candidates.map(({ tokenHash }) => tokenHash))]))
    .map((session) => [session.tokenHash, session]));
  if (sessions.size === 0 || !await lockCampaign(tx, campaignId)) return [];
  const roles = await lockCampaignRoles(tx, campaignId, [...new Set([...sessions.values()].map(({ userId }) => userId))]);
  return candidates.flatMap(({ socket, tokenHash }) => {
    const session = sessions.get(tokenHash);
    const role = session && roles.get(session.userId);
    return session && role ? [{ socket, role, userId: session.userId, expiresAt: session.expiresAt.getTime() }] : [];
  });
}

type CampaignAudience = {
  recipients: Awaited<ReturnType<typeof lockCampaignAudience>>;
  canSend: (recipient: CampaignAudience['recipients'][number]) => boolean;
};

export async function withCampaignAudience<T>(io: Server, campaignId: string,
  deliver: (tx: Transaction, scope: CampaignAudience) => Promise<T>, participants?: string[]) {
  const room = `campaign:${campaignId}`;
  const candidates = deliveryCandidates(io, participants ? participants.map((id) => `user:${id}`) : [room]);
  if (candidates.length === 0) return;
  return db.transaction(async (tx) => {
    const audience = await lockCampaignAudience(tx, campaignId, candidates);
    if (audience.length === 0) return;
    // Check immediately before enqueue, while authorization rows are still locked.
    return deliver(tx, { recipients: audience, canSend: ({ socket, userId, expiresAt }) =>
      socket.connected && expiresAt > Date.now() && (participants
        ? participants.includes(userId) && socket.rooms.has(`user:${userId}`)
        : socket.rooms.has(room)) });
  }, { isolationLevel: 'read committed' });
}

export async function withSceneAudience<T>(io: Server, campaignId: string, sceneId: string,
  deliver: (tx: Transaction, scope: CampaignAudience & { isActive: boolean }) => Promise<T>) {
  return withCampaignAudience(io, campaignId, async (tx, scope) => {
    const [scene] = await tx.select({ isActive: scenes.isActive }).from(scenes)
      .where(and(eq(scenes.id, sceneId), eq(scenes.campaignId, campaignId), isNull(scenes.archivedAt))).for('share').limit(1);
    if (!scene) return;
    return deliver(tx, { ...scope, isActive: scene.isActive });
  });
}

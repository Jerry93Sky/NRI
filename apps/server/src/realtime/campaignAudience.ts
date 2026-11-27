import type { Server, Socket } from 'socket.io';
import { lockCampaign, lockCampaignRoles, lockCommandSessions, type Transaction } from '../security/commandAccess.js';
import type { SocketSession } from './session.js';

type Candidate = { socket: Socket; tokenHash: string };

export function campaignDeliveryCandidates(io: Server, campaignId: string) {
  const room = `campaign:${campaignId}`;
  const namespace = io.of('/');
  const candidates = [...(namespace.adapter.rooms.get(room) ?? [])].flatMap((id) => {
    const socket = namespace.sockets.get(id);
    const session = socket?.data.session as SocketSession | undefined;
    return socket && session ? [{ socket, tokenHash: session.tokenHash }] : [];
  });
  return { room, candidates };
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

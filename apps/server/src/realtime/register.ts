import { Server } from 'socket.io';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { webOrigins } from '../config/runtime.js';
import { db } from '../db/index.js';
import { moveToken } from '../modules/tokens/movement.js';
import { authenticateRealtime, type SocketSession } from './session.js';
import { publishMovement } from './movementEvents.js';
import { campaignMemberRoom, leaveCampaign } from './campaignRooms.js';
import { guardCommands } from './commandGuard.js';
import { rollDice, sendChat } from '../modules/chat/commands.js';
import { publishChat, publishRoll } from './chatDiceEvents.js';
import { withSceneAudience } from './campaignAudience.js';
import { lockCampaignActor } from '../security/commandAccess.js';

export function registerRealtime(server: FastifyInstance['server'], logger: FastifyInstance['log']) {
  const io = new Server(server, { serveClient: false, maxHttpBufferSize: 64 * 1024, cors: { origin: webOrigins, credentials: true }, allowRequest: (request, callback) => { const origin = request.headers.origin; callback(null, !origin || webOrigins.includes(origin)); } });
  authenticateRealtime(io);
  io.on('connection', (socket) => {
    guardCommands(socket);
    const user = socket.data.user as { id: string; displayName: string };
    let lastPointerAt = 0;
    const joins = new Map<string, symbol>();
    socket.on('campaign:join', async (campaignId: string, callback?: (result: unknown) => void) => {
      if (typeof campaignId !== 'string' || !z.uuid().safeParse(campaignId).success) return callback?.({ error: 'INVALID' });
      campaignId = campaignId.toLowerCase();
      const attempt = Symbol();
      joins.set(campaignId, attempt);
      try {
        const { tokenHash } = socket.data.session as SocketSession;
        const result = await db.transaction(async (tx) => {
          const actor = await lockCampaignActor(tx, tokenHash, campaignId);
          if ('error' in actor || actor.userId !== user.id) return { error: 'FORBIDDEN' } as const;
          if (joins.get(campaignId) !== attempt || !socket.connected) return { error: 'JOIN_CANCELLED' } as const;
          const room = `campaign:${campaignId}`;
          const rooms = [room, campaignMemberRoom(campaignId, user.id)];
          if (actor.role === 'PLAYER') await socket.leave(`${room}:gm`);
          else rooms.push(`${room}:gm`);
          await socket.join(rooms);
          if (!socket.connected) return { error: 'JOIN_CANCELLED' } as const;
          return { role: actor.role } as const;
        });
        if ('error' in result) {
          if (result.error === 'FORBIDDEN') leaveCampaign(socket, campaignId, user.id);
          return callback?.({ error: result.error });
        }
        socket.to(`campaign:${campaignId}`).emit('presence:joined', { userId: user.id, displayName: user.displayName });
        callback?.({ ok: true, role: result.role });
      } catch {
        callback?.({ error: 'INTERNAL_ERROR' });
      } finally {
        if (joins.get(campaignId) === attempt) joins.delete(campaignId);
      }
    });
    socket.on('campaign:leave', (campaignId: string) => {
      if (typeof campaignId !== 'string' || !z.uuid().safeParse(campaignId).success) return;
      campaignId = campaignId.toLowerCase();
      joins.delete(campaignId);
      leaveCampaign(socket, campaignId, user.id);
    });
    socket.on('scene:pointer', async (raw: unknown, callback?: (result: unknown) => void) => {
      try {
        const input = z.object({ campaignId: z.uuid().transform((id) => id.toLowerCase()), sceneId: z.uuid().transform((id) => id.toLowerCase()),
          x: z.number().finite().min(0).max(16384), y: z.number().finite().min(0).max(16384) }).parse(raw);
        if (!socket.rooms.has(`campaign:${input.campaignId}`)) return callback?.({ error: 'FORBIDDEN' });
        const now = Date.now();
        if (now - lastPointerAt < 50) return callback?.({ error: 'RATE_LIMITED' });
        const accepted = await withSceneAudience(io, input.campaignId, input.sceneId, async (_tx, audience) => {
          const actor = audience.recipients.find((recipient) => recipient.socket === socket && recipient.userId === user.id);
          if (!actor || !audience.canSend(actor) || (actor.role === 'PLAYER' && !audience.isActive)) return false;
          if (input.x > audience.width || input.y > audience.height) return 'INVALID' as const;
          const payload = { sceneId: input.sceneId, pointerId: socket.id, userId: user.id, displayName: user.displayName, x: input.x, y: input.y };
          for (const recipient of audience.recipients) {
            if (!audience.canSend(recipient) || recipient.socket === socket) continue;
            if (!audience.isActive && recipient.role === 'PLAYER') continue;
            recipient.socket.emit('scene:pointer', payload);
          }
          return true;
        });
        if (accepted === 'INVALID') return callback?.({ error: 'INVALID' });
        if (!accepted) return callback?.({ error: 'FORBIDDEN' });
        lastPointerAt = now;
        callback?.({ ok: true });
      } catch { callback?.({ error: 'INVALID' }); }
    });
    socket.on('token:move', async (raw: unknown, callback?: (result: unknown) => void) => {
      try {
        const { tokenHash } = socket.data.session as SocketSession;
        const result = await moveToken(tokenHash, raw, (campaignId) => socket.connected && socket.rooms.has(`campaign:${campaignId}`));
        if ('error' in result) return callback?.(result);

        callback?.({ ok: true, token: result.projections[0] });
        void publishMovement(io, result).catch(() => logger.error('Committed token movement could not be published'));
      } catch { callback?.({ error: 'INTERNAL_ERROR' }); }
    });
    const joined = (campaignId: string) => socket.connected && socket.rooms.has(`campaign:${campaignId}`);
    socket.on('chat:send', async (raw: unknown, callback?: (result: unknown) => void) => {
      try {
        const { tokenHash } = socket.data.session as SocketSession;
        const result = await sendChat(tokenHash, raw, joined);
        if ('error' in result) return callback?.({ error: result.error });
        await publishChat(io, result.message, user.displayName, socket, callback);
      } catch { callback?.({ error: 'INTERNAL_ERROR' }); }
    });
    socket.on('dice:roll', async (raw: unknown, callback?: (result: unknown) => void) => {
      try {
        const { tokenHash } = socket.data.session as SocketSession;
        const result = await rollDice(tokenHash, raw, joined);
        if ('error' in result) return callback?.({ error: result.error });
        await publishRoll(io, result.roll, user.displayName, socket, callback);
      } catch { callback?.({ error: 'INTERNAL_ERROR' }); }
    });
  });
  return io;
}

import { Server } from 'socket.io';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { scenes } from '../db/schema.js';
import type { FastifyInstance } from 'fastify';
import { webOrigins } from '../config/runtime.js';
import { roleFor } from '../security/access.js';
import { moveToken } from '../modules/tokens/movement.js';
import { authenticateRealtime, type SocketSession } from './session.js';
import { publishMovement } from './movementEvents.js';
import { campaignMemberRoom, leaveCampaign } from './campaignRooms.js';
import { guardCommands } from './commandGuard.js';
import { rollDice, sendChat } from '../modules/chat/commands.js';
import { publishChat, publishRoll } from './chatDiceEvents.js';

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
        const role = await roleFor(campaignId, user.id);
        if (joins.get(campaignId) !== attempt || !socket.connected) return callback?.({ error: 'JOIN_CANCELLED' });
        if (!role) {
          leaveCampaign(socket, campaignId, user.id);
          return callback?.({ error: 'FORBIDDEN' });
        }
        const room = `campaign:${campaignId}`;
        const rooms = [room, campaignMemberRoom(campaignId, user.id)];
        if (role === 'PLAYER') void socket.leave(`${room}:gm`);
        else rooms.push(`${room}:gm`);
        void socket.join(rooms);
        callback?.({ ok: true, role });
        socket.to(room).emit('presence:joined', { userId: user.id, displayName: user.displayName });
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
        const input = z.object({ campaignId: z.uuid(), sceneId: z.uuid(), x: z.number().finite().min(0).max(16384), y: z.number().finite().min(0).max(16384) }).parse(raw);
        if (!socket.rooms.has(`campaign:${input.campaignId}`)) return callback?.({ error: 'FORBIDDEN' });
        const now = Date.now();
        if (now - lastPointerAt < 50) return callback?.({ error: 'RATE_LIMITED' });
        lastPointerAt = now;
        const role = await roleFor(input.campaignId, user.id);
        const [scene] = await db.select().from(scenes).where(and(eq(scenes.id, input.sceneId), eq(scenes.campaignId, input.campaignId))).limit(1);
        if (!role || !scene || scene.archivedAt || (role === 'PLAYER' && !scene.isActive)) return callback?.({ error: 'FORBIDDEN' });
        if (input.x > scene.width || input.y > scene.height) return callback?.({ error: 'INVALID' });
        const room = scene.isActive ? `campaign:${input.campaignId}` : `campaign:${input.campaignId}:gm`;
        socket.to(room).emit('scene:pointer', { sceneId: scene.id, pointerId: socket.id, userId: user.id, displayName: user.displayName, x: input.x, y: input.y });
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

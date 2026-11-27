import { Server } from 'socket.io';
import { randomInt } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { diceSchema, parseDiceExpression } from '@nri/contracts';
import { db } from '../db/index.js';
import { diceRolls, messages, scenes } from '../db/schema.js';
import type { FastifyInstance } from 'fastify';
import { webOrigins } from '../config/runtime.js';
import { roleFor } from '../security/access.js';
import { moveToken } from '../modules/tokens/movement.js';
import { authenticateRealtime, type SocketSession } from './session.js';
import { publishMovement } from './movementEvents.js';
import { campaignMemberRoom, leaveCampaign } from './campaignRooms.js';
import { guardCommands } from './commandGuard.js';

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
    socket.on('chat:send', async (raw: unknown, callback?: (result: unknown) => void) => {
      try {
        const input = z.object({ campaignId: z.uuid(), body: z.string().trim().min(1).max(2000), recipientId: z.uuid().nullable().optional() }).parse(raw);
        const role = await roleFor(input.campaignId, user.id);
        if (!role || !socket.rooms.has(`campaign:${input.campaignId}`)) return callback?.({ error: 'FORBIDDEN' });
        if (input.recipientId) {
          const recipientRole = await roleFor(input.campaignId, input.recipientId);
          if (!recipientRole || (role === 'PLAYER' && !['OWNER', 'GM'].includes(recipientRole))) return callback?.({ error: 'FORBIDDEN' });
        }
        const [message] = await db.insert(messages).values({ campaignId: input.campaignId, senderId: user.id, recipientId: input.recipientId ?? null, body: input.body }).returning();
        if (!message) throw new Error('Message creation failed');
        const event = { id: message.id, campaignId: input.campaignId, senderId: user.id, displayName: user.displayName, body: message.body, createdAt: message.createdAt, private: Boolean(input.recipientId) };
        callback?.({ ok: true, message: event });
        if (!input.recipientId) io.to(`campaign:${input.campaignId}`).emit('chat:message', event);
        else {
          io.to(`user:${user.id}`).emit('chat:private', event);
          io.to(`user:${input.recipientId}`).emit('chat:private', event);
        }
      } catch { callback?.({ error: 'INVALID' }); }
    });
    socket.on('dice:roll', async (raw: unknown, callback?: (result: unknown) => void) => {
      try {
        const input = z.object({ campaignId: z.uuid(), ...diceSchema.shape }).parse(raw);
        const role = await roleFor(input.campaignId, user.id);
        if (!socket.rooms.has(`campaign:${input.campaignId}`) || !role || (input.hidden && role === 'PLAYER')) return callback?.({ error: 'FORBIDDEN' });
        const parsed = parseDiceExpression(input.expression);
        if (!parsed) return callback?.({ error: 'INVALID' });
        const { count, sides, modifier } = parsed;
        const rolls = Array.from({ length: count }, () => randomInt(1, sides + 1));
        const result = rolls.reduce((sum, value) => sum + value, modifier);
        const [saved] = await db.insert(diceRolls).values({ campaignId: input.campaignId, userId: user.id, expression: input.expression, result, detail: JSON.stringify({ rolls, modifier }), hidden: input.hidden }).returning();
        const event = { id: saved?.id, campaignId: input.campaignId, userId: user.id, displayName: user.displayName, expression: input.expression, rolls, modifier, result, hidden: input.hidden };
        callback?.({ ok: true, roll: event });
        io.to(input.hidden ? `campaign:${input.campaignId}:gm` : `campaign:${input.campaignId}`).emit('dice:result', event);
      } catch { callback?.({ error: 'INVALID' }); }
    });
  });
  return io;
}

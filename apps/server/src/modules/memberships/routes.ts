import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { inviteSchema } from '@nri/contracts';
import { db } from '../../db/index.js';
import { auditEvents, campaigns, invitations, memberships, users } from '../../db/schema.js';
import type { FastifyInstance } from 'fastify';
import type { Server } from 'socket.io';
import { cookieName } from '../../config/runtime.js';
import { digest, parseBody } from '../../security/access.js';
import { commandSessionIsActive, lockCampaign, lockCampaignActor, lockCampaignRoles, lockCommandSession } from '../../security/commandAccess.js';
import { campaignMemberRoom } from '../../realtime/campaignRooms.js';

const errorStatus = { UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, INVALID: 404 } as const;

export function registerMembershipRoutes(app: FastifyInstance, io: Server) {
  app.post('/api/invitations', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const input = parseBody(inviteSchema, request.body);
    const token = randomBytes(32).toString('base64url');
    const tokenHash = digest(token);
    const expiresAt = new Date(Date.now() + input.expiresInHours * 3600000);
    const result = await db.transaction(async (tx) => {
      const actor = await lockCampaignActor(tx, digest(cookie), input.campaignId);
      if ('error' in actor) return actor;
      if (actor.role !== 'OWNER' && actor.role !== 'GM') return { error: 'FORBIDDEN' } as const;
      const [invite] = await tx.insert(invitations).values({ campaignId: input.campaignId, tokenHash, creatorId: actor.userId, expiresAt }).returning({ id: invitations.id });
      if (!invite) throw new Error('Invitation creation failed');
      await tx.insert(auditEvents).values({ campaignId: input.campaignId, actorId: actor.userId, action: 'invitation.created', targetId: invite.id });
      return { id: invite.id } as const;
    });
    if ('error' in result) return reply.code(errorStatus[result.error]).send({ error: result.error });
    return reply.code(201).send({ id: result.id, invitation: token, expiresAt, remainingUses: 7 });
  });

  app.post('/api/invitations/:token/accept', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const { token } = request.params as { token: string };
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return reply.code(404).send({ error: 'NOT_FOUND' });
    const tokenHash = digest(token);
    const result = await db.transaction(async (tx) => {
      const session = await lockCommandSession(tx, digest(cookie));
      if (!session) return { error: 'UNAUTHENTICATED' } as const;
      const [locator] = await tx.select({ id: invitations.id, campaignId: invitations.campaignId, creatorId: invitations.creatorId })
        .from(invitations).where(eq(invitations.tokenHash, tokenHash)).limit(1);
      if (!locator || !await lockCampaign(tx, locator.campaignId, 'update')) return { error: 'INVALID' } as const;
      const roles = await lockCampaignRoles(tx, locator.campaignId, [session.userId, locator.creatorId]);
      const creatorRole = roles.get(locator.creatorId);
      if (creatorRole !== 'OWNER' && creatorRole !== 'GM') return { error: 'INVALID' } as const;
      const [invite] = await tx.select().from(invitations).where(and(eq(invitations.id, locator.id), isNull(invitations.revokedAt), gt(invitations.expiresAt, sql`clock_timestamp()`)))
        .for('update').limit(1);
      if (!invite || invite.uses >= invite.maxUses) return { error: 'INVALID' } as const;
      const [existing] = await tx.select({ userId: memberships.userId }).from(memberships)
        .where(and(eq(memberships.campaignId, invite.campaignId), eq(memberships.userId, session.userId))).for('share').limit(1);
      if (existing) return { campaignId: invite.campaignId } as const;
      const [claimed] = await tx.update(invitations).set({ uses: sql`${invitations.uses} + 1`, acceptedAt: invite.acceptedAt ?? sql`clock_timestamp()` })
        .where(and(eq(invitations.id, invite.id), eq(invitations.uses, invite.uses), lt(invitations.uses, invitations.maxUses), isNull(invitations.revokedAt), gt(invitations.expiresAt, sql`clock_timestamp()`)))
        .returning({ id: invitations.id });
      if (!claimed) return { error: 'INVALID' } as const;
      const [membership] = await tx.insert(memberships).values({ campaignId: invite.campaignId, userId: session.userId, role: 'PLAYER' })
        .onConflictDoNothing().returning({ userId: memberships.userId });
      if (!membership) return { error: 'CONFLICT' } as const;
      await tx.insert(auditEvents).values({ campaignId: invite.campaignId, actorId: session.userId, action: 'invitation.accepted', targetId: invite.id });
      return { campaignId: invite.campaignId } as const;
    });
    if ('error' in result) return reply.code(errorStatus[result.error]).send({ error: result.error === 'INVALID' ? 'INVITATION_INVALID' : result.error });
    return { campaignId: result.campaignId };
  });

  app.delete('/api/invitations/:invitationId', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const { invitationId } = request.params as { invitationId: string };
    const result = await db.transaction(async (tx) => {
      const session = await lockCommandSession(tx, digest(cookie));
      if (!session) return { error: 'UNAUTHENTICATED' } as const;
      const [locator] = await tx.select({ campaignId: invitations.campaignId }).from(invitations).where(eq(invitations.id, invitationId)).limit(1);
      if (!locator) return { error: 'NOT_FOUND' } as const;
      const actor = await lockCampaignActor(tx, digest(cookie), locator.campaignId, { strength: 'update' });
      if ('error' in actor) return actor;
      if (actor.userId !== session.userId || (actor.role !== 'OWNER' && actor.role !== 'GM')) return { error: 'FORBIDDEN' } as const;
      const [invite] = await tx.select().from(invitations).where(and(eq(invitations.id, invitationId), eq(invitations.campaignId, locator.campaignId))).for('update').limit(1);
      if (!invite) return { error: 'NOT_FOUND' } as const;
      if (invite.revokedAt) return { error: 'CONFLICT' } as const;
      const [revoked] = await tx.update(invitations).set({ revokedAt: sql`clock_timestamp()` }).where(and(eq(invitations.id, invitationId), isNull(invitations.revokedAt))).returning({ id: invitations.id });
      if (!revoked) return { error: 'CONFLICT' } as const;
      await tx.insert(auditEvents).values({ campaignId: locator.campaignId, actorId: actor.userId, action: 'invitation.revoked', targetId: invitationId });
      return { ok: true } as const;
    });
    if ('error' in result) return reply.code(errorStatus[result.error]).send({ error: result.error });
    return reply.code(204).send();
  });

  app.get('/api/campaigns/:campaignId/members', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const { campaignId } = request.params as { campaignId: string };
    const result = await db.transaction(async (tx) => {
      const actor = await lockCampaignActor(tx, digest(cookie), campaignId);
      if ('error' in actor) return actor;
      const rows = await tx.select({ userId: users.id, displayName: users.displayName, role: memberships.role }).from(memberships)
        .innerJoin(users, eq(memberships.userId, users.id)).where(eq(memberships.campaignId, campaignId));
      if (!await commandSessionIsActive(tx, digest(cookie))) return { error: 'UNAUTHENTICATED' } as const;
      return { rows } as const;
    });
    if ('error' in result) return reply.code(errorStatus[result.error]).send({ error: result.error });
    return result.rows;
  });

  app.post('/api/campaigns/:campaignId/members/:memberId/role', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const { campaignId, memberId } = request.params as { campaignId: string; memberId: string };
    const input = parseBody(z.object({ role: z.enum(['GM', 'PLAYER']) }), request.body);
    const result = await db.transaction(async (tx) => {
      const actor = await lockCampaignActor(tx, digest(cookie), campaignId, { strength: 'update' });
      if ('error' in actor) return actor;
      const [campaign] = await tx.select({ ownerId: campaigns.ownerId }).from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
      if (!campaign) return { error: 'NOT_FOUND' } as const;
      if (campaign.ownerId !== actor.userId || actor.role !== 'OWNER' || memberId === campaign.ownerId) return { error: 'FORBIDDEN' } as const;
      const [membership] = await tx.select().from(memberships).where(and(eq(memberships.campaignId, campaignId), eq(memberships.userId, memberId))).for('update').limit(1);
      if (!membership) return { error: 'NOT_FOUND' } as const;
      const [updated] = await tx.update(memberships).set({ role: input.role }).where(and(eq(memberships.campaignId, campaignId), eq(memberships.userId, memberId))).returning();
      if (!updated) return { error: 'NOT_FOUND' } as const;
      await tx.insert(auditEvents).values({ campaignId, actorId: actor.userId, action: 'membership.role_changed', targetId: memberId });
      return { membership: updated } as const;
    });
    if ('error' in result) return reply.code(errorStatus[result.error]).send({ error: result.error });
    const room = `campaign:${campaignId}`;
    const memberRoom = io.in(campaignMemberRoom(campaignId, memberId));
    if (input.role === 'GM') memberRoom.socketsJoin(`${room}:gm`);
    else memberRoom.socketsLeave(`${room}:gm`);
    io.in(room).emit('membership:changed', { campaignId, userId: memberId });
    return { membership: result.membership };
  });

  app.delete('/api/campaigns/:campaignId/members/:memberId', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const { campaignId, memberId } = request.params as { campaignId: string; memberId: string };
    const result = await db.transaction(async (tx) => {
      const actor = await lockCampaignActor(tx, digest(cookie), campaignId, { strength: 'update' });
      if ('error' in actor) return actor;
      const [campaign] = await tx.select({ ownerId: campaigns.ownerId }).from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
      if (!campaign) return { error: 'NOT_FOUND' } as const;
      if (campaign.ownerId !== actor.userId || actor.role !== 'OWNER' || memberId === campaign.ownerId) return { error: 'FORBIDDEN' } as const;
      const [membership] = await tx.delete(memberships).where(and(eq(memberships.campaignId, campaignId), eq(memberships.userId, memberId))).returning();
      if (!membership) return { error: 'NOT_FOUND' } as const;
      await tx.insert(auditEvents).values({ campaignId, actorId: actor.userId, action: 'membership.removed', targetId: memberId });
      return { ok: true } as const;
    });
    if ('error' in result) return reply.code(errorStatus[result.error]).send({ error: result.error });
    io.in(`user:${memberId}`).emit('membership:removed', { userId: memberId, campaignId });
    io.in(`user:${memberId}`).socketsLeave(`campaign:${campaignId}`);
    io.in(`user:${memberId}`).socketsLeave(`campaign:${campaignId}:gm`);
    const memberRoom = campaignMemberRoom(campaignId, memberId);
    io.in(memberRoom).socketsLeave(memberRoom);
    return reply.code(204).send();
  });
}

import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import { z } from 'zod';
import { inviteSchema } from '@nri/contracts';
import { db } from '../../db/index.js';
import { auditEvents, campaigns, invitations, memberships, users } from '../../db/schema.js';
import type { FastifyInstance } from 'fastify';
import type { Server } from 'socket.io';
import { digest, parseBody, requireUser, roleFor } from '../../security/access.js';
import { campaignMemberRoom } from '../../realtime/campaignRooms.js';

export function registerMembershipRoutes(app: FastifyInstance, io: Server) {
  app.post('/api/invitations', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const input = parseBody(inviteSchema, request.body);
    const role = await roleFor(input.campaignId, user.id);
    if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + input.expiresInHours * 3600000);
    const [invite] = await db.insert(invitations).values({ campaignId: input.campaignId, tokenHash: digest(token), creatorId: user.id, expiresAt }).returning({ id: invitations.id });
    return reply.code(201).send({ id: invite?.id, invitation: token, expiresAt, remainingUses: 7 });
  });
  app.post('/api/invitations/:token/accept', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { token } = request.params as { token: string };
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return reply.code(404).send({ error: 'NOT_FOUND' });
    const campaignId = await db.transaction(async (tx) => {
      const [invite] = await tx.select({ invitation: invitations }).from(invitations).innerJoin(campaigns, eq(invitations.campaignId, campaigns.id)).where(and(eq(invitations.tokenHash, digest(token)), gt(invitations.expiresAt, new Date()), isNull(invitations.revokedAt), isNull(campaigns.archivedAt))).limit(1);
      const invitation = invite?.invitation;
      if (!invitation) return null;
      const [existing] = await tx.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.campaignId, invitation.campaignId), eq(memberships.userId, user.id))).limit(1);
      if (existing) return invitation.campaignId;
      const [claimed] = await tx.update(invitations).set({ uses: invitation.uses + 1, acceptedAt: invitation.acceptedAt ?? new Date() }).where(and(eq(invitations.id, invitation.id), eq(invitations.uses, invitation.uses), lt(invitations.uses, invitation.maxUses), isNull(invitations.revokedAt), gt(invitations.expiresAt, new Date()))).returning({ id: invitations.id });
      if (!claimed) return null;
      await tx.insert(memberships).values({ campaignId: invitation.campaignId, userId: user.id, role: 'PLAYER' }).onConflictDoNothing();
      await tx.insert(auditEvents).values({ campaignId: invitation.campaignId, actorId: user.id, action: 'invitation.accepted', targetId: invitation.id });
      return invitation.campaignId;
    });
    if (!campaignId) return reply.code(404).send({ error: 'INVITATION_INVALID' });
    return { campaignId };
  });
  app.delete('/api/invitations/:invitationId', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { invitationId } = request.params as { invitationId: string };
    const [invite] = await db.select().from(invitations).where(eq(invitations.id, invitationId)).limit(1);
    if (!invite) return reply.code(404).send({ error: 'NOT_FOUND' });
    const role = await roleFor(invite.campaignId, user.id);
    if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
    await db.update(invitations).set({ revokedAt: new Date() }).where(and(eq(invitations.id, invitationId), isNull(invitations.revokedAt)));
    await db.insert(auditEvents).values({ campaignId: invite.campaignId, actorId: user.id, action: 'invitation.revoked', targetId: invitationId });
    return reply.code(204).send();
  });
  app.get('/api/campaigns/:campaignId/members', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { campaignId } = request.params as { campaignId: string };
    if (!await roleFor(campaignId, user.id)) return reply.code(404).send({ error: 'NOT_FOUND' });
    return db.select({ userId: users.id, displayName: users.displayName, role: memberships.role }).from(memberships).innerJoin(users, eq(memberships.userId, users.id)).where(eq(memberships.campaignId, campaignId));
  });
  app.post('/api/campaigns/:campaignId/members/:memberId/role', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { campaignId, memberId } = request.params as { campaignId: string; memberId: string };
    const input = parseBody(z.object({ role: z.enum(['GM', 'PLAYER']) }), request.body);
    const [campaign] = await db.select({ ownerId: campaigns.ownerId }).from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
    if (!campaign) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (campaign.ownerId !== user.id || memberId === campaign.ownerId) return reply.code(403).send({ error: 'FORBIDDEN' });
    const updated = await db.transaction(async (tx) => {
      const [membership] = await tx.update(memberships).set({ role: input.role }).where(and(eq(memberships.campaignId, campaignId), eq(memberships.userId, memberId))).returning();
      if (membership) await tx.insert(auditEvents).values({ campaignId, actorId: user.id, action: 'membership.role_changed', targetId: memberId });
      return membership;
    });
    if (!updated) return reply.code(404).send({ error: 'NOT_FOUND' });
    const room = `campaign:${campaignId}`;
    const member = io.in(campaignMemberRoom(campaignId, memberId));
    if (input.role === 'GM') member.socketsJoin(`${room}:gm`);
    else member.socketsLeave(`${room}:gm`);
    io.in(room).emit('membership:changed', { campaignId, userId: memberId, role: input.role });
    return { membership: updated };
  });
  app.delete('/api/campaigns/:campaignId/members/:memberId', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { campaignId, memberId } = request.params as { campaignId: string; memberId: string };
    const [campaign] = await db.select({ ownerId: campaigns.ownerId }).from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
    if (!campaign) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (campaign.ownerId !== user.id || memberId === campaign.ownerId) return reply.code(403).send({ error: 'FORBIDDEN' });
    const removed = await db.transaction(async (tx) => {
      const [membership] = await tx.delete(memberships).where(and(eq(memberships.campaignId, campaignId), eq(memberships.userId, memberId))).returning();
      if (membership) await tx.insert(auditEvents).values({ campaignId, actorId: user.id, action: 'membership.removed', targetId: memberId });
      return membership;
    });
    if (!removed) return reply.code(404).send({ error: 'NOT_FOUND' });
    io.in(`user:${memberId}`).emit('membership:removed', { userId: memberId, campaignId });
    io.in(`user:${memberId}`).socketsLeave(`campaign:${campaignId}`);
    io.in(`user:${memberId}`).socketsLeave(`campaign:${campaignId}:gm`);
    const memberRoom = campaignMemberRoom(campaignId, memberId);
    io.in(memberRoom).socketsLeave(memberRoom);
    return reply.code(204).send();
  });
}

import { config } from 'dotenv';
config({ path: '../../.env' });
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { Server } from 'socket.io';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import argon2 from 'argon2';
import { and, asc, desc, eq, gt, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { canMoveToken, createCampaignSchema, createSceneLayerSchema, createSceneObjectSchema, createSceneSchema, createTokenSchema, diceSchema, inviteSchema, loginSchema, moveTokenSchema, parseDiceExpression, registerSchema, updateSceneLayerSchema, updateSceneObjectSchema } from '@nri/contracts';
import { db, pool } from './db/index.js';
import { assets, auditEvents, campaigns, diceRolls, initiativeEntries, initiatives, invitations, memberships, messages, sceneLayers, sceneObjects, scenes, sessions, tokens, users } from './db/schema.js';
import { canListScene, canReadSceneLayer, canReadSceneTokens, type CampaignSceneRole } from './domain/sceneAccess.js';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers.set-cookie'] }, bodyLimit: 64 * 1024 });
await app.register(cookie);
await app.register(rateLimit, { global: true, max: 120, timeWindow: '1 minute' });
await app.register(import('@fastify/multipart'), { limits: { files: 1, fileSize: 12 * 1024 * 1024, fields: 0 } });
const port = Number(process.env.PORT ?? 3000);
const isProduction = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET ?? '';
if (isProduction && sessionSecret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters in production');
if (!isProduction && sessionSecret.length < 24) app.log.warn('Set a unique SESSION_SECRET in .env before local use.');
const cookieName = 'nri_session';
const uploadDirectory = resolve(process.cwd(), '../..', process.env.UPLOAD_DIR ?? '.data/uploads');
const webOrigins = (process.env.WEB_ORIGIN ?? 'http://localhost:5173,http://127.0.0.1:5173').split(',').map((origin) => origin.trim()).filter(Boolean);
const cookieOptions = { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: isProduction, maxAge: 60 * 60 * 24 * 14 };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const publicUser = (user: { id: string; email: string; displayName: string }) => ({ id: user.id, email: user.email, displayName: user.displayName });
const publicScene = (scene: typeof scenes.$inferSelect) => ({ id: scene.id, campaignId: scene.campaignId, title: scene.title, gridSize: scene.gridSize, width: scene.width, height: scene.height, gridColor: scene.gridColor, gridOpacity: scene.gridOpacity, gridOffsetX: scene.gridOffsetX, gridOffsetY: scene.gridOffsetY, gridEnabled: scene.gridEnabled, snapToGrid: scene.snapToGrid, unitsPerCell: scene.unitsPerCell, unitLabel: scene.unitLabel, backgroundAssetId: scene.backgroundAssetId, cameraX: scene.cameraX, cameraY: scene.cameraY, cameraZoom: scene.cameraZoom, version: scene.version });
const baseLayerKinds = ['BACKGROUND', 'OBJECTS', 'TOKENS', 'GM'] as const;
const defaultLayerRows = [
  { name: 'Background', kind: 'BACKGROUND', sortOrder: 0, visibleToPlayers: true, locked: true },
  { name: 'Objects', kind: 'OBJECTS', sortOrder: 1, visibleToPlayers: true, locked: false },
  { name: 'Tokens', kind: 'TOKENS', sortOrder: 2, visibleToPlayers: true, locked: false },
  { name: 'GM', kind: 'GM', sortOrder: 3, visibleToPlayers: false, locked: false },
] as const;

async function userForCookie(cookieValue?: string) {
  if (!cookieValue) return null;
  const rows = await db.select({ user: users }).from(sessions).innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.tokenHash, digest(cookieValue)), gt(sessions.expiresAt, new Date()))).limit(1);
  return rows[0]?.user ?? null;
}
async function requireUser(request: { cookies: Record<string, string | undefined> }, reply: { code: (status: number) => { send: (value: unknown) => unknown } }) {
  const user = await userForCookie(request.cookies[cookieName]);
  if (!user) { reply.code(401).send({ error: 'UNAUTHENTICATED' }); return null; }
  return user;
}
async function roleFor(campaignId: string, userId: string): Promise<CampaignSceneRole | null> {
  const [membership] = await db.select({ role: memberships.role }).from(memberships).innerJoin(campaigns, eq(memberships.campaignId, campaigns.id)).where(and(eq(memberships.campaignId, campaignId), eq(memberships.userId, userId), isNull(campaigns.archivedAt))).limit(1);
  const role = membership?.role;
  return role === 'OWNER' || role === 'GM' || role === 'PLAYER' ? role : null;
}
function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw Object.assign(new Error('Invalid request'), { statusCode: 400, code: 'INVALID' });
  return result.data;
}
app.setErrorHandler((error, _request, reply) => {
  const status = (error as { statusCode?: number }).statusCode ?? 500;
  if (status >= 500) app.log.error({ err: error }, 'Request failed');
  const code = status >= 500 ? 'INTERNAL_ERROR' : status === 429 ? 'RATE_LIMITED' : (error as { code?: string }).code ?? 'INVALID';
  reply.code(status).send({ error: code });
});
app.addHook('onRequest', async (request, reply) => {
  const origin = request.headers.origin;
  if (origin && !webOrigins.includes(origin)) return reply.code(403).send({ error: 'ORIGIN_REJECTED' });
});

app.get('/api/health', async () => ({ status: 'ok' }));
app.get('/api/ready', async (_request, reply) => {
  try { await pool.query('select 1'); return { status: 'ready' }; }
  catch { return reply.code(503).send({ status: 'not_ready' }); }
});

app.post('/api/auth/register', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (request, reply) => {
  const input = parseBody(registerSchema, request.body);
  const email = input.email.trim().toLowerCase();
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) return reply.code(409).send({ error: 'ACCOUNT_EXISTS' });
  const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
  const [user] = await db.insert(users).values({ email, passwordHash, displayName: input.displayName }).returning();
  if (!user) throw new Error('Account creation failed');
  const previousToken = request.cookies[cookieName];
  if (previousToken) await db.delete(sessions).where(eq(sessions.tokenHash, digest(previousToken)));
  const token = randomBytes(32).toString('base64url');
  await db.insert(sessions).values({ tokenHash: digest(token), userId: user.id, expiresAt: new Date(Date.now() + 14 * 86400000) });
  return reply.setCookie(cookieName, token, cookieOptions).code(201).send({ user: publicUser(user) });
});
app.post('/api/auth/login', { config: { rateLimit: { max: 8, timeWindow: '15 minutes' } } }, async (request, reply) => {
  const input = parseBody(loginSchema, request.body);
  const [user] = await db.select().from(users).where(eq(users.email, input.email.trim().toLowerCase())).limit(1);
  if (!user || !(await argon2.verify(user.passwordHash, input.password).catch(() => false))) return reply.code(401).send({ error: 'INVALID_CREDENTIALS' });
  const previousToken = request.cookies[cookieName];
  if (previousToken) await db.delete(sessions).where(eq(sessions.tokenHash, digest(previousToken)));
  const token = randomBytes(32).toString('base64url');
  await db.insert(sessions).values({ tokenHash: digest(token), userId: user.id, expiresAt: new Date(Date.now() + 14 * 86400000) });
  return reply.setCookie(cookieName, token, cookieOptions).send({ user: publicUser(user) });
});
app.post('/api/auth/logout', async (request, reply) => {
  const token = request.cookies[cookieName];
  if (token) await db.delete(sessions).where(eq(sessions.tokenHash, digest(token)));
  return reply.clearCookie(cookieName, { path: '/' }).code(204).send();
});
app.get('/api/auth/me', async (request, reply) => {
  const user = await userForCookie(request.cookies[cookieName]);
  if (!user) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
  return { user: publicUser(user) };
});

app.get('/api/campaigns', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const archived = (request.query as { archived?: string }).archived === 'true';
  return db.select({ campaign: campaigns, role: memberships.role }).from(memberships).innerJoin(campaigns, eq(memberships.campaignId, campaigns.id)).where(and(eq(memberships.userId, user.id), archived ? isNotNull(campaigns.archivedAt) : isNull(campaigns.archivedAt)));
});
app.post('/api/campaigns', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const input = parseBody(createCampaignSchema, request.body);
  const created = await db.transaction(async (tx) => {
    const [campaign] = await tx.insert(campaigns).values({ ...input, ownerId: user.id }).returning();
    if (!campaign) throw new Error('Campaign creation failed');
    await tx.insert(memberships).values({ campaignId: campaign.id, userId: user.id, role: 'OWNER' });
    await tx.insert(auditEvents).values({ campaignId: campaign.id, actorId: user.id, action: 'campaign.created', targetId: campaign.id });
    return campaign;
  });
  return reply.code(201).send({ campaign: created });
});
app.put('/api/campaigns/:campaignId/archive', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { campaignId } = request.params as { campaignId: string };
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  if (!campaign) return reply.code(404).send({ error: 'NOT_FOUND' });
  if (campaign.ownerId !== user.id) return reply.code(403).send({ error: 'FORBIDDEN' });
  const [updated] = await db.update(campaigns).set({ archivedAt: new Date() }).where(eq(campaigns.id, campaignId)).returning();
  await db.insert(auditEvents).values({ campaignId, actorId: user.id, action: 'campaign.archived', targetId: campaignId });
  return { campaign: updated };
});
app.put('/api/campaigns/:campaignId/restore', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { campaignId } = request.params as { campaignId: string };
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  if (!campaign) return reply.code(404).send({ error: 'NOT_FOUND' });
  if (campaign.ownerId !== user.id) return reply.code(403).send({ error: 'FORBIDDEN' });
  const [updated] = await db.update(campaigns).set({ archivedAt: null }).where(eq(campaigns.id, campaignId)).returning();
  await db.insert(auditEvents).values({ campaignId, actorId: user.id, action: 'campaign.restored', targetId: campaignId });
  return { campaign: updated };
});
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
  const [updated] = await db.update(memberships).set({ role: input.role }).where(and(eq(memberships.campaignId, campaignId), eq(memberships.userId, memberId))).returning();
  if (!updated) return reply.code(404).send({ error: 'NOT_FOUND' });
  await db.insert(auditEvents).values({ campaignId, actorId: user.id, action: 'membership.role_changed', targetId: memberId });
  io.in(`user:${memberId}`).socketsLeave(`campaign:${campaignId}:gm`);
  if (input.role === 'GM') io.in(`user:${memberId}`).socketsJoin(`campaign:${campaignId}:gm`);
  io.in(`campaign:${campaignId}`).emit('membership:changed', { userId: memberId, role: input.role });
  return { membership: updated };
});
app.delete('/api/campaigns/:campaignId/members/:memberId', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { campaignId, memberId } = request.params as { campaignId: string; memberId: string };
  const [campaign] = await db.select({ ownerId: campaigns.ownerId }).from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  if (!campaign) return reply.code(404).send({ error: 'NOT_FOUND' });
  if (campaign.ownerId !== user.id || memberId === campaign.ownerId) return reply.code(403).send({ error: 'FORBIDDEN' });
  const [removed] = await db.delete(memberships).where(and(eq(memberships.campaignId, campaignId), eq(memberships.userId, memberId))).returning();
  if (!removed) return reply.code(404).send({ error: 'NOT_FOUND' });
  io.in(`user:${memberId}`).emit('membership:removed', { userId: memberId, campaignId });
  io.in(`user:${memberId}`).socketsLeave(`campaign:${campaignId}`);
  io.in(`user:${memberId}`).socketsLeave(`campaign:${campaignId}:gm`);
  await db.insert(auditEvents).values({ campaignId, actorId: user.id, action: 'membership.removed', targetId: memberId });
  return reply.code(204).send();
});
app.get('/api/campaigns/:campaignId/messages', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { campaignId } = request.params as { campaignId: string };
  if (!await roleFor(campaignId, user.id)) return reply.code(404).send({ error: 'NOT_FOUND' });
  return db.select({ id: messages.id, senderId: messages.senderId, displayName: users.displayName, body: messages.body, recipientId: messages.recipientId, createdAt: messages.createdAt })
    .from(messages).innerJoin(users, eq(messages.senderId, users.id))
    .where(and(eq(messages.campaignId, campaignId), or(isNull(messages.recipientId), eq(messages.senderId, user.id), eq(messages.recipientId, user.id))))
    .orderBy(messages.createdAt).limit(100);
});
async function initiativeView(campaignId: string, role: string) {
  const [tracker] = await db.select().from(initiatives).where(eq(initiatives.campaignId, campaignId)).limit(1);
  if (!tracker) return { tracker: null, entries: [] };
  const entries = await db.select().from(initiativeEntries).where(eq(initiativeEntries.trackerId, tracker.id)).orderBy(desc(initiativeEntries.score), asc(initiativeEntries.tieOrder));
  const privileged = role === 'OWNER' || role === 'GM';
  const current = entries[tracker.activeIndex];
  return {
    tracker: { id: tracker.id, active: tracker.active, round: tracker.round, version: tracker.version, ...(privileged ? { activeIndex: tracker.activeIndex } : {}), currentEntryId: current && (privileged || !current.hidden) ? current.id : null },
    entries: entries.filter((entry) => privileged || !entry.hidden).map(({ hidden: _hidden, ...entry }) => entry),
  };
}
async function broadcastInitiative(campaignId: string) {
  const [tracker] = await db.select().from(initiatives).where(eq(initiatives.campaignId, campaignId)).limit(1);
  if (!tracker) return;
  const publicView = await initiativeView(campaignId, 'PLAYER');
  const gmView = await initiativeView(campaignId, 'GM');
  io.to(`campaign:${campaignId}`).emit('initiative:updated', publicView);
  io.to(`campaign:${campaignId}:gm`).emit('initiative:gm_updated', gmView);
}
app.get('/api/campaigns/:campaignId/initiative', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { campaignId } = request.params as { campaignId: string };
  const role = await roleFor(campaignId, user.id);
  if (!role) return reply.code(404).send({ error: 'NOT_FOUND' });
  return initiativeView(campaignId, role);
});
app.post('/api/campaigns/:campaignId/initiative/start', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { campaignId } = request.params as { campaignId: string };
  const role = await roleFor(campaignId, user.id);
  if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
  const input = parseBody(z.object({ sceneId: z.uuid(), entries: z.array(z.object({ tokenId: z.uuid().nullable(), label: z.string().trim().min(1).max(64), score: z.number().int().min(-9999).max(9999), hidden: z.boolean().default(false) })).min(1).max(100) }), request.body);
  const [scene] = await db.select({ campaignId: scenes.campaignId }).from(scenes).where(and(eq(scenes.id, input.sceneId), eq(scenes.campaignId, campaignId), isNull(scenes.archivedAt))).limit(1);
  if (!scene) return reply.code(404).send({ error: 'NOT_FOUND' });
  const [sceneState] = await db.select({ isActive: scenes.isActive }).from(scenes).where(eq(scenes.id, input.sceneId)).limit(1);
  if (!sceneState?.isActive) return reply.code(409).send({ error: 'SCENE_NOT_ACTIVE' });
  const validatedEntries: Array<{ tokenId: string | null; label: string; score: number; hidden: boolean; tieOrder: number }> = [];
  for (const [tieOrder, entry] of input.entries.entries()) {
    let hidden = entry.hidden;
    if (entry.tokenId) {
      const [token] = await db.select({ id: tokens.id, hidden: tokens.hidden }).from(tokens).where(and(eq(tokens.id, entry.tokenId), eq(tokens.sceneId, input.sceneId))).limit(1);
      if (!token) return reply.code(400).send({ error: 'INVALID_TOKEN' });
      hidden ||= token.hidden;
    }
    validatedEntries.push({ ...entry, hidden, tieOrder });
  }
  const tracker = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(initiatives).where(eq(initiatives.campaignId, campaignId)).limit(1);
    let current;
    if (existing) {
      if (existing.active) return null;
      const [updated] = await tx.update(initiatives).set({ active: true, round: 1, activeIndex: 0, version: existing.version + 1 }).where(and(eq(initiatives.id, existing.id), eq(initiatives.version, existing.version), eq(initiatives.active, false))).returning();
      current = updated;
      if (!updated) return null;
      await tx.delete(initiativeEntries).where(eq(initiativeEntries.trackerId, existing.id));
    } else {
      const [created] = await tx.insert(initiatives).values({ campaignId, active: true, round: 1, activeIndex: 0 }).onConflictDoNothing().returning();
      current = created;
      if (!created) return null;
    }
    if (!current) return null;
    await tx.insert(initiativeEntries).values(validatedEntries.map((entry) => ({ ...entry, trackerId: current.id })));
    await tx.insert(auditEvents).values({ campaignId, actorId: user.id, action: 'initiative.started', targetId: current.id });
    return current;
  });
  if (!tracker) return reply.code(409).send({ error: 'CONFLICT' });
  await broadcastInitiative(campaignId);
  return initiativeView(campaignId, role);
});
app.post('/api/campaigns/:campaignId/initiative/advance', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { campaignId } = request.params as { campaignId: string };
  const role = await roleFor(campaignId, user.id);
  if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
  const input = parseBody(z.object({ expectedVersion: z.number().int().positive() }), request.body);
  const [tracker] = await db.select().from(initiatives).where(eq(initiatives.campaignId, campaignId)).limit(1);
  if (!tracker || !tracker.active || tracker.version !== input.expectedVersion) return reply.code(409).send({ error: 'CONFLICT' });
  const [countResult] = await db.select({ count: sql<number>`count(*)::int` }).from(initiativeEntries).where(eq(initiativeEntries.trackerId, tracker.id));
  const count = countResult?.count ?? 0;
  if (!count) return reply.code(409).send({ error: 'CONFLICT' });
  const wrapsRound = tracker.activeIndex + 1 >= count;
  const [updated] = await db.update(initiatives).set({ activeIndex: wrapsRound ? 0 : tracker.activeIndex + 1, round: wrapsRound ? tracker.round + 1 : tracker.round, version: tracker.version + 1 }).where(and(eq(initiatives.id, tracker.id), eq(initiatives.version, input.expectedVersion), eq(initiatives.active, true))).returning();
  if (!updated) return reply.code(409).send({ error: 'CONFLICT' });
  await db.insert(auditEvents).values({ campaignId, actorId: user.id, action: 'initiative.advanced', targetId: tracker.id });
  await broadcastInitiative(campaignId);
  return initiativeView(campaignId, role);
});
app.post('/api/campaigns/:campaignId/initiative/stop', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { campaignId } = request.params as { campaignId: string };
  const role = await roleFor(campaignId, user.id);
  if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
  const input = parseBody(z.object({ expectedVersion: z.number().int().positive() }), request.body);
  const [updated] = await db.update(initiatives).set({ active: false, version: input.expectedVersion + 1 }).where(and(eq(initiatives.campaignId, campaignId), eq(initiatives.version, input.expectedVersion), eq(initiatives.active, true))).returning();
  if (!updated) return reply.code(409).send({ error: 'CONFLICT' });
  await db.insert(auditEvents).values({ campaignId, actorId: user.id, action: 'initiative.stopped', targetId: updated.id });
  await broadcastInitiative(campaignId);
  return initiativeView(campaignId, role);
});

app.get('/api/campaigns/:campaignId/scenes', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { campaignId } = request.params as { campaignId: string };
  const role = await roleFor(campaignId, user.id);
  if (!role) return reply.code(404).send({ error: 'NOT_FOUND' });
  const archived = (request.query as { archived?: string }).archived === 'true';
  if (archived && !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
  const rows = await db.select().from(scenes).where(eq(scenes.campaignId, campaignId)).orderBy(asc(scenes.sortOrder), asc(scenes.id));
  return rows.filter((scene) => canListScene(role, scene.isActive, scene.archivedAt !== null, archived));
});
app.get('/api/scenes/:sceneId/layers', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { sceneId } = request.params as { sceneId: string };
  const [scene] = await db.select().from(scenes).where(eq(scenes.id, sceneId)).limit(1);
  if (!scene) return reply.code(404).send({ error: 'NOT_FOUND' });
  const role = await roleFor(scene.campaignId, user.id);
  if (!role || !canReadSceneTokens(role, scene.isActive, scene.archivedAt !== null)) return reply.code(404).send({ error: 'NOT_FOUND' });
  const rows = await db.select().from(sceneLayers).where(eq(sceneLayers.sceneId, sceneId)).orderBy(asc(sceneLayers.sortOrder), asc(sceneLayers.id));
  return rows.filter((layer) => canReadSceneLayer(role, scene.isActive, false, layer.visibleToPlayers, layer.kind));
});
app.post('/api/scenes/:sceneId/layers', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { sceneId } = request.params as { sceneId: string };
  const input = parseBody(createSceneLayerSchema, request.body);
  const [scene] = await db.select().from(scenes).where(eq(scenes.id, sceneId)).limit(1);
  if (!scene) return reply.code(404).send({ error: 'NOT_FOUND' });
  const role = await roleFor(scene.campaignId, user.id);
  if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
  if (scene.archivedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
  const [layer] = await db.insert(sceneLayers).values({ ...input, sceneId, visibleToPlayers: input.kind === 'GM' ? false : input.visibleToPlayers }).returning();
  if (!layer) throw new Error('Layer creation failed');
  await db.insert(auditEvents).values({ campaignId: scene.campaignId, actorId: user.id, action: 'scene.layer_created', targetId: layer.id });
  const room = `campaign:${scene.campaignId}`;
  ((layer.visibleToPlayers && scene.isActive) ? io.to(room) : io.to(`${room}:gm`)).emit('scene:layer_created', { sceneId, layer });
  return reply.code(201).send({ layer });
});
app.patch('/api/layers/:layerId', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { layerId } = request.params as { layerId: string };
  const input = parseBody(updateSceneLayerSchema, request.body);
  const [row] = await db.select({ layer: sceneLayers, scene: scenes }).from(sceneLayers).innerJoin(scenes, eq(sceneLayers.sceneId, scenes.id)).where(eq(sceneLayers.id, layerId)).limit(1);
  if (!row) return reply.code(404).send({ error: 'NOT_FOUND' });
  const role = await roleFor(row.scene.campaignId, user.id);
  if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
  if (row.scene.archivedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
  if (row.layer.kind === 'BACKGROUND' && input.locked === false) return reply.code(400).send({ error: 'BACKGROUND_LAYER_LOCKED' });
  const { expectedVersion, ...patch } = input;
  if (row.layer.kind === 'GM' && patch.visibleToPlayers === true) return reply.code(400).send({ error: 'GM_LAYER_PRIVATE' });
  const [updated] = await db.update(sceneLayers).set({ ...patch, version: row.layer.version + 1 }).where(and(eq(sceneLayers.id, layerId), eq(sceneLayers.version, expectedVersion))).returning();
  if (!updated) return reply.code(409).send({ error: 'CONFLICT' });
  await db.insert(auditEvents).values({ campaignId: row.scene.campaignId, actorId: user.id, action: 'scene.layer_updated', targetId: layerId });
  const room = `campaign:${row.scene.campaignId}`;
  let publicProjection = false;
  if (row.scene.isActive && row.layer.visibleToPlayers) {
    if (updated.visibleToPlayers) io.to(room).emit('scene:layer_updated', { sceneId: row.scene.id, layer: updated });
    else io.to(room).emit('scene:layer_hidden', { sceneId: row.scene.id, layerId: updated.id });
    publicProjection = true;
  }
  if (row.scene.isActive && updated.visibleToPlayers && !row.layer.visibleToPlayers) { io.to(room).emit('scene:layer_updated', { sceneId: row.scene.id, layer: updated }); publicProjection = true; }
  if (!publicProjection) io.to(`${room}:gm`).emit('scene:layer_updated', { sceneId: row.scene.id, layer: updated });
  return { layer: updated };
});
app.delete('/api/layers/:layerId', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { layerId } = request.params as { layerId: string };
  const input = parseBody(z.object({ expectedVersion: z.number().int().positive() }), request.body);
  const [row] = await db.select({ layer: sceneLayers, scene: scenes }).from(sceneLayers).innerJoin(scenes, eq(sceneLayers.sceneId, scenes.id)).where(eq(sceneLayers.id, layerId)).limit(1);
  if (!row) return reply.code(404).send({ error: 'NOT_FOUND' });
  const role = await roleFor(row.scene.campaignId, user.id);
  if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
  if (row.scene.archivedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
  if (baseLayerKinds.includes(row.layer.kind as typeof baseLayerKinds[number])) return reply.code(409).send({ error: 'BASE_LAYER_REQUIRED' });
  const [object] = await db.select({ id: sceneObjects.id }).from(sceneObjects).where(eq(sceneObjects.layerId, layerId)).limit(1);
  if (object) return reply.code(409).send({ error: 'LAYER_NOT_EMPTY' });
  const [deleted] = await db.delete(sceneLayers).where(and(eq(sceneLayers.id, layerId), eq(sceneLayers.version, input.expectedVersion))).returning({ id: sceneLayers.id });
  if (!deleted) return reply.code(409).send({ error: 'CONFLICT' });
  const room = `campaign:${row.scene.campaignId}`;
  if (row.scene.isActive && row.layer.visibleToPlayers) io.to(room).emit('scene:layer_deleted', { sceneId: row.scene.id, layerId });
  else io.to(`${room}:gm`).emit('scene:layer_deleted', { sceneId: row.scene.id, layerId });
  return reply.code(204).send();
});
app.get('/api/scenes/:sceneId/objects', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { sceneId } = request.params as { sceneId: string };
  const [scene] = await db.select().from(scenes).where(eq(scenes.id, sceneId)).limit(1);
  if (!scene) return reply.code(404).send({ error: 'NOT_FOUND' });
  const role = await roleFor(scene.campaignId, user.id);
  if (!role || !canReadSceneTokens(role, scene.isActive, scene.archivedAt !== null)) return reply.code(404).send({ error: 'NOT_FOUND' });
  const rows = await db.select({ object: sceneObjects, layer: sceneLayers }).from(sceneObjects).innerJoin(sceneLayers, eq(sceneObjects.layerId, sceneLayers.id)).where(eq(sceneObjects.sceneId, sceneId)).orderBy(asc(sceneObjects.zIndex), asc(sceneObjects.id));
  return rows.filter(({ object, layer }) => role !== 'PLAYER' || (object.visible && canReadSceneLayer(role, scene.isActive, false, layer.visibleToPlayers, layer.kind))).map(({ object }) => object);
});
app.post('/api/scenes/:sceneId/objects', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { sceneId } = request.params as { sceneId: string };
  const input = parseBody(createSceneObjectSchema, request.body);
  const [scene] = await db.select().from(scenes).where(eq(scenes.id, sceneId)).limit(1);
  if (!scene) return reply.code(404).send({ error: 'NOT_FOUND' });
  const role = await roleFor(scene.campaignId, user.id);
  if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
  if (scene.archivedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
  const [layer] = await db.select().from(sceneLayers).where(and(eq(sceneLayers.id, input.layerId), eq(sceneLayers.sceneId, sceneId))).limit(1);
  if (!layer) return reply.code(400).send({ error: 'INVALID_LAYER' });
  if (layer.locked) return reply.code(409).send({ error: 'LAYER_LOCKED' });
  if (layer.kind === 'GM') input.visible = false;
  if (input.assetId) {
    const [asset] = await db.select({ id: assets.id }).from(assets).where(and(eq(assets.id, input.assetId), eq(assets.campaignId, scene.campaignId))).limit(1);
    if (!asset) return reply.code(400).send({ error: 'INVALID_ASSET' });
  }
  const [object] = await db.insert(sceneObjects).values({ ...input, sceneId }).returning();
  if (!object) throw new Error('Scene object creation failed');
  await db.insert(auditEvents).values({ campaignId: scene.campaignId, actorId: user.id, action: 'scene.object_created', targetId: object.id });
  const room = `campaign:${scene.campaignId}`;
  ((scene.isActive && layer.visibleToPlayers && object.visible && layer.kind !== 'GM') ? io.to(room) : io.to(`${room}:gm`)).emit('scene:object_created', { object });
  return reply.code(201).send({ object });
});
app.patch('/api/objects/:objectId', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { objectId } = request.params as { objectId: string };
  const input = parseBody(updateSceneObjectSchema, request.body);
  const [row] = await db.select({ object: sceneObjects, layer: sceneLayers, scene: scenes }).from(sceneObjects).innerJoin(sceneLayers, eq(sceneObjects.layerId, sceneLayers.id)).innerJoin(scenes, eq(sceneObjects.sceneId, scenes.id)).where(eq(sceneObjects.id, objectId)).limit(1);
  if (!row) return reply.code(404).send({ error: 'NOT_FOUND' });
  const role = await roleFor(row.scene.campaignId, user.id);
  if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
  if (row.scene.archivedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
  if (row.layer.locked) return reply.code(409).send({ error: 'LAYER_LOCKED' });
  const { expectedVersion, ...patch } = input;
  const requestedFields = Object.keys(request.body as Record<string, unknown>).filter((field) => field !== 'expectedVersion');
  if (row.object.locked && !(patch.locked === false && requestedFields.length === 1 && requestedFields[0] === 'locked')) return reply.code(409).send({ error: 'OBJECT_LOCKED' });
  let targetLayerKind = row.layer.kind;
  if (patch.layerId) {
    const [nextLayer] = await db.select().from(sceneLayers).where(and(eq(sceneLayers.id, patch.layerId), eq(sceneLayers.sceneId, row.scene.id))).limit(1);
    if (!nextLayer) return reply.code(400).send({ error: 'INVALID_LAYER' });
    if (nextLayer.locked) return reply.code(409).send({ error: 'LAYER_LOCKED' });
    targetLayerKind = nextLayer.kind;
  }
  if (targetLayerKind === 'GM') patch.visible = false;
  if (patch.assetId) {
    const [asset] = await db.select({ id: assets.id }).from(assets).where(and(eq(assets.id, patch.assetId), eq(assets.campaignId, row.scene.campaignId))).limit(1);
    if (!asset) return reply.code(400).send({ error: 'INVALID_ASSET' });
  }
  const [updated] = await db.update(sceneObjects).set({ ...patch, version: row.object.version + 1 }).where(and(eq(sceneObjects.id, objectId), eq(sceneObjects.version, expectedVersion))).returning();
  if (!updated) return reply.code(409).send({ error: 'CONFLICT' });
  await db.insert(auditEvents).values({ campaignId: row.scene.campaignId, actorId: user.id, action: 'scene.object_updated', targetId: objectId });
  const newLayerId = updated.layerId;
  const [newLayer] = newLayerId === row.layer.id ? [row.layer] : await db.select().from(sceneLayers).where(eq(sceneLayers.id, newLayerId)).limit(1);
  const room = `campaign:${row.scene.campaignId}`;
  const wasPublic = row.scene.isActive && row.layer.visibleToPlayers && row.layer.kind !== 'GM' && row.object.visible;
  const isPublic = row.scene.isActive && newLayer?.visibleToPlayers && newLayer.kind !== 'GM' && updated.visible;
  if (wasPublic && !isPublic) io.to(room).emit('scene:object_deleted', { sceneId: row.scene.id, objectId });
  if (isPublic) io.to(room).emit('scene:object_updated', { object: updated });
  else io.to(`${room}:gm`).emit('scene:object_updated', { object: updated });
  return { object: updated };
});
app.delete('/api/objects/:objectId', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { objectId } = request.params as { objectId: string };
  const input = parseBody(z.object({ expectedVersion: z.number().int().positive() }), request.body);
  const [row] = await db.select({ object: sceneObjects, layer: sceneLayers, scene: scenes }).from(sceneObjects).innerJoin(sceneLayers, eq(sceneObjects.layerId, sceneLayers.id)).innerJoin(scenes, eq(sceneObjects.sceneId, scenes.id)).where(eq(sceneObjects.id, objectId)).limit(1);
  if (!row) return reply.code(404).send({ error: 'NOT_FOUND' });
  const role = await roleFor(row.scene.campaignId, user.id);
  if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
  if (row.scene.archivedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
  if (row.layer.locked) return reply.code(409).send({ error: 'LAYER_LOCKED' });
  if (row.object.locked) return reply.code(409).send({ error: 'OBJECT_LOCKED' });
  const [deleted] = await db.delete(sceneObjects).where(and(eq(sceneObjects.id, objectId), eq(sceneObjects.version, input.expectedVersion))).returning({ id: sceneObjects.id });
  if (!deleted) return reply.code(409).send({ error: 'CONFLICT' });
  const room = `campaign:${row.scene.campaignId}`;
  if (row.scene.isActive && row.layer.visibleToPlayers && row.layer.kind !== 'GM' && row.object.visible) io.to(room).emit('scene:object_deleted', { sceneId: row.scene.id, objectId });
  else io.to(`${room}:gm`).emit('scene:object_deleted', { sceneId: row.scene.id, objectId });
  await db.insert(auditEvents).values({ campaignId: row.scene.campaignId, actorId: user.id, action: 'scene.object_deleted', targetId: objectId });
  return reply.code(204).send();
});
app.patch('/api/scenes/:sceneId', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { sceneId } = request.params as { sceneId: string };
  const input = parseBody(z.object({
    title: z.string().trim().min(1).max(80).optional(), gridSize: z.number().int().min(8).max(256).optional(), width: z.number().int().min(256).max(16384).optional(), height: z.number().int().min(256).max(16384).optional(),
    gridColor: z.string().regex(/^#[\da-fA-F]{6}$/).optional(), gridOpacity: z.number().min(0).max(1).optional(), gridOffsetX: z.number().min(-16384).max(16384).optional(), gridOffsetY: z.number().min(-16384).max(16384).optional(), gridEnabled: z.boolean().optional(), snapToGrid: z.boolean().optional(), unitsPerCell: z.number().min(0.01).max(100000).optional(), unitLabel: z.string().trim().min(1).max(24).optional(), cameraX: z.number().min(-32768).max(32768).optional(), cameraY: z.number().min(-32768).max(32768).optional(), cameraZoom: z.number().min(0.25).max(4).optional(), expectedVersion: z.number().int().positive(),
  }).refine(({ expectedVersion: _expectedVersion, ...fields }) => Object.values(fields).some((value) => value !== undefined)), request.body);
  const [scene] = await db.select().from(scenes).where(eq(scenes.id, sceneId)).limit(1);
  if (!scene) return reply.code(404).send({ error: 'NOT_FOUND' });
  const role = await roleFor(scene.campaignId, user.id);
  if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
  if (scene.archivedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
  const { expectedVersion, ...patch } = input;
  const [updated] = await db.update(scenes).set({ ...patch, version: scene.version + 1 }).where(and(eq(scenes.id, sceneId), eq(scenes.version, expectedVersion), isNull(scenes.archivedAt))).returning();
  if (!updated) return reply.code(409).send({ error: 'CONFLICT' });
  await db.insert(auditEvents).values({ campaignId: scene.campaignId, actorId: user.id, action: 'scene.updated', targetId: sceneId });
  if (updated.isActive) io.to(`campaign:${scene.campaignId}`).emit('scene:updated', { scene: publicScene(updated) });
  return { scene: updated };
});
app.post('/api/scenes/:sceneId/duplicate', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { sceneId } = request.params as { sceneId: string };
  const [source] = await db.select().from(scenes).where(eq(scenes.id, sceneId)).limit(1);
  if (!source) return reply.code(404).send({ error: 'NOT_FOUND' });
  if (source.archivedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
  const role = await roleFor(source.campaignId, user.id);
  if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
  const duplicate = await db.transaction(async (tx) => {
    const [last] = await tx.select({ sortOrder: scenes.sortOrder }).from(scenes).where(eq(scenes.campaignId, source.campaignId)).orderBy(desc(scenes.sortOrder)).limit(1);
    const { id: _id, archivedAt: _archivedAt, version: _version, isActive: _isActive, published: _published, sortOrder: _sortOrder, ...copy } = source;
    const [scene] = await tx.insert(scenes).values({ ...copy, title: `${source.title} (copy)`.slice(0, 80), sortOrder: (last?.sortOrder ?? -1) + 1, isActive: false, published: false, archivedAt: null, version: 1 }).returning();
    if (!scene) throw new Error('Scene duplication failed');
    const sourceLayers = await tx.select().from(sceneLayers).where(eq(sceneLayers.sceneId, source.id)).orderBy(asc(sceneLayers.sortOrder));
    const copiedLayers = await tx.insert(sceneLayers).values(sourceLayers.map(({ id: _layerId, sceneId: _sceneId, ...layer }) => ({ ...layer, sceneId: scene.id, version: 1 }))).returning();
    const layerMap = new Map(sourceLayers.map((layer, index) => [layer.id, copiedLayers[index]!.id]));
    const sourceObjects = await tx.select().from(sceneObjects).where(eq(sceneObjects.sceneId, source.id));
    if (sourceObjects.length) await tx.insert(sceneObjects).values(sourceObjects.map(({ id: _objectId, sceneId: _sceneId, layerId, ...object }) => ({ ...object, sceneId: scene.id, layerId: layerMap.get(layerId)!, version: 1 })));
    const sourceTokens = await tx.select().from(tokens).where(eq(tokens.sceneId, source.id));
    if (sourceTokens.length) await tx.insert(tokens).values(sourceTokens.map(({ id: _id, sceneId: _sceneId, ...token }) => ({ ...token, sceneId: scene.id })));
    await tx.insert(auditEvents).values({ campaignId: source.campaignId, actorId: user.id, action: 'scene.duplicated', targetId: scene.id });
    return scene;
  });
  return reply.code(201).send({ scene: duplicate });
});
app.put('/api/scenes/:sceneId/archive', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { sceneId } = request.params as { sceneId: string };
  const input = parseBody(z.object({ expectedVersion: z.number().int().positive() }), request.body);
  const [scene] = await db.select().from(scenes).where(eq(scenes.id, sceneId)).limit(1);
  if (!scene) return reply.code(404).send({ error: 'NOT_FOUND' });
  const role = await roleFor(scene.campaignId, user.id);
  if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
  if (scene.archivedAt) return reply.code(409).send({ error: 'CONFLICT' });
  let result: { scene: typeof scene; activated: typeof scene | null };
  try {
    result = await db.transaction(async (tx) => {
      const [updated] = await tx.update(scenes).set({ archivedAt: new Date(), isActive: false, version: scene.version + 1 }).where(and(eq(scenes.id, sceneId), eq(scenes.version, input.expectedVersion), isNull(scenes.archivedAt))).returning();
      if (!updated) throw new Error('SCENE_CONFLICT');
      let activated: typeof scene | null = null;
      if (scene.isActive) {
        const [fallback] = await tx.select().from(scenes).where(and(eq(scenes.campaignId, scene.campaignId), isNull(scenes.archivedAt), eq(scenes.published, true), sql`${scenes.id} <> ${sceneId}`)).orderBy(desc(scenes.sortOrder)).limit(1);
        if (fallback) { const [next] = await tx.update(scenes).set({ isActive: true, version: fallback.version + 1 }).where(and(eq(scenes.id, fallback.id), eq(scenes.version, fallback.version))).returning(); if (!next) throw new Error('SCENE_CONFLICT'); activated = next; }
      }
      await tx.insert(auditEvents).values({ campaignId: scene.campaignId, actorId: user.id, action: 'scene.archived', targetId: sceneId });
      return { scene: updated, activated };
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'SCENE_CONFLICT') return reply.code(409).send({ error: 'CONFLICT' });
    throw error;
  }
  if (scene.isActive) io.to(`campaign:${scene.campaignId}`).emit('scene:activated', { sceneId: result.activated?.id ?? null });
  return { scene: result.scene };
});
app.post('/api/scenes', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const input = parseBody(createSceneSchema, request.body);
  const role = await roleFor(input.campaignId, user.id);
  if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
  const scene = await db.transaction(async (tx) => {
    const [last] = await tx.select({ sortOrder: scenes.sortOrder }).from(scenes).where(eq(scenes.campaignId, input.campaignId)).orderBy(desc(scenes.sortOrder)).limit(1);
    const [active] = await tx.select({ id: scenes.id }).from(scenes).where(and(eq(scenes.campaignId, input.campaignId), eq(scenes.isActive, true), isNull(scenes.archivedAt))).limit(1);
    const [created] = await tx.insert(scenes).values({ campaignId: input.campaignId, title: input.title, gridSize: input.gridSize, sortOrder: (last?.sortOrder ?? -1) + 1, isActive: !active, published: !active }).returning();
    if (created) await tx.insert(sceneLayers).values(defaultLayerRows.map((layer) => ({ ...layer, sceneId: created.id })));
    if (created) await tx.insert(auditEvents).values({ campaignId: input.campaignId, actorId: user.id, action: 'scene.created', targetId: created.id });
    return created;
  });
  if (!scene) throw new Error('Scene creation failed');
  if (scene.isActive) io.to(`campaign:${input.campaignId}`).emit('scene:activated', { sceneId: scene.id });
  return reply.code(201).send({ scene });
});
app.put('/api/scenes/:sceneId/activate', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { sceneId } = request.params as { sceneId: string };
  const input = parseBody(z.object({ expectedVersion: z.number().int().positive() }), request.body);
  const [scene] = await db.select().from(scenes).where(and(eq(scenes.id, sceneId), isNull(scenes.archivedAt))).limit(1);
  if (!scene) return reply.code(404).send({ error: 'NOT_FOUND' });
  const role = await roleFor(scene.campaignId, user.id);
  if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
  if (scene.version !== input.expectedVersion) return reply.code(409).send({ error: 'CONFLICT' });
  if (scene.isActive) return { scene };
  let activated: typeof scene;
  try {
    activated = await db.transaction(async (tx) => {
      await tx.update(scenes).set({ isActive: false, version: sql`${scenes.version} + 1` }).where(and(eq(scenes.campaignId, scene.campaignId), eq(scenes.isActive, true)));
      const [updated] = await tx.update(scenes).set({ isActive: true, published: true, version: scene.version + 1 }).where(and(eq(scenes.id, scene.id), eq(scenes.version, input.expectedVersion), isNull(scenes.archivedAt))).returning();
      if (!updated) throw new Error('SCENE_CONFLICT');
      await tx.insert(auditEvents).values({ campaignId: scene.campaignId, actorId: user.id, action: 'scene.activated', targetId: sceneId });
      return updated;
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'SCENE_CONFLICT') return reply.code(409).send({ error: 'CONFLICT' });
    throw error;
  }
  io.to(`campaign:${scene.campaignId}`).emit('scene:activated', { sceneId: activated.id });
  return { scene: activated };
});
app.put('/api/scenes/:sceneId/restore', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { sceneId } = request.params as { sceneId: string };
  const input = parseBody(z.object({ expectedVersion: z.number().int().positive() }), request.body);
  const [scene] = await db.select().from(scenes).where(eq(scenes.id, sceneId)).limit(1);
  if (!scene) return reply.code(404).send({ error: 'NOT_FOUND' });
  const role = await roleFor(scene.campaignId, user.id);
  if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
  if (!scene.archivedAt || scene.version !== input.expectedVersion) return reply.code(409).send({ error: 'CONFLICT' });
  const [last] = await db.select({ sortOrder: scenes.sortOrder }).from(scenes).where(eq(scenes.campaignId, scene.campaignId)).orderBy(desc(scenes.sortOrder)).limit(1);
  const [restored] = await db.update(scenes).set({ archivedAt: null, sortOrder: (last?.sortOrder ?? -1) + 1, version: scene.version + 1 }).where(and(eq(scenes.id, sceneId), eq(scenes.version, input.expectedVersion))).returning();
  if (!restored) return reply.code(409).send({ error: 'CONFLICT' });
  await db.insert(auditEvents).values({ campaignId: scene.campaignId, actorId: user.id, action: 'scene.restored', targetId: sceneId });
  return { scene: restored };
});
app.put('/api/campaigns/:campaignId/scenes/reorder', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { campaignId } = request.params as { campaignId: string };
  const role = await roleFor(campaignId, user.id);
  if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
  const input = parseBody(z.object({ scenes: z.array(z.object({ id: z.uuid(), expectedVersion: z.number().int().positive() })).min(1).max(100) }), request.body);
  if (new Set(input.scenes.map(({ id }) => id)).size !== input.scenes.length) return reply.code(400).send({ error: 'INVALID' });
  try {
    await db.transaction(async (tx) => {
      const current = await tx.select().from(scenes).where(and(eq(scenes.campaignId, campaignId), isNull(scenes.archivedAt)));
      if (current.length !== input.scenes.length || input.scenes.some((item) => !current.some((scene) => scene.id === item.id && scene.version === item.expectedVersion))) throw new Error('SCENE_CONFLICT');
      for (const [sortOrder, item] of input.scenes.entries()) {
        const [updated] = await tx.update(scenes).set({ sortOrder, version: item.expectedVersion + 1 }).where(and(eq(scenes.id, item.id), eq(scenes.version, item.expectedVersion))).returning({ id: scenes.id });
        if (!updated) throw new Error('SCENE_CONFLICT');
      }
      await tx.insert(auditEvents).values({ campaignId, actorId: user.id, action: 'scenes.reordered' });
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'SCENE_CONFLICT') return reply.code(409).send({ error: 'CONFLICT' });
    throw error;
  }
  return db.select().from(scenes).where(and(eq(scenes.campaignId, campaignId), isNull(scenes.archivedAt))).orderBy(asc(scenes.sortOrder), asc(scenes.id));
});
app.post('/api/campaigns/:campaignId/assets', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { campaignId } = request.params as { campaignId: string };
  const role = await roleFor(campaignId, user.id);
  if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
  const file = await request.file();
  if (!file) return reply.code(400).send({ error: 'FILE_REQUIRED' });
  let buffer: Buffer;
  try { buffer = await file.toBuffer(); }
  catch { return reply.code(413).send({ error: 'FILE_TOO_LARGE' }); }
  const detected = buffer.subarray(0, 12);
  const mediaType = detected.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
    : detected[0] === 255 && detected[1] === 216 && detected[2] === 255 ? 'image/jpeg'
    : detected.toString('ascii', 0, 4) === 'RIFF' && detected.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null;
  if (!mediaType) return reply.code(415).send({ error: 'UNSUPPORTED_IMAGE' });
  const extension = mediaType === 'image/png' ? '.png' : mediaType === 'image/jpeg' ? '.jpg' : '.webp';
  const storageKey = `${randomBytes(24).toString('hex')}${extension}`;
  await mkdir(uploadDirectory, { recursive: true });
  const destination = resolve(uploadDirectory, storageKey);
  try {
    await writeFile(destination, buffer, { flag: 'wx', mode: 0o600 });
    const [asset] = await db.insert(assets).values({ campaignId, storageKey, mediaType, size: buffer.byteLength, checksum: createHash('sha256').update(buffer).digest('hex'), uploaderId: user.id }).returning();
    if (!asset) throw new Error('Asset metadata creation failed');
    await db.insert(auditEvents).values({ campaignId, actorId: user.id, action: 'asset.uploaded', targetId: asset.id });
    return reply.code(201).send({ asset: { id: asset.id, mediaType: asset.mediaType, size: asset.size } });
  } catch (error) {
    await unlink(destination).catch(() => {});
    throw error;
  }
});
app.put('/api/scenes/:sceneId/background', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { sceneId } = request.params as { sceneId: string };
  const input = parseBody(z.object({ assetId: z.uuid().nullable(), expectedVersion: z.number().int().positive() }), request.body);
  const [scene] = await db.select().from(scenes).where(eq(scenes.id, sceneId)).limit(1);
  if (!scene) return reply.code(404).send({ error: 'NOT_FOUND' });
  const role = await roleFor(scene.campaignId, user.id);
  if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
  if (scene.archivedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
  if (input.assetId) {
    const [asset] = await db.select({ id: assets.id }).from(assets).where(and(eq(assets.id, input.assetId), eq(assets.campaignId, scene.campaignId))).limit(1);
    if (!asset) return reply.code(400).send({ error: 'INVALID_ASSET' });
  }
  const [updated] = await db.update(scenes).set({ backgroundAssetId: input.assetId, version: scene.version + 1 }).where(and(eq(scenes.id, sceneId), eq(scenes.version, input.expectedVersion))).returning();
  if (!updated) return reply.code(409).send({ error: 'CONFLICT' });
  await db.insert(auditEvents).values({ campaignId: scene.campaignId, actorId: user.id, action: 'scene.background_changed', targetId: sceneId });
  if (updated.isActive) io.to(`campaign:${scene.campaignId}`).emit('scene:updated', { scene: publicScene(updated) });
  return { scene: updated };
});
app.get('/api/assets/:assetId', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { assetId } = request.params as { assetId: string };
  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
  if (!asset) return reply.code(404).send({ error: 'NOT_FOUND' });
  const role = await roleFor(asset.campaignId, user.id);
  if (!role) return reply.code(404).send({ error: 'NOT_FOUND' });
  if (!['OWNER', 'GM'].includes(role)) {
    const [visibleReference] = await db.select({ id: scenes.id }).from(scenes).where(and(eq(scenes.campaignId, asset.campaignId), eq(scenes.backgroundAssetId, asset.id), eq(scenes.isActive, true), isNull(scenes.archivedAt))).limit(1);
    if (!visibleReference) return reply.code(404).send({ error: 'NOT_FOUND' });
  }
  return reply.type(asset.mediaType).header('x-content-type-options', 'nosniff').header('cache-control', 'private, max-age=3600').send(createReadStream(resolve(uploadDirectory, asset.storageKey)));
});
app.get('/api/scenes/:sceneId/tokens', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { sceneId } = request.params as { sceneId: string };
  const [scene] = await db.select().from(scenes).where(eq(scenes.id, sceneId)).limit(1);
  if (!scene || scene.archivedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
  const role = await roleFor(scene.campaignId, user.id);
  if (!role || !canReadSceneTokens(role, scene.isActive, scene.archivedAt !== null)) return reply.code(404).send({ error: 'NOT_FOUND' });
  const query = db.select({ id: tokens.id, sceneId: tokens.sceneId, name: tokens.name, x: tokens.x, y: tokens.y, color: tokens.color, version: tokens.version, ownerUserId: tokens.ownerUserId, hidden: tokens.hidden }).from(tokens).where(eq(tokens.sceneId, sceneId));
  const rows = await query;
  return rows.filter((token) => !token.hidden || role === 'OWNER' || role === 'GM').map(({ hidden: _hidden, ...token }) => token);
});
app.post('/api/tokens', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const input = parseBody(createTokenSchema, request.body);
  const [scene] = await db.select().from(scenes).where(eq(scenes.id, input.sceneId)).limit(1);
  if (!scene) return reply.code(404).send({ error: 'NOT_FOUND' });
  const role = await roleFor(scene.campaignId, user.id);
  if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
  if (scene.archivedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
  const [token] = await db.insert(tokens).values(input).returning();
  if (!token) throw new Error('Token creation failed');
  const projection = { id: token.id, sceneId: token.sceneId, name: token.name, x: token.x, y: token.y, color: token.color, version: token.version, ownerUserId: token.ownerUserId };
  const room = `campaign:${scene.campaignId}`;
  ((token.hidden || !scene.isActive) ? io.to(`${room}:gm`) : io.to(room)).emit('token:created', projection);
  return reply.code(201).send({ token: projection });
});
app.post('/api/tokens/:tokenId/owner', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { tokenId } = request.params as { tokenId: string };
  const input = parseBody(z.object({ ownerUserId: z.uuid().nullable() }), request.body);
  const [row] = await db.select({ token: tokens, scene: scenes }).from(tokens).innerJoin(scenes, eq(tokens.sceneId, scenes.id)).where(eq(tokens.id, tokenId)).limit(1);
  if (!row) return reply.code(404).send({ error: 'NOT_FOUND' });
  const role = await roleFor(row.scene.campaignId, user.id);
  if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
  if (row.scene.archivedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
  if (input.ownerUserId && !await roleFor(row.scene.campaignId, input.ownerUserId)) return reply.code(400).send({ error: 'INVALID_OWNER' });
  const [updated] = await db.update(tokens).set({ ownerUserId: input.ownerUserId, version: row.token.version + 1 }).where(and(eq(tokens.id, tokenId), eq(tokens.version, row.token.version))).returning();
  if (!updated) return reply.code(409).send({ error: 'CONFLICT' });
  await db.insert(auditEvents).values({ campaignId: row.scene.campaignId, actorId: user.id, action: 'token.owner_changed', targetId: tokenId });
  const projection = { id: updated.id, sceneId: updated.sceneId, name: updated.name, x: updated.x, y: updated.y, color: updated.color, version: updated.version, ownerUserId: updated.ownerUserId };
  ((updated.hidden || !row.scene.isActive) ? io.to(`campaign:${row.scene.campaignId}:gm`) : io.to(`campaign:${row.scene.campaignId}`)).emit('token:updated', projection);
  return { token: projection };
});

const io = new Server(app.server, { serveClient: false, maxHttpBufferSize: 64 * 1024, cors: { origin: webOrigins, credentials: true }, allowRequest: (request, callback) => { const origin = request.headers.origin; callback(null, !origin || webOrigins.includes(origin)); } });
io.use(async (socket, next) => {
  try {
    const rawCookie = socket.handshake.headers.cookie ?? '';
    const token = rawCookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    const user = await userForCookie(token ? decodeURIComponent(token) : undefined);
    if (!user) return next(new Error('UNAUTHENTICATED'));
    socket.data.user = { id: user.id, displayName: user.displayName };
    next();
  } catch { next(new Error('UNAUTHENTICATED')); }
});
io.on('connection', (socket) => {
  const user = socket.data.user as { id: string; displayName: string };
  void socket.join(`user:${user.id}`);
  socket.on('campaign:join', async (campaignId: string, callback?: (result: unknown) => void) => {
    if (typeof campaignId !== 'string' || !z.uuid().safeParse(campaignId).success) return callback?.({ error: 'INVALID' });
    const role = await roleFor(campaignId, user.id);
    if (!role) return callback?.({ error: 'FORBIDDEN' });
    const room = `campaign:${campaignId}`;
    await socket.join(room);
    if (role === 'OWNER' || role === 'GM') await socket.join(`${room}:gm`);
    callback?.({ ok: true, role });
    socket.to(room).emit('presence:joined', { userId: user.id, displayName: user.displayName });
  });
  socket.on('campaign:leave', async (campaignId: string) => {
    if (typeof campaignId !== 'string' || !z.uuid().safeParse(campaignId).success) return;
    await socket.leave(`campaign:${campaignId}`);
    await socket.leave(`campaign:${campaignId}:gm`);
  });
  socket.on('token:move', async (raw: unknown, callback?: (result: unknown) => void) => {
    try {
      const input = parseBody(moveTokenSchema, raw);
      const [token] = await db.select({ token: tokens, scene: scenes }).from(tokens).innerJoin(scenes, eq(tokens.sceneId, scenes.id)).where(eq(tokens.id, input.tokenId)).limit(1);
      if (!token) return callback?.({ error: 'NOT_FOUND' });
      const room = `campaign:${token.scene.campaignId}`;
      if (!socket.rooms.has(room)) return callback?.({ error: 'FORBIDDEN' });
      const role = await roleFor(token.scene.campaignId, user.id);
      if (!role || token.scene.archivedAt || (!['OWNER', 'GM'].includes(role) && !token.scene.isActive)) return callback?.({ error: 'FORBIDDEN' });
      if (!canMoveToken(role, user.id, token.token.ownerUserId, token.token.hidden)) return callback?.({ error: 'FORBIDDEN' });
      const [updated] = await db.update(tokens).set({ x: input.x, y: input.y, version: token.token.version + 1 }).where(and(eq(tokens.id, input.tokenId), eq(tokens.version, input.expectedVersion))).returning();
      if (!updated) return callback?.({ error: 'CONFLICT' });
      const projection = { id: updated.id, sceneId: updated.sceneId, name: updated.name, x: updated.x, y: updated.y, color: updated.color, version: updated.version, ownerUserId: updated.ownerUserId };
      callback?.({ ok: true, token: projection });
      ((updated.hidden || !token.scene.isActive) ? io.to(`${room}:gm`) : io.to(room)).emit('token:moved', projection);
    } catch { callback?.({ error: 'INVALID' }); }
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
      const event = { id: message.id, senderId: user.id, displayName: user.displayName, body: message.body, createdAt: message.createdAt, private: Boolean(input.recipientId) };
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
      if (!socket.rooms.has(`campaign:${input.campaignId}`) || !await roleFor(input.campaignId, user.id)) return callback?.({ error: 'FORBIDDEN' });
      const parsed = parseDiceExpression(input.expression);
      if (!parsed) return callback?.({ error: 'INVALID' });
      const { count, sides, modifier } = parsed;
      const rolls = Array.from({ length: count }, () => randomInt(1, sides + 1));
      const result = rolls.reduce((sum, value) => sum + value, modifier);
      const [saved] = await db.insert(diceRolls).values({ campaignId: input.campaignId, userId: user.id, expression: input.expression, result, detail: JSON.stringify({ rolls, modifier }) }).returning();
      const event = { id: saved?.id, userId: user.id, displayName: user.displayName, expression: input.expression, rolls, modifier, result };
      callback?.({ ok: true, roll: event });
      io.to(`campaign:${input.campaignId}`).emit('dice:result', event);
    } catch { callback?.({ error: 'INVALID' }); }
  });
  socket.on('disconnect', () => {
    for (const room of socket.rooms) if (room.startsWith('user:')) void socket.leave(room);
  });
});

app.addHook('onClose', async () => { io.close(); await pool.end(); });
await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
app.log.info({ port }, 'NRI API listening');

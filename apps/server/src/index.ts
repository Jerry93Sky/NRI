import { config } from 'dotenv';
config({ path: '../../.env' });
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { Server } from 'socket.io';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import argon2 from 'argon2';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { adjustTokenResourceSchema, assetCategorySchema, campaignDrawingPermissionSchema, canMoveToken, createCampaignSchema, createSceneLayerSchema, createSceneObjectSchema, createSceneSchema, createTokenSchema, duplicateSceneObjectsSchema, duplicateTokenSchema, duplicateTokensSchema, diceSchema, inviteSchema, loginSchema, moveTokenSchema, parseDiceExpression, registerSchema, updateAssetSchema, updateSceneLayerSchema, updateSceneObjectSchema, updateTokenGroupSchema, updateTokenSchema } from '@nri/contracts';
import { db, pool } from './db/index.js';
import { assets, auditEvents, campaigns, diceRolls, initiativeEntries, initiatives, invitations, memberships, messages, sceneLayers, sceneObjects, scenes, sessions, tokens, users } from './db/schema.js';
import { canListScene, canReadSceneLayer, canReadSceneTokens, type CampaignSceneRole } from './domain/sceneAccess.js';
import { decodeImage, inspectImage } from './domain/imageMetadata.js';
import { assetThumbnailKey, makeAssetThumbnail } from './domain/assetThumbnail.js';

function publicToken(token: typeof tokens.$inferSelect, includeHidden = false, viewerUserId?: string) {
  const { hidden: _hidden, resources: _resources, gmNote: _gmNote, ownerNote: _ownerNote, id, sceneId, name, x, y, color, imageAssetId, width, height, rotation, opacity, borderColor, zIndex, locked, showName, version, ownerUserId } = token;
  const result = { id, sceneId, name, x, y, color, imageAssetId, width, height, rotation, opacity, borderColor, zIndex, locked, showName, version, ownerUserId };
  const resources = includeHidden ? token.resources : token.resources.map((resource) => resource.visible ? { label: resource.label, current: resource.current, maximum: resource.maximum } : null);
  if (includeHidden) return { ...result, resources, hidden: token.hidden, gmNote: token.gmNote, ownerNote: token.ownerNote };
  return { ...result, resources, ...(viewerUserId && viewerUserId === token.ownerUserId ? { ownerNote: token.ownerNote } : {}) };
}

function sceneObjectProjection(object: typeof sceneObjects.$inferSelect, role: CampaignSceneRole, viewerUserId?: string) {
  if (role === 'PLAYER') {
    const { createdBy: _createdBy, ...visibleObject } = object;
    return { ...visibleObject, ownedByMe: Boolean(viewerUserId && object.createdBy === viewerUserId) };
  }
  return object;
}

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers.set-cookie'] }, bodyLimit: 64 * 1024 });
await app.register(cookie);
await app.register(rateLimit, { global: true, max: process.env.NODE_ENV === 'test' ? 500 : 120, timeWindow: '1 minute' });
await app.register(import('@fastify/multipart'), { limits: { files: 12, fileSize: 12 * 1024 * 1024, fields: 0, parts: 12 } });
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

app.post('/api/auth/register', { config: { rateLimit: { max: process.env.NODE_ENV === 'test' ? 20 : 5, timeWindow: '1 hour' } } }, async (request, reply) => {
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
app.put('/api/campaigns/:campaignId/player-drawing', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { campaignId } = request.params as { campaignId: string };
  const input = parseBody(campaignDrawingPermissionSchema, request.body);
  const role = await roleFor(campaignId, user.id);
  if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
  const updated = await db.transaction(async (tx) => {
    const [result] = await tx.update(campaigns).set({ playersCanDraw: input.enabled }).where(eq(campaigns.id, campaignId)).returning({ id: campaigns.id, playersCanDraw: campaigns.playersCanDraw });
    if (result) await tx.insert(auditEvents).values({ campaignId, actorId: user.id, action: 'campaign.player_drawing_changed', targetId: campaignId, detail: input.enabled ? 'enabled' : 'disabled' });
    return result;
  });
  if (!updated) return reply.code(404).send({ error: 'NOT_FOUND' });
  io.to(`campaign:${campaignId}`).emit('campaign:drawing_permission', updated);
  return { playersCanDraw: updated.playersCanDraw };
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
      const [token] = await db.select({ id: tokens.id, hidden: tokens.hidden, deletedAt: tokens.deletedAt }).from(tokens).where(and(eq(tokens.id, entry.tokenId), eq(tokens.sceneId, input.sceneId))).limit(1);
      if (!token || token.deletedAt) return reply.code(400).send({ error: 'INVALID_TOKEN' });
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
  const [layer] = await db.insert(sceneLayers).values({ ...input, sceneId }).returning();
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
  return rows.filter(({ object, layer }) => role !== 'PLAYER' || (object.visible && canReadSceneLayer(role, scene.isActive, false, layer.visibleToPlayers, layer.kind))).map(({ object }) => sceneObjectProjection(object, role, user.id));
});
app.delete('/api/scenes/:sceneId/my-drawings', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { sceneId } = request.params as { sceneId: string };
  const [scene] = await db.select().from(scenes).where(eq(scenes.id, sceneId)).limit(1);
  if (!scene || scene.archivedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
  const role = await roleFor(scene.campaignId, user.id);
  if (!role) return reply.code(403).send({ error: 'FORBIDDEN' });
  if (role === 'PLAYER' && !scene.isActive) return reply.code(404).send({ error: 'NOT_FOUND' });
  const removed = await db.transaction(async (tx) => {
    const owned = await tx.select().from(sceneObjects).where(and(eq(sceneObjects.sceneId, sceneId), eq(sceneObjects.createdBy, user.id), eq(sceneObjects.kind, 'FREEHAND'))).for('update');
    if (owned.length === 0) return [];
    const layerRows = await tx.select().from(sceneLayers).where(inArray(sceneLayers.id, owned.map((object) => object.layerId)));
    const layerById = new Map(layerRows.map((layer) => [layer.id, layer]));
    const deleted = await tx.delete(sceneObjects).where(and(eq(sceneObjects.sceneId, sceneId), inArray(sceneObjects.id, owned.map((object) => object.id)), eq(sceneObjects.createdBy, user.id))).returning({ id: sceneObjects.id, layerId: sceneObjects.layerId, visible: sceneObjects.visible });
    if (deleted.length) await tx.insert(auditEvents).values({ campaignId: scene.campaignId, actorId: user.id, action: 'scene.own_drawings_cleared', targetId: sceneId, detail: String(deleted.length) });
    return deleted.map((object) => ({ ...object, layer: layerById.get(object.layerId) }));
  });
  const room = `campaign:${scene.campaignId}`;
  for (const object of removed) {
    if (scene.isActive && object.visible && object.layer?.visibleToPlayers && object.layer.kind !== 'GM') io.to(room).emit('scene:object_deleted', { sceneId, objectId: object.id });
    else io.to(`${room}:gm`).emit('scene:object_deleted', { sceneId, objectId: object.id });
  }
  return { deletedCount: removed.length };
});
app.post('/api/scenes/:sceneId/objects', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { sceneId } = request.params as { sceneId: string };
  const input = parseBody(createSceneObjectSchema, request.body);
  const [scene] = await db.select().from(scenes).where(eq(scenes.id, sceneId)).limit(1);
  if (!scene) return reply.code(404).send({ error: 'NOT_FOUND' });
  const role = await roleFor(scene.campaignId, user.id);
  if (!role) return reply.code(403).send({ error: 'FORBIDDEN' });
  const canManage = role === 'OWNER' || role === 'GM';
  const [campaign] = await db.select({ playersCanDraw: campaigns.playersCanDraw }).from(campaigns).where(eq(campaigns.id, scene.campaignId)).limit(1);
  const playerDrawingAllowed = role === 'PLAYER' && campaign?.playersCanDraw === true && scene.isActive;
  if (!canManage && !playerDrawingAllowed) return reply.code(403).send({ error: 'FORBIDDEN' });
  if (scene.archivedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
  const [layer] = await db.select().from(sceneLayers).where(and(eq(sceneLayers.id, input.layerId), eq(sceneLayers.sceneId, sceneId))).limit(1);
  if (!layer) return reply.code(400).send({ error: 'INVALID_LAYER' });
  if (layer.locked) return reply.code(409).send({ error: 'LAYER_LOCKED' });
  if (!canManage && (input.kind !== 'FREEHAND' || layer.kind !== 'OBJECTS' || !layer.visibleToPlayers || !input.points || input.points.length < 2 || input.points.length > 2000)) return reply.code(403).send({ error: 'FORBIDDEN' });
  if (layer.kind === 'GM') input.visible = false;
  if (!canManage) { input.visible = true; input.locked = false; input.opacity = 1; input.rotation = 0; input.assetId = null; input.text = null; }
  if (input.assetId) {
    const [asset] = await db.select({ id: assets.id }).from(assets).where(and(eq(assets.id, input.assetId), eq(assets.campaignId, scene.campaignId))).limit(1);
    if (!asset) return reply.code(400).send({ error: 'INVALID_ASSET' });
  }
  const [object] = await db.insert(sceneObjects).values({ ...input, sceneId, createdBy: user.id }).returning();
  if (!object) throw new Error('Scene object creation failed');
  await db.insert(auditEvents).values({ campaignId: scene.campaignId, actorId: user.id, action: 'scene.object_created', targetId: object.id });
  const room = `campaign:${scene.campaignId}`;
  const playerVisible = scene.isActive && layer.visibleToPlayers && object.visible && layer.kind !== 'GM';
  (playerVisible ? io.to(room) : io.to(`${room}:gm`)).emit('scene:object_created', { object: sceneObjectProjection(object, playerVisible ? 'PLAYER' : 'OWNER') });
  return reply.code(201).send({ object: sceneObjectProjection(object, role, user.id) });
});
app.post('/api/scenes/:sceneId/objects/duplicate', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { sceneId } = request.params as { sceneId: string };
  const input = parseBody(duplicateSceneObjectsSchema, request.body);
  const result = await db.transaction(async (tx) => {
    const [scene] = await tx.select().from(scenes).where(eq(scenes.id, sceneId)).for('update').limit(1);
    if (!scene || scene.archivedAt) return { error: 'NOT_FOUND' as const };
    const [membership] = await tx.select({ role: memberships.role }).from(memberships)
      .where(and(eq(memberships.campaignId, scene.campaignId), eq(memberships.userId, user.id))).limit(1);
    if (!membership || !['OWNER', 'GM'].includes(membership.role)) return { error: 'FORBIDDEN' as const };
    const [layer] = await tx.select().from(sceneLayers).where(and(eq(sceneLayers.id, input.layerId), eq(sceneLayers.sceneId, sceneId))).for('update').limit(1);
    if (!layer) return { error: 'INVALID_LAYER' as const };
    if (layer.locked) return { error: 'LAYER_LOCKED' as const };
    if (layer.kind === 'BACKGROUND') return { error: 'INVALID_LAYER' as const };
    const sourceRows = await tx.select().from(sceneObjects)
      .where(and(eq(sceneObjects.sceneId, sceneId), inArray(sceneObjects.id, input.objects.map((item) => item.objectId))))
      .orderBy(asc(sceneObjects.id)).for('update');
    if (sourceRows.length !== input.objects.length) return { error: 'NOT_FOUND' as const };
    const sources = new Map(sourceRows.map((object) => [object.id, object]));
    if (input.objects.some((item) => sources.get(item.objectId)?.version !== item.expectedVersion)) return { error: 'CONFLICT' as const };
    const duplicateRows = input.objects.map((item) => {
      const source = sources.get(item.objectId)!;
      const { id: _sourceId, version: _sourceVersion, ...copy } = source;
      return { ...copy, id: randomUUID(), layerId: layer.id, x: item.x, y: item.y, visible: layer.kind === 'GM' ? false : source.visible, locked: false, version: 1 };
    });
    const created = await tx.insert(sceneObjects).values(duplicateRows).returning();
    const createdById = new Map(created.map((object) => [object.id, object]));
    const objects = duplicateRows.map((object) => createdById.get(object.id)!);
    await tx.insert(auditEvents).values(objects.map((object, index) => ({ campaignId: scene.campaignId, actorId: user.id, action: 'scene.object_duplicated', targetId: object.id, detail: `source:${input.objects[index]!.objectId}` })));
    return { objects, campaignId: scene.campaignId, isActive: scene.isActive, layerVisible: layer.visibleToPlayers, layerKind: layer.kind };
  });
  if ('error' in result) {
    const status = result.error === 'FORBIDDEN' ? 403 : result.error === 'CONFLICT' || result.error === 'LAYER_LOCKED' ? 409 : result.error === 'INVALID_LAYER' ? 400 : 404;
    return reply.code(status).send({ error: result.error });
  }
  const room = `campaign:${result.campaignId}`;
  for (const object of result.objects) {
    if (result.isActive && result.layerVisible && result.layerKind !== 'GM' && object.visible) io.to(room).emit('scene:object_created', { object });
    else io.to(`${room}:gm`).emit('scene:object_created', { object });
  }
  return reply.code(201).send({ objects: result.objects });
});
app.patch('/api/objects/:objectId', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { objectId } = request.params as { objectId: string };
  const input = parseBody(updateSceneObjectSchema, request.body);
  const [row] = await db.select({ object: sceneObjects, layer: sceneLayers, scene: scenes }).from(sceneObjects).innerJoin(sceneLayers, eq(sceneObjects.layerId, sceneLayers.id)).innerJoin(scenes, eq(sceneObjects.sceneId, scenes.id)).where(eq(sceneObjects.id, objectId)).limit(1);
  if (!row) return reply.code(404).send({ error: 'NOT_FOUND' });
  const role = await roleFor(row.scene.campaignId, user.id);
  if (!role) return reply.code(403).send({ error: 'FORBIDDEN' });
  const canManage = role === 'OWNER' || role === 'GM';
  if (!canManage) {
    const [campaign] = await db.select({ playersCanDraw: campaigns.playersCanDraw }).from(campaigns).where(eq(campaigns.id, row.scene.campaignId)).limit(1);
    if (role !== 'PLAYER' || !campaign?.playersCanDraw || !row.scene.isActive || row.object.createdBy !== user.id || row.object.kind !== 'FREEHAND' || row.layer.kind !== 'OBJECTS' || !row.layer.visibleToPlayers) return reply.code(403).send({ error: 'FORBIDDEN' });
  }
  if (row.scene.archivedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
  if (row.layer.locked) return reply.code(409).send({ error: 'LAYER_LOCKED' });
  const { expectedVersion, ...patch } = input;
  const requestedFields = Object.keys(request.body as Record<string, unknown>).filter((field) => field !== 'expectedVersion');
  if (!canManage && requestedFields.some((field) => !['x', 'y', 'width', 'height', 'color', 'strokeWidth', 'points'].includes(field))) return reply.code(403).send({ error: 'FORBIDDEN' });
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
  if (isPublic) io.to(room).emit('scene:object_updated', { object: sceneObjectProjection(updated, 'PLAYER') });
  else io.to(`${room}:gm`).emit('scene:object_updated', { object: updated });
  return { object: sceneObjectProjection(updated, role, user.id) };
});
app.delete('/api/objects/:objectId', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { objectId } = request.params as { objectId: string };
  const input = parseBody(z.object({ expectedVersion: z.number().int().positive() }), request.body);
  const [row] = await db.select({ object: sceneObjects, layer: sceneLayers, scene: scenes }).from(sceneObjects).innerJoin(sceneLayers, eq(sceneObjects.layerId, sceneLayers.id)).innerJoin(scenes, eq(sceneObjects.sceneId, scenes.id)).where(eq(sceneObjects.id, objectId)).limit(1);
  if (!row) return reply.code(404).send({ error: 'NOT_FOUND' });
  const role = await roleFor(row.scene.campaignId, user.id);
  if (!role) return reply.code(403).send({ error: 'FORBIDDEN' });
  const canManage = role === 'OWNER' || role === 'GM';
  if (!canManage && (role !== 'PLAYER' || row.object.kind !== 'FREEHAND' || row.object.createdBy !== user.id)) return reply.code(403).send({ error: 'FORBIDDEN' });
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
    const sourceTokens = await tx.select().from(tokens).where(and(eq(tokens.sceneId, source.id), isNull(tokens.deletedAt)));
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
  const category = assetCategorySchema.safeParse((request.query as { category?: string }).category ?? 'OTHER');
  if (!category.success) return reply.code(400).send({ error: 'INVALID_CATEGORY' });
  const uploaded: Array<{ id: string; name: string; category: string; mediaType: string; size: number; width: number; height: number }> = [];
  const failures: Array<{ filename: string; error: string }> = [];
  for await (const file of request.files()) {
    let buffer: Buffer;
    try { buffer = await file.toBuffer(); }
    catch { failures.push({ filename: file.filename, error: 'FILE_TOO_LARGE' }); continue; }
    let metadata: ReturnType<typeof inspectImage>;
    try {
      metadata = inspectImage(buffer);
      await decodeImage(buffer, metadata);
    }
    catch (error) { failures.push({ filename: file.filename, error: error instanceof Error ? error.message : 'INVALID_IMAGE' }); continue; }
    const extension = metadata.mediaType === 'image/png' ? '.png' : metadata.mediaType === 'image/jpeg' ? '.jpg' : '.webp';
    const storageKey = `${randomBytes(24).toString('hex')}${extension}`;
    const thumbnailKey = assetThumbnailKey(storageKey);
    const filename = file.filename.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) || 'Untitled image';
    await mkdir(uploadDirectory, { recursive: true });
    const destination = resolve(uploadDirectory, storageKey);
    const thumbnailDestination = resolve(uploadDirectory, thumbnailKey);
    try {
      await writeFile(destination, buffer, { flag: 'wx', mode: 0o600 });
      await writeFile(thumbnailDestination, await makeAssetThumbnail(buffer), { flag: 'wx', mode: 0o600 });
      const [asset] = await db.insert(assets).values({ campaignId, name: filename, category: category.data, storageKey, mediaType: metadata.mediaType, size: buffer.byteLength, checksum: createHash('sha256').update(buffer).digest('hex'), uploaderId: user.id }).returning();
      if (!asset) throw new Error('Asset metadata creation failed');
      await db.insert(auditEvents).values({ campaignId, actorId: user.id, action: 'asset.uploaded', targetId: asset.id });
      uploaded.push({ id: asset.id, name: asset.name, category: asset.category, mediaType: asset.mediaType, size: asset.size, width: metadata.width, height: metadata.height });
    } catch (error) {
      await Promise.all([unlink(destination).catch(() => {}), unlink(thumbnailDestination).catch(() => {})]);
      throw error;
    }
  }
  if (!uploaded.length && !failures.length) return reply.code(400).send({ error: 'FILE_REQUIRED' });
  const status = failures.length ? uploaded.length ? 207 : failures[0]?.error === 'FILE_TOO_LARGE' ? 413 : 415 : 201;
  if (!uploaded.length) return reply.code(status).send({ error: failures[0]?.error ?? 'UPLOAD_FAILED', assets: uploaded, failures });
  return reply.code(status).send({ assets: uploaded, asset: uploaded[0], failures });
});
app.get('/api/campaigns/:campaignId/assets', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { campaignId } = request.params as { campaignId: string };
  const role = await roleFor(campaignId, user.id);
  if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
  const [rows, mapRefs, objectRefs, tokenRefs] = await Promise.all([
    db.select().from(assets).where(eq(assets.campaignId, campaignId)).orderBy(asc(assets.name)),
    db.select({ assetId: scenes.backgroundAssetId, uses: sql<number>`count(*)::int` }).from(scenes).where(eq(scenes.campaignId, campaignId)).groupBy(scenes.backgroundAssetId),
    db.select({ assetId: sceneObjects.assetId, uses: sql<number>`count(*)::int` }).from(sceneObjects).innerJoin(scenes, eq(sceneObjects.sceneId, scenes.id)).where(eq(scenes.campaignId, campaignId)).groupBy(sceneObjects.assetId),
    db.select({ assetId: tokens.imageAssetId, uses: sql<number>`count(*)::int` }).from(tokens).innerJoin(scenes, eq(tokens.sceneId, scenes.id)).where(eq(scenes.campaignId, campaignId)).groupBy(tokens.imageAssetId),
  ]);
  const uses = new Map<string, number>();
  for (const ref of [...mapRefs, ...objectRefs, ...tokenRefs]) if (ref.assetId) uses.set(ref.assetId, (uses.get(ref.assetId) ?? 0) + ref.uses);
  const storageBytes = rows.reduce((total, asset) => total + asset.size, 0);
  return { assets: rows.map((asset) => ({ id: asset.id, name: asset.name, category: asset.category, mediaType: asset.mediaType, size: asset.size, checksum: asset.checksum, usageCount: uses.get(asset.id) ?? 0 })), storageBytes, assetCount: rows.length };
});
app.patch('/api/assets/:assetId', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { assetId } = request.params as { assetId: string };
  const input = parseBody(updateAssetSchema, request.body);
  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
  if (!asset) return reply.code(404).send({ error: 'NOT_FOUND' });
  const role = await roleFor(asset.campaignId, user.id);
  if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
  const [updated] = await db.update(assets).set(input).where(eq(assets.id, assetId)).returning();
  if (!updated) return reply.code(404).send({ error: 'NOT_FOUND' });
  await db.insert(auditEvents).values({ campaignId: asset.campaignId, actorId: user.id, action: 'asset.updated', targetId: asset.id });
  return { asset: { id: updated.id, name: updated.name, category: updated.category, mediaType: updated.mediaType, size: updated.size } };
});
app.delete('/api/assets/:assetId', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { assetId } = request.params as { assetId: string };
  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
  if (!asset) return reply.code(404).send({ error: 'NOT_FOUND' });
  const role = await roleFor(asset.campaignId, user.id);
  if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
  const removed = await db.transaction(async (tx) => {
    const [lockedAsset] = await tx.select({ id: assets.id }).from(assets).where(and(eq(assets.id, asset.id), eq(assets.campaignId, asset.campaignId))).for('update').limit(1);
    if (!lockedAsset) return false;
    const refs = await Promise.all([
      tx.select({ id: scenes.id }).from(scenes).where(eq(scenes.backgroundAssetId, asset.id)).limit(1),
      tx.select({ id: sceneObjects.id }).from(sceneObjects).where(eq(sceneObjects.assetId, asset.id)).limit(1),
      tx.select({ id: tokens.id }).from(tokens).where(eq(tokens.imageAssetId, asset.id)).limit(1),
    ]);
    if (refs.some((items) => items.length)) return false;
    const [deleted] = await tx.delete(assets).where(and(eq(assets.id, asset.id), eq(assets.campaignId, asset.campaignId))).returning({ id: assets.id });
    if (!deleted) return false;
    await tx.insert(auditEvents).values({ campaignId: asset.campaignId, actorId: user.id, action: 'asset.deleted', targetId: asset.id });
    return true;
  });
  if (!removed) return reply.code(409).send({ error: 'ASSET_IN_USE' });
  await Promise.all([
    unlink(resolve(uploadDirectory, asset.storageKey)).catch((error: unknown) => app.log.error({ err: error, assetId: asset.id }, 'Deleted asset file cleanup failed')),
    unlink(resolve(uploadDirectory, assetThumbnailKey(asset.storageKey))).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') app.log.error({ err: error, assetId: asset.id }, 'Deleted asset thumbnail cleanup failed'); }),
  ]);
  return reply.code(204).send();
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
  const variant = (request.query as { variant?: string }).variant;
  if (variant !== undefined && variant !== 'thumbnail') return reply.code(400).send({ error: 'INVALID_VARIANT' });
  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
  if (!asset) return reply.code(404).send({ error: 'NOT_FOUND' });
  const role = await roleFor(asset.campaignId, user.id);
  if (!role) return reply.code(404).send({ error: 'NOT_FOUND' });
  if (!['OWNER', 'GM'].includes(role)) {
    const [visibleMap] = await db.select({ id: scenes.id }).from(scenes).where(and(eq(scenes.campaignId, asset.campaignId), eq(scenes.backgroundAssetId, asset.id), eq(scenes.isActive, true), isNull(scenes.archivedAt))).limit(1);
    const [visibleObject] = await db.select({ id: sceneObjects.id }).from(sceneObjects).innerJoin(sceneLayers, eq(sceneObjects.layerId, sceneLayers.id)).innerJoin(scenes, eq(sceneObjects.sceneId, scenes.id)).where(and(eq(scenes.campaignId, asset.campaignId), eq(scenes.isActive, true), isNull(scenes.archivedAt), eq(sceneObjects.assetId, asset.id), eq(sceneObjects.visible, true), eq(sceneLayers.visibleToPlayers, true), sql`${sceneLayers.kind} <> 'GM'`)).limit(1);
    const [visibleToken] = await db.select({ id: tokens.id }).from(tokens).innerJoin(scenes, eq(tokens.sceneId, scenes.id)).where(and(eq(scenes.campaignId, asset.campaignId), eq(scenes.isActive, true), isNull(scenes.archivedAt), eq(tokens.imageAssetId, asset.id), eq(tokens.hidden, false))).limit(1);
    if (!visibleMap && !visibleObject && !visibleToken) return reply.code(404).send({ error: 'NOT_FOUND' });
  }
  if (variant === 'thumbnail') {
    const thumbnailPath = resolve(uploadDirectory, assetThumbnailKey(asset.storageKey));
    let thumbnail: Buffer;
    try { thumbnail = await readFile(thumbnailPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const original = await readFile(resolve(uploadDirectory, asset.storageKey));
      thumbnail = await makeAssetThumbnail(original);
      try { await writeFile(thumbnailPath, thumbnail, { flag: 'wx', mode: 0o600 }); }
      catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
        thumbnail = await readFile(thumbnailPath);
      }
    }
    return reply.type('image/webp').header('x-content-type-options', 'nosniff').header('cache-control', 'private, max-age=3600').send(thumbnail);
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
  const rows = await db.select().from(tokens).where(and(eq(tokens.sceneId, sceneId), isNull(tokens.deletedAt)));
  return rows.filter((token) => !token.hidden || role === 'OWNER' || role === 'GM').map((token) => publicToken(token, role === 'OWNER' || role === 'GM', user.id));
});
app.post('/api/tokens', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const input = parseBody(createTokenSchema, request.body);
  const [scene] = await db.select().from(scenes).where(eq(scenes.id, input.sceneId)).limit(1);
  if (!scene) return reply.code(404).send({ error: 'NOT_FOUND' });
  const role = await roleFor(scene.campaignId, user.id);
  if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
  if (scene.archivedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
  if (input.imageAssetId) {
    const [asset] = await db.select({ id: assets.id }).from(assets).where(and(eq(assets.id, input.imageAssetId), eq(assets.campaignId, scene.campaignId), eq(assets.category, 'TOKEN'))).limit(1);
    if (!asset) return reply.code(400).send({ error: 'INVALID_ASSET' });
  }
  const [token] = await db.insert(tokens).values(input).returning();
  if (!token) throw new Error('Token creation failed');
  const projection = publicToken(token, true); const playerProjection = publicToken(token);
  const room = `campaign:${scene.campaignId}`;
  ((token.hidden || !scene.isActive) ? io.to(`${room}:gm`) : io.to(room)).emit('token:created', token.hidden || !scene.isActive ? projection : playerProjection);
  return reply.code(201).send({ token: projection });
});
app.post('/api/tokens/:tokenId/duplicate', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { tokenId } = request.params as { tokenId: string };
  const input = parseBody(duplicateTokenSchema, request.body);
  const result = await db.transaction(async (tx) => {
    const [source] = await tx.select({ token: tokens, scene: scenes }).from(tokens).innerJoin(scenes, eq(tokens.sceneId, scenes.id))
      .where(and(eq(tokens.id, tokenId), isNull(tokens.deletedAt), isNull(scenes.archivedAt))).for('update').limit(1);
    if (!source) return { error: 'NOT_FOUND' as const };
    const [destination] = await tx.select().from(scenes).where(eq(scenes.id, input.sceneId)).for('update').limit(1);
    if (!destination || destination.archivedAt || destination.campaignId !== source.scene.campaignId) return { error: 'NOT_FOUND' as const };
    const [membership] = await tx.select({ role: memberships.role }).from(memberships)
      .where(and(eq(memberships.campaignId, source.scene.campaignId), eq(memberships.userId, user.id))).limit(1);
    if (!membership || !['OWNER', 'GM'].includes(membership.role)) return { error: 'FORBIDDEN' as const };
    if (source.token.version !== input.expectedVersion) return { error: 'CONFLICT' as const };
    const { id: _sourceId, sceneId: _sourceSceneId, version: _sourceVersion, deletedAt: _deletedAt, ownerUserId: _ownerUserId, ownerNote: _ownerNote, ...copied } = source.token;
    const [token] = await tx.insert(tokens).values({
      ...copied,
      sceneId: destination.id,
      name: `${source.token.name} copy`.slice(0, 48),
      x: input.x,
      y: input.y,
      ownerUserId: null,
      ownerNote: '',
      version: 1,
      deletedAt: null,
    }).returning();
    if (!token) throw new Error('Token duplication failed');
    await tx.insert(auditEvents).values({ campaignId: source.scene.campaignId, actorId: user.id, action: 'token.duplicated', targetId: token.id, detail: `source:${source.token.id}` });
    return { token, campaignId: destination.campaignId, isActive: destination.isActive };
  });
  if ('error' in result) return reply.code(result.error === 'FORBIDDEN' ? 403 : result.error === 'CONFLICT' ? 409 : 404).send({ error: result.error });
  const room = `campaign:${result.campaignId}`;
  ((result.token.hidden || !result.isActive) ? io.to(`${room}:gm`) : io.to(room)).emit('token:created', result.token.hidden || !result.isActive ? publicToken(result.token, true) : publicToken(result.token));
  return reply.code(201).send({ token: publicToken(result.token, true) });
});
app.post('/api/scenes/:sceneId/tokens/duplicate', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { sceneId } = request.params as { sceneId: string };
  const input = parseBody(duplicateTokensSchema, request.body);
  if (input.sceneId !== sceneId) return reply.code(400).send({ error: 'SCENE_MISMATCH' });
  const result = await db.transaction(async (tx) => {
    const [destination] = await tx.select().from(scenes).where(eq(scenes.id, sceneId)).for('update').limit(1);
    if (!destination || destination.archivedAt) return { error: 'NOT_FOUND' as const };
    const [membership] = await tx.select({ role: memberships.role }).from(memberships)
      .where(and(eq(memberships.campaignId, destination.campaignId), eq(memberships.userId, user.id))).limit(1);
    if (!membership || !['OWNER', 'GM'].includes(membership.role)) return { error: 'FORBIDDEN' as const };
    const sourceRows = await tx.select({ token: tokens, scene: scenes }).from(tokens).innerJoin(scenes, eq(tokens.sceneId, scenes.id))
      .where(and(inArray(tokens.id, input.tokens.map((item) => item.tokenId)), isNull(tokens.deletedAt), isNull(scenes.archivedAt)))
      .orderBy(asc(tokens.id)).for('update');
    if (sourceRows.length !== input.tokens.length || sourceRows.some(({ scene: sourceScene }) => sourceScene.campaignId !== destination.campaignId)) return { error: 'NOT_FOUND' as const };
    const sources = new Map(sourceRows.map(({ token }) => [token.id, token]));
    if (input.tokens.some((item) => sources.get(item.tokenId)?.version !== item.expectedVersion)) return { error: 'CONFLICT' as const };
    const duplicates = input.tokens.map((item) => {
      const source = sources.get(item.tokenId)!;
      const { id: _sourceId, sceneId: _sourceSceneId, version: _sourceVersion, deletedAt: _deletedAt, ownerUserId: _ownerUserId, ownerNote: _ownerNote, ...copied } = source;
      return { ...copied, id: randomUUID(), sceneId: destination.id, name: `${source.name} copy`.slice(0, 48), x: item.x, y: item.y, ownerUserId: null, ownerNote: '', version: 1, deletedAt: null };
    });
    const created = await tx.insert(tokens).values(duplicates).returning();
    await tx.insert(auditEvents).values(created.map((token, index) => ({ campaignId: destination.campaignId, actorId: user.id, action: 'token.duplicated', targetId: token.id, detail: `source:${input.tokens[index]!.tokenId}` })));
    const byId = new Map(created.map((token) => [token.id, token]));
    return { tokens: duplicates.map(({ id }) => byId.get(id)!), campaignId: destination.campaignId, isActive: destination.isActive };
  });
  if ('error' in result) return reply.code(result.error === 'FORBIDDEN' ? 403 : result.error === 'CONFLICT' ? 409 : 404).send({ error: result.error });
  const room = `campaign:${result.campaignId}`;
  for (const token of result.tokens) {
    ((token.hidden || !result.isActive) ? io.to(`${room}:gm`) : io.to(room)).emit('token:created', token.hidden || !result.isActive ? publicToken(token, true) : publicToken(token));
  }
  return reply.code(201).send({ tokens: result.tokens.map((token) => publicToken(token, true)) });
});
app.get('/api/campaigns/:campaignId/token-trash', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { campaignId } = request.params as { campaignId: string };
  const role = await roleFor(campaignId, user.id);
  if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
  return db.select({ id: tokens.id, sceneId: tokens.sceneId, sceneTitle: scenes.title, name: tokens.name, version: tokens.version, deletedAt: tokens.deletedAt, sceneArchivedAt: scenes.archivedAt }).from(tokens).innerJoin(scenes, eq(tokens.sceneId, scenes.id)).where(and(eq(scenes.campaignId, campaignId), sql`${tokens.deletedAt} IS NOT NULL`)).orderBy(desc(tokens.deletedAt));
});
app.delete('/api/tokens/:tokenId', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { tokenId } = request.params as { tokenId: string };
  const input = parseBody(z.object({ expectedVersion: z.number().int().positive() }), request.body);
  const [row] = await db.select({ token: tokens, scene: scenes }).from(tokens).innerJoin(scenes, eq(tokens.sceneId, scenes.id)).where(eq(tokens.id, tokenId)).limit(1);
  if (!row || row.scene.archivedAt || row.token.deletedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
  const role = await roleFor(row.scene.campaignId, user.id);
  if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
  const [deleted] = await db.update(tokens).set({ deletedAt: new Date(), version: row.token.version + 1 }).where(and(eq(tokens.id, tokenId), eq(tokens.version, input.expectedVersion), isNull(tokens.deletedAt))).returning({ id: tokens.id });
  if (!deleted) return reply.code(409).send({ error: 'CONFLICT' });
  await db.insert(auditEvents).values({ campaignId: row.scene.campaignId, actorId: user.id, action: 'token.deleted', targetId: tokenId });
  if (row.scene.isActive && !row.token.hidden) io.to(`campaign:${row.scene.campaignId}`).emit('token:hidden', { id: tokenId, sceneId: row.scene.id });
  return reply.code(204).send();
});
app.post('/api/tokens/:tokenId/restore', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { tokenId } = request.params as { tokenId: string };
  const input = parseBody(z.object({ expectedVersion: z.number().int().positive() }), request.body);
  const [row] = await db.select({ token: tokens, scene: scenes }).from(tokens).innerJoin(scenes, eq(tokens.sceneId, scenes.id)).where(eq(tokens.id, tokenId)).limit(1);
  if (!row || row.scene.archivedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
  const role = await roleFor(row.scene.campaignId, user.id);
  if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
  if (!row.token.deletedAt) return reply.code(409).send({ error: 'NOT_DELETED' });
  const [restored] = await db.update(tokens).set({ deletedAt: null, version: row.token.version + 1 }).where(and(eq(tokens.id, tokenId), eq(tokens.version, input.expectedVersion), isNotNull(tokens.deletedAt))).returning();
  if (!restored) return reply.code(409).send({ error: 'CONFLICT' });
  await db.insert(auditEvents).values({ campaignId: row.scene.campaignId, actorId: user.id, action: 'token.restored', targetId: tokenId });
  const room = `campaign:${row.scene.campaignId}`;
  if (row.scene.isActive && !restored.hidden) io.to(room).emit('token:created', publicToken(restored));
  else io.to(`${room}:gm`).emit('token:created', publicToken(restored, true));
  return { token: publicToken(restored, true) };
});
app.patch('/api/scenes/:sceneId/tokens/group', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { sceneId } = request.params as { sceneId: string };
  const input = parseBody(updateTokenGroupSchema, request.body);
  const [scene] = await db.select().from(scenes).where(eq(scenes.id, sceneId)).limit(1);
  if (!scene || scene.archivedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
  const role = await roleFor(scene.campaignId, user.id);
  if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
  const ids = input.updates.map((item) => item.tokenId);
  const result = await db.transaction(async (tx) => {
    const rows = await tx.select().from(tokens).where(and(eq(tokens.sceneId, sceneId), inArray(tokens.id, ids))).for('update');
    if (rows.length !== input.updates.length || rows.some((row) => row.deletedAt)) return { error: 'NOT_FOUND' as const };
    const byId = new Map(rows.map((row) => [row.id, row]));
    if (input.updates.some((item) => byId.get(item.tokenId)?.version !== item.expectedVersion)) return { error: 'CONFLICT' as const };
    const updated = [];
    for (const item of input.updates) {
      const previous = byId.get(item.tokenId)!;
      const [next] = await tx.update(tokens).set({ ...item.patch, version: previous.version + 1 }).where(and(eq(tokens.id, previous.id), eq(tokens.version, item.expectedVersion), isNull(tokens.deletedAt))).returning();
      if (!next) throw new Error('Locked group token changed during transaction');
      updated.push({ previous, token: next });
      await tx.insert(auditEvents).values({ campaignId: scene.campaignId, actorId: user.id, action: 'token.group_updated', targetId: next.id });
    }
    return { updated };
  });
  if ('error' in result) return reply.code(result.error === 'CONFLICT' ? 409 : 404).send({ error: result.error });
  const room = `campaign:${scene.campaignId}`;
  for (const { previous, token } of result.updated) {
    if (scene.isActive && !previous.hidden && token.hidden) io.to(room).emit('token:hidden', { id: token.id, sceneId });
    else if (scene.isActive && !token.hidden) io.to(room).emit(previous.hidden ? 'token:created' : 'token:updated', publicToken(token));
    io.to(`${room}:gm`).emit('token:updated', publicToken(token, true));
  }
  return { tokens: result.updated.map(({ token }) => publicToken(token, true)) };
});
app.patch('/api/tokens/:tokenId', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { tokenId } = request.params as { tokenId: string };
  const input = parseBody(updateTokenSchema, request.body);
  const { expectedVersion, ...patch } = input;
  const [row] = await db.select({ token: tokens, scene: scenes }).from(tokens).innerJoin(scenes, eq(tokens.sceneId, scenes.id)).where(eq(tokens.id, tokenId)).limit(1);
  if (!row || row.scene.archivedAt || row.token.deletedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
  const role = await roleFor(row.scene.campaignId, user.id);
  if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
  if (patch.imageAssetId) {
    const [asset] = await db.select({ id: assets.id }).from(assets).where(and(eq(assets.id, patch.imageAssetId), eq(assets.campaignId, row.scene.campaignId), eq(assets.category, 'TOKEN'))).limit(1);
    if (!asset) return reply.code(400).send({ error: 'INVALID_ASSET' });
  }
  const [updated] = await db.update(tokens).set({ ...patch, version: row.token.version + 1 }).where(and(eq(tokens.id, tokenId), eq(tokens.version, expectedVersion))).returning();
  if (!updated) return reply.code(409).send({ error: 'CONFLICT' });
  await db.insert(auditEvents).values({ campaignId: row.scene.campaignId, actorId: user.id, action: 'token.updated', targetId: tokenId });
  const room = `campaign:${row.scene.campaignId}`; const wasVisible = !row.token.hidden && row.scene.isActive; const isVisible = !updated.hidden && row.scene.isActive; const projection = publicToken(updated, true); const playerProjection = publicToken(updated);
  if (!updated.hidden && row.scene.isActive && updated.ownerUserId && updated.ownerNote !== row.token.ownerNote) io.to(`user:${updated.ownerUserId}`).emit('token:owner_note', { id: updated.id, ownerUserId: updated.ownerUserId, ownerNote: updated.ownerNote, version: updated.version });
  if (wasVisible && !isVisible) io.to(room).emit('token:hidden', { id: updated.id, sceneId: updated.sceneId });
  else if (isVisible) io.to(room).emit(wasVisible ? 'token:updated' : 'token:created', playerProjection);
  io.to(`${room}:gm`).emit('token:updated', projection);
  return { token: projection };
});
app.post('/api/tokens/:tokenId/resources/adjust', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { tokenId } = request.params as { tokenId: string };
  const input = parseBody(adjustTokenResourceSchema, request.body);
  const [row] = await db.select({ token: tokens, scene: scenes }).from(tokens).innerJoin(scenes, eq(tokens.sceneId, scenes.id)).where(eq(tokens.id, tokenId)).limit(1);
  if (!row || row.scene.archivedAt || row.token.deletedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
  const role = await roleFor(row.scene.campaignId, user.id);
  if (!role || (!['OWNER', 'GM'].includes(role) && (row.token.hidden || !row.scene.isActive || row.token.ownerUserId !== user.id || !row.token.resources[input.resourceIndex].visible))) return reply.code(403).send({ error: 'FORBIDDEN' });
  if (row.token.version !== input.expectedVersion) return reply.code(409).send({ error: 'CONFLICT' });
  const resources = structuredClone(row.token.resources); const resource = resources[input.resourceIndex]; const current = resource.current + input.delta;
  if (current < 0 || current > resource.maximum) return reply.code(409).send({ error: 'RESOURCE_LIMIT' });
  resources[input.resourceIndex] = { ...resource, current };
  const [updated] = await db.update(tokens).set({ resources, version: row.token.version + 1 }).where(and(eq(tokens.id, tokenId), eq(tokens.version, input.expectedVersion))).returning();
  if (!updated) return reply.code(409).send({ error: 'CONFLICT' });
  await db.insert(auditEvents).values({ campaignId: row.scene.campaignId, actorId: user.id, action: 'token.resource_adjusted', targetId: tokenId });
  const room = `campaign:${row.scene.campaignId}`; const projection = publicToken(updated, true); const playerProjection = publicToken(updated);
  if (!updated.hidden && row.scene.isActive) io.to(room).emit('token:updated', playerProjection);
  io.to(`${room}:gm`).emit('token:updated', projection);
  return { token: role === 'OWNER' || role === 'GM' ? projection : playerProjection };
});
app.post('/api/tokens/:tokenId/owner', async (request, reply) => {
  const user = await requireUser(request, reply); if (!user) return;
  const { tokenId } = request.params as { tokenId: string };
  const input = parseBody(z.object({ ownerUserId: z.uuid().nullable() }), request.body);
  const [row] = await db.select({ token: tokens, scene: scenes }).from(tokens).innerJoin(scenes, eq(tokens.sceneId, scenes.id)).where(eq(tokens.id, tokenId)).limit(1);
  if (!row || row.token.deletedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
  const role = await roleFor(row.scene.campaignId, user.id);
  if (!role || !['OWNER', 'GM'].includes(role)) return reply.code(403).send({ error: 'FORBIDDEN' });
  if (row.scene.archivedAt) return reply.code(404).send({ error: 'NOT_FOUND' });
  if (input.ownerUserId && !await roleFor(row.scene.campaignId, input.ownerUserId)) return reply.code(400).send({ error: 'INVALID_OWNER' });
  const [updated] = await db.update(tokens).set({ ownerUserId: input.ownerUserId, version: row.token.version + 1 }).where(and(eq(tokens.id, tokenId), eq(tokens.version, row.token.version))).returning();
  if (!updated) return reply.code(409).send({ error: 'CONFLICT' });
  await db.insert(auditEvents).values({ campaignId: row.scene.campaignId, actorId: user.id, action: 'token.owner_changed', targetId: tokenId });
  if (!updated.hidden && row.scene.isActive) for (const memberId of new Set([row.token.ownerUserId, updated.ownerUserId].filter((id): id is string => Boolean(id)))) io.to(`user:${memberId}`).emit('token:owner_note', { id: updated.id, ownerUserId: updated.ownerUserId, ownerNote: updated.ownerNote, version: updated.version });
  const projection = publicToken(updated, true); const playerProjection = publicToken(updated);
  ((updated.hidden || !row.scene.isActive) ? io.to(`campaign:${row.scene.campaignId}:gm`) : io.to(`campaign:${row.scene.campaignId}`)).emit('token:updated', updated.hidden || !row.scene.isActive ? projection : playerProjection);
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
  let lastPointerAt = 0;
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
      const input = parseBody(moveTokenSchema, raw);
      const [token] = await db.select({ token: tokens, scene: scenes }).from(tokens).innerJoin(scenes, eq(tokens.sceneId, scenes.id)).where(eq(tokens.id, input.tokenId)).limit(1);
      if (!token || token.token.deletedAt) return callback?.({ error: 'NOT_FOUND' });
      const room = `campaign:${token.scene.campaignId}`;
      if (!socket.rooms.has(room)) return callback?.({ error: 'FORBIDDEN' });
      const role = await roleFor(token.scene.campaignId, user.id);
      if (!role || token.scene.archivedAt || (!['OWNER', 'GM'].includes(role) && !token.scene.isActive)) return callback?.({ error: 'FORBIDDEN' });
      if (!canMoveToken(role, user.id, token.token.ownerUserId, token.token.hidden) || token.token.locked) return callback?.({ error: 'FORBIDDEN' });
      const [updated] = await db.update(tokens).set({ x: input.x, y: input.y, version: token.token.version + 1 }).where(and(eq(tokens.id, input.tokenId), eq(tokens.version, input.expectedVersion))).returning();
      if (!updated) {
        const [current] = await db.select({ token: tokens, scene: scenes }).from(tokens).innerJoin(scenes, eq(tokens.sceneId, scenes.id)).where(and(eq(tokens.id, input.tokenId), isNull(tokens.deletedAt))).limit(1);
        const currentRole = current ? await roleFor(current.scene.campaignId, user.id) : null;
        const stillAllowed = Boolean(current && currentRole && !current.scene.archivedAt && (currentRole === 'OWNER' || currentRole === 'GM' || current.scene.isActive) && !current.token.locked && canMoveToken(currentRole, user.id, current.token.ownerUserId, current.token.hidden));
        const latest = stillAllowed && current && currentRole ? publicToken(current.token, currentRole === 'OWNER' || currentRole === 'GM', user.id) : undefined;
        return callback?.({ error: 'CONFLICT', ...(latest ? { token: latest } : {}) });
      }
      const projection = publicToken(updated, true); const playerProjection = publicToken(updated);
      callback?.({ ok: true, token: role === 'OWNER' || role === 'GM' ? projection : playerProjection });
      ((updated.hidden || !token.scene.isActive) ? io.to(`${room}:gm`) : io.to(room)).emit('token:moved', updated.hidden || !token.scene.isActive ? projection : playerProjection);
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
  socket.on('disconnect', () => {
    for (const room of socket.rooms) if (room.startsWith('user:')) void socket.leave(room);
  });
});

app.addHook('onClose', async () => { io.close(); await pool.end(); });
await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
app.log.info({ port }, 'NRI API listening');

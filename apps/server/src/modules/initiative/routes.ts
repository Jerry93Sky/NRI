import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { auditEvents, initiativeEntries, initiatives, scenes, tokens } from '../../db/schema.js';
import type { FastifyInstance } from 'fastify';
import type { Server } from 'socket.io';
import { parseBody, requireUser, roleFor } from '../../security/access.js';

export function registerInitiativeRoutes(app: FastifyInstance, io: Server) {
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
    io.to(`campaign:${campaignId}`).emit('initiative:updated', { ...publicView, campaignId });
    io.to(`campaign:${campaignId}:gm`).emit('initiative:gm_updated', { ...gmView, campaignId });
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
}

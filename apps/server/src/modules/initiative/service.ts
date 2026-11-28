import { idSchema } from '@nri/contracts';
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { auditEvents, initiativeEntries, initiatives, scenes, tokens } from '../../db/schema.js';
import { commandSessionIsActive, lockCampaignActor, type Transaction } from '../../security/commandAccess.js';

export const startInitiativeSchema = z.object({ sceneId: idSchema, entries: z.array(z.object({
  tokenId: idSchema.nullable(), label: z.string().trim().min(1).max(64), score: z.number().int().min(-9999).max(9999),
  hidden: z.boolean().default(false),
})).min(1).max(100) });
export const initiativeVersionSchema = z.object({ expectedVersion: z.number().int().positive() });

type Tracker = typeof initiatives.$inferSelect;
type Entry = typeof initiativeEntries.$inferSelect;
type Snapshot = { tracker: Tracker | undefined; entries: Entry[]; available: boolean };
type Command = { action: 'start'; input: z.infer<typeof startInitiativeSchema> }
  | { action: 'advance' | 'stop'; input: z.infer<typeof initiativeVersionSchema> };

async function lockInitiativeScene(tx: Transaction, campaignId: string, sceneId: string) {
  const [scene] = await tx.select({ id: scenes.id, isActive: scenes.isActive }).from(scenes)
    .where(and(eq(scenes.id, sceneId), eq(scenes.campaignId, campaignId), isNull(scenes.archivedAt))).for('share').limit(1);
  return scene;
}

async function scopedTokens(tx: Transaction, sceneId: string, entries: { tokenId: string | null }[]) {
  const ids = [...new Set(entries.flatMap(({ tokenId }) => tokenId ? [tokenId.toLowerCase()] : []))];
  if (ids.length === 0) return new Map<string, boolean>();
  const rows = await tx.select({ id: tokens.id, hidden: tokens.hidden, deletedAt: tokens.deletedAt }).from(tokens)
    .where(and(eq(tokens.sceneId, sceneId), inArray(tokens.id, ids))).orderBy(asc(tokens.id)).for('share');
  return new Map(rows.filter(({ deletedAt }) => !deletedAt).map(({ id, hidden }) => [id, hidden]));
}

async function entriesFor(tx: Transaction, trackerId: string) {
  return tx.select().from(initiativeEntries).where(eq(initiativeEntries.trackerId, trackerId))
    .orderBy(desc(initiativeEntries.score), asc(initiativeEntries.tieOrder), asc(initiativeEntries.id));
}

// All initiative writes and scene activation/archive hold the campaign write gate. This reader
// runs under that gate or the shared audience/actor gate, so tracker and entry queries agree.
export async function readInitiative(tx: Transaction, campaignId: string, expectedVersion?: number): Promise<Snapshot | undefined> {
  const [tracker] = await tx.select().from(initiatives).where(eq(initiatives.campaignId, campaignId)).limit(1);
  if (expectedVersion !== undefined && tracker?.version !== expectedVersion) return;
  const scene = tracker?.sceneId ? await lockInitiativeScene(tx, campaignId, tracker.sceneId) : undefined;
  if (!tracker || !scene?.isActive) return { tracker, entries: [], available: false };
  const entries = await entriesFor(tx, tracker.id);
  const current = await scopedTokens(tx, scene.id, entries);
  return { tracker, available: true, entries: entries.map((entry) => ({
    ...entry, hidden: entry.hidden || (entry.tokenId !== null && current.get(entry.tokenId) !== false),
  })) };
}

export function initiativeProjection({ tracker, entries, available }: Snapshot, manager: boolean) {
  if (!tracker) return { tracker: null, entries: [] };
  const current = entries[tracker.activeIndex];
  return {
    tracker: { id: tracker.id, active: available && tracker.active, round: available ? tracker.round : 1, version: tracker.version,
      ...(manager && available ? { activeIndex: tracker.activeIndex } : {}),
      currentEntryId: current && (manager || !current.hidden) ? current.id : null },
    entries: entries.filter((entry) => manager || !entry.hidden).map(({ hidden: _hidden, ...entry }) => entry),
  };
}

export async function changeInitiative(tokenHash: string, campaignId: string, command: Command) {
  return db.transaction(async (tx) => {
    const actor = await lockCampaignActor(tx, tokenHash, campaignId, { strength: 'no key update' });
    if ('error' in actor) return { error: actor.error } as const;
    if (actor.role === 'PLAYER') return { error: 'FORBIDDEN' } as const;
    const [previous] = await tx.select().from(initiatives).where(eq(initiatives.campaignId, campaignId)).limit(1);
    const sceneId = command.action === 'start' ? command.input.sceneId : previous?.sceneId;
    if (!sceneId) return { error: 'CONFLICT' } as const;
    const scene = await lockInitiativeScene(tx, campaignId, sceneId);
    if (!scene) return { error: command.action === 'start' ? 'NOT_FOUND' : 'CONFLICT' } as const;
    if (!scene.isActive) return { error: 'SCENE_NOT_ACTIVE' } as const;

    let next: Tracker | undefined;
    let entries: Entry[];
    if (command.action === 'start') {
      if (previous?.active) return { error: 'CONFLICT' } as const;
      const current = await scopedTokens(tx, scene.id, command.input.entries);
      const supplied = command.input.entries.map((entry) => ({ ...entry, tokenId: entry.tokenId?.toLowerCase() ?? null }));
      if (supplied.some(({ tokenId }) => tokenId && !current.has(tokenId))) return { error: 'INVALID_TOKEN' } as const;
      if (!await commandSessionIsActive(tx, tokenHash)) return { error: 'UNAUTHENTICATED' } as const;
      const state = { sceneId: scene.id, active: true, round: 1, activeIndex: 0 };
      if (previous) {
        [next] = await tx.update(initiatives).set({ ...state, version: previous.version + 1 })
          .where(and(eq(initiatives.id, previous.id), eq(initiatives.version, previous.version))).returning();
        if (next) await tx.delete(initiativeEntries).where(eq(initiativeEntries.trackerId, next.id));
      } else {
        [next] = await tx.insert(initiatives).values({ campaignId, ...state }).returning();
      }
      if (!next) throw new Error('Initiative changed while holding the campaign gate');
      const trackerId = next.id;
      entries = await tx.insert(initiativeEntries).values(supplied.map((entry, tieOrder) => ({ ...entry, trackerId, tieOrder }))).returning();
      entries.sort((left, right) => right.score - left.score || left.tieOrder - right.tieOrder);
    } else {
      if (!previous?.active || previous.version !== command.input.expectedVersion) return { error: 'CONFLICT' } as const;
      entries = await entriesFor(tx, previous.id);
      if (command.action === 'advance' && entries.length === 0) return { error: 'CONFLICT' } as const;
      if (!await commandSessionIsActive(tx, tokenHash)) return { error: 'UNAUTHENTICATED' } as const;
      const wrap = previous.activeIndex + 1 >= entries.length;
      const patch = command.action === 'stop' ? { active: false } :
        { activeIndex: wrap ? 0 : previous.activeIndex + 1, round: previous.round + Number(wrap) };
      [next] = await tx.update(initiatives).set({ ...patch, version: previous.version + 1 })
        .where(and(eq(initiatives.id, previous.id), eq(initiatives.version, previous.version))).returning();
      if (!next) throw new Error('Initiative changed while holding the campaign gate');
    }
    const action = { start: 'started', advance: 'advanced', stop: 'stopped' }[command.action];
    await tx.insert(auditEvents).values({ campaignId, actorId: actor.userId, action: `initiative.${action}`, targetId: next.id });
    return { version: next.version, view: initiativeProjection({ tracker: next, entries, available: true }, true) };
  }, { isolationLevel: 'read committed' });
}

export async function invalidateSceneInitiative(tx: Transaction, campaignId: string, sceneId: string, mode: 'archive' | 'activate') {
  const [tracker] = await tx.update(initiatives).set({ active: false, sceneId: null, version: sql`${initiatives.version} + 1` })
    .where(and(eq(initiatives.campaignId, campaignId), mode === 'archive' ? eq(initiatives.sceneId, sceneId) : ne(initiatives.sceneId, sceneId)))
    .returning({ version: initiatives.version });
  return tracker?.version;
}

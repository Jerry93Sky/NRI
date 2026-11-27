import { canMoveToken, idSchema, moveTokenSchema, tokenGroupPatchSchema, updateTokenGroupSchema } from '@nri/contracts';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '../../db/index.js';
import { auditEvents, scenes, tokens } from '../../db/schema.js';
import { publicToken } from '../../domain/projections.js';
import { canReadSceneTokens } from '../../domain/sceneAccess.js';
import { commandSessionIsActive, lockCampaign, lockCampaignRoles, lockCommandSession } from '../../security/commandAccess.js';

type Projection = ReturnType<typeof publicToken>;
type TokenUpdate = { tokenId: string; expectedVersion: number; patch: z.infer<typeof tokenGroupPatchSchema> };

type Movement =
  | { kind: 'single'; update: TokenUpdate; joined: (campaignId: string) => boolean }
  | { kind: 'group'; sceneId: string; updates: TokenUpdate[] };

type Rejection = { error: 'INVALID' | 'UNAUTHENTICATED' | 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT'; token?: Projection };
export type CommittedMovement = {
  kind: Movement['kind'];
  campaignId: string;
  sceneId: string;
  isActive: boolean;
  changes: { tokenId: string; wasHidden: boolean; hidden: boolean }[];
  projections: Projection[];
};

export async function moveToken(tokenHash: string, payload: unknown, joined: (campaignId: string) => boolean) {
  return executeMovement(tokenHash, () => {
    const input = moveTokenSchema.safeParse(payload);
    if (!input.success) return;
    const { tokenId, expectedVersion, x, y } = input.data;
    return { kind: 'single', update: { tokenId: tokenId.toLowerCase(), expectedVersion, patch: { x, y } }, joined };
  });
}

export async function updateTokenGroup(tokenHash: string, sceneId: string, payload: unknown) {
  return executeMovement(tokenHash, () => {
    const input = updateTokenGroupSchema.safeParse(payload);
    if (!idSchema.safeParse(sceneId).success || !input.success) return;
    const updates = input.data.updates.map((item) => ({ ...item, tokenId: item.tokenId.toLowerCase() }));
    if (new Set(updates.map(({ tokenId }) => tokenId)).size !== updates.length) return;
    return { kind: 'group', sceneId, updates };
  });
}

async function executeMovement(tokenHash: string, parse: () => Movement | undefined): Promise<Rejection | CommittedMovement> {
  return db.transaction(async (tx) => {
    const session = await lockCommandSession(tx, tokenHash);
    if (!session) return { error: 'UNAUTHENTICATED' };
    const movement = parse();
    if (!movement) return { error: 'INVALID' };

    // The lookup only locates immutable campaign and scene IDs. All mutable facts are read under locks.
    const [location] = movement.kind === 'single'
      ? await tx.select({ sceneId: scenes.id, campaignId: scenes.campaignId }).from(tokens)
        .innerJoin(scenes, eq(tokens.sceneId, scenes.id)).where(eq(tokens.id, movement.update.tokenId)).limit(1)
      : await tx.select({ sceneId: scenes.id, campaignId: scenes.campaignId }).from(scenes)
        .where(eq(scenes.id, movement.sceneId)).limit(1);
    const inaccessible = movement.kind === 'single' ? 'FORBIDDEN' : 'NOT_FOUND';
    if (!location) return { error: inaccessible };
    const { campaignId, sceneId } = location;
    if (movement.kind === 'single' && !movement.joined(campaignId)) return { error: 'FORBIDDEN' };
    if (!await lockCampaign(tx, campaignId)) return { error: inaccessible };

    const role = (await lockCampaignRoles(tx, campaignId, [session.userId])).get(session.userId);
    if (!role) return { error: inaccessible };
    const [scene] = await tx.select({ isActive: scenes.isActive, archivedAt: scenes.archivedAt }).from(scenes)
      .where(and(eq(scenes.id, sceneId), eq(scenes.campaignId, campaignId))).for('share').limit(1);
    if (!scene || !canReadSceneTokens(role, scene.isActive, scene.archivedAt !== null)) {
      return { error: inaccessible };
    }
    if (movement.kind === 'group' && role === 'PLAYER') return { error: 'FORBIDDEN' };

    const updates = movement.kind === 'single' ? [movement.update] : movement.updates;
    const rows = await tx.select().from(tokens)
      .where(and(eq(tokens.sceneId, sceneId), inArray(tokens.id, updates.map(({ tokenId }) => tokenId)), isNull(tokens.deletedAt)))
      .orderBy(asc(tokens.id)).for('no key update');
    if (rows.length !== updates.length) return { error: inaccessible };

    // The row lock prevents revocation. A session can still reach its expiry while another lock is held.
    if (!await commandSessionIsActive(tx, tokenHash)) return { error: 'UNAUTHENTICATED' };
    if (movement.kind === 'single' && !movement.joined(campaignId)) return { error: 'FORBIDDEN' };

    const byId = new Map(rows.map((row) => [row.id, row]));
    const changes = updates.map((update) => ({ ...update, previous: byId.get(update.tokenId)! }));
    for (const { previous, patch } of changes) {
      const moves = patch.x !== undefined || patch.y !== undefined;
      if (moves && (previous.locked || !canMoveToken(role, session.userId, previous.ownerUserId, previous.hidden))) {
        return { error: 'FORBIDDEN' };
      }
    }
    const stale = changes.find(({ previous, expectedVersion }) => previous.version !== expectedVersion);
    if (stale) {
      if (movement.kind === 'single') return { error: 'CONFLICT', token: publicToken(stale.previous, role !== 'PLAYER', session.userId) };
      return { error: 'CONFLICT' };
    }

    const updated = [];
    for (const { previous, patch, expectedVersion } of changes) {
      const [token] = await tx.update(tokens).set({ ...patch, version: expectedVersion + 1 }).where(and(
        eq(tokens.id, previous.id), eq(tokens.sceneId, sceneId), eq(tokens.version, expectedVersion), isNull(tokens.deletedAt),
      )).returning();
      if (!token) throw new Error('Locked token changed before movement was applied');
      updated.push({ previous, token });
    }
    await tx.insert(auditEvents).values(updated.map(({ token }) => ({
      campaignId, actorId: session.userId, action: movement.kind === 'single' ? 'token.moved' : 'token.group_updated', targetId: token.id,
    })));
    return { kind: movement.kind, campaignId, sceneId, isActive: scene.isActive,
      changes: updated.map(({ previous, token }) => ({ tokenId: token.id, wasHidden: previous.hidden, hidden: token.hidden })),
      projections: updated.map(({ token }) => publicToken(token, role !== 'PLAYER')) };
  }, { isolationLevel: 'read committed' });
}

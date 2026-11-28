import { createHash, randomInt } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { diceSchema, parseDiceExpression } from '@nri/contracts';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { diceRolls, messages } from '../../db/schema.js';
import { lockCampaignActor } from '../../security/commandAccess.js';

const chatCommand = z.object({ campaignId: z.uuid(), clientMessageId: z.uuid(), body: z.string().trim().min(1).max(2000), recipientId: z.uuid().nullable().optional() });
const diceCommand = z.object({ campaignId: z.uuid(), requestId: z.uuid(), ...diceSchema.shape });
type JoinedCampaign = (id: string) => boolean;
const requestDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function injectRollback(raw: unknown) {
  return process.env.NODE_ENV === 'test' && process.env.NRI_ENABLE_TEST_FAULTS === 'true' && typeof raw === 'object' && raw !== null &&
    'testRollbackBeforeCommit' in raw && raw.testRollbackBeforeCommit === true;
}

export async function sendChat(tokenHash: string, raw: unknown, joined: JoinedCampaign) {
  const parsed = chatCommand.safeParse(raw);
  if (!parsed.success) return { error: 'INVALID' } as const;
  const campaignId = parsed.data.campaignId.toLowerCase();
  const clientMessageId = parsed.data.clientMessageId.toLowerCase();
  const recipientId = parsed.data.recipientId?.toLowerCase() ?? null;
  const digest = requestDigest({ body: parsed.data.body, recipientId });
  if (!joined(campaignId)) return { error: 'FORBIDDEN' } as const;
  return db.transaction(async (tx) => {
    const actor = await lockCampaignActor(tx, tokenHash, campaignId, { otherUsers: recipientId ? [recipientId] : [] });
    if ('error' in actor) return { error: actor.error } as const;
    if (!joined(campaignId)) return { error: 'FORBIDDEN' } as const;
    if (recipientId) {
      const recipient = actor.roles.get(recipientId);
      if (!recipient || (actor.role === 'PLAYER' && recipient === 'PLAYER')) return { error: 'FORBIDDEN' } as const;
    }
    const [inserted] = await tx.insert(messages).values({ campaignId, senderId: actor.userId, recipientId, body: parsed.data.body,
      clientMessageId, requestDigest: digest }).onConflictDoNothing({ target: [messages.campaignId, messages.senderId, messages.clientMessageId] }).returning();
    if (inserted && injectRollback(raw)) throw new Error('Test-only rollback before chat commit');
    const message = inserted ?? (await tx.select().from(messages).where(and(eq(messages.campaignId, campaignId),
      eq(messages.senderId, actor.userId), eq(messages.clientMessageId, clientMessageId))).limit(1))[0];
    if (!message) throw new Error('Message creation failed');
    if (message.requestDigest !== digest) return { error: 'CONFLICT' } as const;
    const { requestDigest: _requestDigest, ...safeMessage } = message;
    return { message: safeMessage, replayed: !inserted };
  });
}

export async function rollDice(tokenHash: string, raw: unknown, joined: JoinedCampaign) {
  const parsed = diceCommand.safeParse(raw);
  if (!parsed.success) return { error: 'INVALID' } as const;
  const campaignId = parsed.data.campaignId.toLowerCase();
  const requestId = parsed.data.requestId.toLowerCase();
  const { expression, hidden } = parsed.data;
  const digest = requestDigest({ expression, hidden });
  const dice = parseDiceExpression(expression);
  if (!dice) return { error: 'INVALID' } as const;
  if (!joined(campaignId)) return { error: 'FORBIDDEN' } as const;
  return db.transaction(async (tx) => {
    const actor = await lockCampaignActor(tx, tokenHash, campaignId);
    if ('error' in actor) return { error: actor.error } as const;
    if (!joined(campaignId) || (hidden && actor.role === 'PLAYER')) return { error: 'FORBIDDEN' } as const;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${campaignId}:${actor.userId}:${requestId}`}, 0))`);
    const [existing] = await tx.select().from(diceRolls).where(and(eq(diceRolls.campaignId, campaignId),
      eq(diceRolls.userId, actor.userId), eq(diceRolls.requestId, requestId))).limit(1);
    if (existing) {
      if (existing.requestDigest !== digest) return { error: 'CONFLICT' } as const;
      const detail = JSON.parse(existing.detail) as { rolls: number[]; modifier: number };
      return { roll: { id: existing.id, campaignId, userId: actor.userId, expression: existing.expression,
        rolls: detail.rolls, modifier: detail.modifier, result: existing.result, hidden: existing.hidden }, replayed: true };
    }
    const { count, sides, modifier } = dice;
    const rolls = Array.from({ length: count }, () => randomInt(1, sides + 1));
    const result = rolls.reduce((sum, value) => sum + value, modifier);
    const [saved] = await tx.insert(diceRolls).values({ campaignId, userId: actor.userId, expression, result,
      detail: JSON.stringify({ rolls, modifier }), hidden, requestId, requestDigest: digest }).onConflictDoNothing({
        target: [diceRolls.campaignId, diceRolls.userId, diceRolls.requestId],
      }).returning({ id: diceRolls.id });
    if (saved && injectRollback(raw)) throw new Error('Test-only rollback before dice commit');
    if (saved) return { roll: { id: saved.id, campaignId, userId: actor.userId, expression, rolls, modifier, result, hidden }, replayed: false };
    const [winner] = await tx.select().from(diceRolls).where(and(eq(diceRolls.campaignId, campaignId),
      eq(diceRolls.userId, actor.userId), eq(diceRolls.requestId, requestId))).limit(1);
    if (!winner) throw new Error('Roll creation failed');
    if (winner.requestDigest !== digest) return { error: 'CONFLICT' } as const;
    const detail = JSON.parse(winner.detail) as { rolls: number[]; modifier: number };
    return { roll: { id: winner.id, campaignId, userId: actor.userId, expression: winner.expression,
      rolls: detail.rolls, modifier: detail.modifier, result: winner.result, hidden: winner.hidden }, replayed: true };
  });
}

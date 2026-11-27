import { randomInt } from 'node:crypto';
import { diceSchema, parseDiceExpression } from '@nri/contracts';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { diceRolls, messages } from '../../db/schema.js';
import { lockCampaignActor } from '../../security/commandAccess.js';

const chatCommand = z.object({ campaignId: z.uuid(), body: z.string().trim().min(1).max(2000), recipientId: z.uuid().nullable().optional() });
const diceCommand = z.object({ campaignId: z.uuid(), ...diceSchema.shape });
type JoinedCampaign = (id: string) => boolean;

export async function sendChat(tokenHash: string, raw: unknown, joined: JoinedCampaign) {
  const parsed = chatCommand.safeParse(raw);
  if (!parsed.success) return { error: 'INVALID' } as const;
  const campaignId = parsed.data.campaignId.toLowerCase();
  const recipientId = parsed.data.recipientId?.toLowerCase() ?? null;
  if (!joined(campaignId)) return { error: 'FORBIDDEN' } as const;
  return db.transaction(async (tx) => {
    const actor = await lockCampaignActor(tx, tokenHash, campaignId, { otherUsers: recipientId ? [recipientId] : [] });
    if ('error' in actor) return { error: actor.error } as const;
    if (!joined(campaignId)) return { error: 'FORBIDDEN' } as const;
    if (recipientId) {
      const recipient = actor.roles.get(recipientId);
      if (!recipient || (actor.role === 'PLAYER' && recipient === 'PLAYER')) return { error: 'FORBIDDEN' } as const;
    }
    const [message] = await tx.insert(messages).values({ campaignId, senderId: actor.userId, recipientId, body: parsed.data.body }).returning();
    if (!message) throw new Error('Message creation failed');
    return { message };
  });
}

export async function rollDice(tokenHash: string, raw: unknown, joined: JoinedCampaign) {
  const parsed = diceCommand.safeParse(raw);
  if (!parsed.success) return { error: 'INVALID' } as const;
  const campaignId = parsed.data.campaignId.toLowerCase();
  const { expression, hidden } = parsed.data;
  const dice = parseDiceExpression(expression);
  if (!dice) return { error: 'INVALID' } as const;
  if (!joined(campaignId)) return { error: 'FORBIDDEN' } as const;
  return db.transaction(async (tx) => {
    const actor = await lockCampaignActor(tx, tokenHash, campaignId);
    if ('error' in actor) return { error: actor.error } as const;
    if (!joined(campaignId) || (hidden && actor.role === 'PLAYER')) return { error: 'FORBIDDEN' } as const;
    const { count, sides, modifier } = dice;
    const rolls = Array.from({ length: count }, () => randomInt(1, sides + 1));
    const result = rolls.reduce((sum, value) => sum + value, modifier);
    const [saved] = await tx.insert(diceRolls).values({ campaignId, userId: actor.userId, expression, result,
      detail: JSON.stringify({ rolls, modifier }), hidden }).returning({ id: diceRolls.id });
    if (!saved) throw new Error('Roll creation failed');
    return { roll: { id: saved.id, campaignId, userId: actor.userId, expression, rolls, modifier, result, hidden } };
  });
}

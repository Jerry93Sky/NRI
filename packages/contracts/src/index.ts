import { z } from 'zod';

export const idSchema = z.string().uuid();
export const registerSchema = z.object({ email: z.email().max(254), password: z.string().min(12).max(128), displayName: z.string().trim().min(1).max(48) });
export const loginSchema = z.object({ email: z.email().max(254), password: z.string().min(1).max(128) });
export const createCampaignSchema = z.object({ title: z.string().trim().min(1).max(80), description: z.string().trim().max(500).default('') });
export const createSceneSchema = z.object({ campaignId: idSchema, title: z.string().trim().min(1).max(80), gridSize: z.number().int().min(16).max(128).default(48) });
export const createTokenSchema = z.object({ sceneId: idSchema, name: z.string().trim().min(1).max(48), x: z.number().finite().min(-10000).max(10000), y: z.number().finite().min(-10000).max(10000), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#c8794a'), hidden: z.boolean().default(false) });
export const moveTokenSchema = z.object({ tokenId: idSchema, x: z.number().finite().min(-10000).max(10000), y: z.number().finite().min(-10000).max(10000), expectedVersion: z.number().int().positive() });
export const diceSchema = z.object({ expression: z.string().regex(/^\s*(\d{1,2})?d(4|6|8|10|12|20|100)([+-]\d{1,4})?\s*$/i).max(16) });
export const inviteSchema = z.object({ campaignId: idSchema, expiresInHours: z.number().int().min(1).max(168).default(72) });

export type RegisterInput = z.infer<typeof registerSchema>;
export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;
export type CreateSceneInput = z.infer<typeof createSceneSchema>;
export type CreateTokenInput = z.infer<typeof createTokenSchema>;
export type MoveTokenInput = z.infer<typeof moveTokenSchema>;

export type PublicToken = { id: string; sceneId: string; name: string; x: number; y: number; color: string; version: number; ownerUserId: string | null };
export type TokenMoved = { type: 'token.moved'; token: PublicToken };

export function canMoveToken(role: string | null, actorId: string, ownerUserId: string | null, hidden: boolean): boolean {
  if (role === 'OWNER' || role === 'GM') return true;
  return role === 'PLAYER' && !hidden && ownerUserId === actorId;
}

export function parseDiceExpression(expression: string) {
  const match = expression.match(/^\s*(\d{1,2})?d(4|6|8|10|12|20|100)([+-]\d{1,4})?\s*$/i);
  if (!match) return null;
  const count = Number(match[1] || 1); const sides = Number(match[2]); const modifier = Number(match[3] || 0);
  if (count < 1 || count > 20 || ![4, 6, 8, 10, 12, 20, 100].includes(sides) || Math.abs(modifier) > 1000) return null;
  return { count, sides, modifier };
}

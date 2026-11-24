import { z } from 'zod';

export const idSchema = z.string().uuid();
export const registerSchema = z.object({ email: z.email().max(254), password: z.string().min(12).max(128), displayName: z.string().trim().min(1).max(48) });
export const loginSchema = z.object({ email: z.email().max(254), password: z.string().min(1).max(128) });
export const createCampaignSchema = z.object({ title: z.string().trim().min(1).max(80), description: z.string().trim().max(500).default('') });
export const createSceneSchema = z.object({ campaignId: idSchema, title: z.string().trim().min(1).max(80), gridSize: z.number().int().min(16).max(128).default(48) });
export const createTokenSchema = z.object({ sceneId: idSchema, name: z.string().trim().min(1).max(48), x: z.number().finite().min(-10000).max(10000), y: z.number().finite().min(-10000).max(10000), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#c8794a'), hidden: z.boolean().default(false) });
export const sceneLayerKindSchema = z.enum(['BACKGROUND', 'OBJECTS', 'TOKENS', 'GM', 'CUSTOM']);
export const createSceneLayerSchema = z.object({ name: z.string().trim().min(1).max(48), kind: z.literal('CUSTOM'), sortOrder: z.number().int().min(-1000).max(1000).default(4), visibleToPlayers: z.boolean().default(true), locked: z.boolean().default(false) });
export const updateSceneLayerSchema = z.object({ name: z.string().trim().min(1).max(48).optional(), sortOrder: z.number().int().min(-1000).max(1000).optional(), visibleToPlayers: z.boolean().optional(), locked: z.boolean().optional(), expectedVersion: z.number().int().positive() }).refine(({ expectedVersion: _version, ...patch }) => Object.values(patch).some((value) => value !== undefined));
export const sceneObjectKindSchema = z.enum(['IMAGE', 'LINE', 'FREEHAND', 'RECTANGLE', 'ELLIPSE', 'TEXT']);
const sceneObjectShape = {
  layerId: idSchema, kind: sceneObjectKindSchema, x: z.number().finite().min(-32768).max(32768), y: z.number().finite().min(-32768).max(32768), width: z.number().finite().positive().max(16384), height: z.number().finite().positive().max(16384), rotation: z.number().finite().min(-360000).max(360000), opacity: z.number().finite().min(0).max(1), zIndex: z.number().int().min(-100000).max(100000), assetId: idSchema.nullable().optional(), color: z.string().regex(/^#[\da-fA-F]{6}$/).nullable().optional(), strokeWidth: z.number().finite().min(0).max(256).nullable().optional(), points: z.array(z.object({ x: z.number().finite().min(-32768).max(32768), y: z.number().finite().min(-32768).max(32768) })).max(10000).nullable().optional(), text: z.string().max(500).nullable().optional(), visible: z.boolean(), locked: z.boolean(),
};
export const sceneObjectFieldsSchema = z.object(sceneObjectShape);
export const createSceneObjectSchema = sceneObjectFieldsSchema.extend({ width: sceneObjectShape.width.default(64), height: sceneObjectShape.height.default(64), rotation: sceneObjectShape.rotation.default(0), opacity: sceneObjectShape.opacity.default(1), zIndex: sceneObjectShape.zIndex.default(0), visible: sceneObjectShape.visible.default(true), locked: sceneObjectShape.locked.default(false) }).refine((value) => value.kind !== 'IMAGE' || value.assetId != null);
export const updateSceneObjectSchema = sceneObjectFieldsSchema.partial().extend({ expectedVersion: z.number().int().positive() }).refine(({ expectedVersion: _version, ...patch }) => Object.values(patch).some((value) => value !== undefined));
export const moveTokenSchema = z.object({ tokenId: idSchema, x: z.number().finite().min(-10000).max(10000), y: z.number().finite().min(-10000).max(10000), expectedVersion: z.number().int().positive() });
export const diceSchema = z.object({ expression: z.string().regex(/^\s*(\d{1,2})?d(4|6|8|10|12|20|100)([+-]\d{1,4})?\s*$/i).max(16) });
export const inviteSchema = z.object({ campaignId: idSchema, expiresInHours: z.number().int().min(1).max(168).default(72) });

export type RegisterInput = z.infer<typeof registerSchema>;
export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;
export type CreateSceneInput = z.infer<typeof createSceneSchema>;
export type CreateTokenInput = z.infer<typeof createTokenSchema>;
export type CreateSceneLayerInput = z.infer<typeof createSceneLayerSchema>;
export type SceneLayerKind = z.infer<typeof sceneLayerKindSchema>;
export type CreateSceneObjectInput = z.infer<typeof createSceneObjectSchema>;
export type UpdateSceneObjectInput = z.infer<typeof updateSceneObjectSchema>;
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

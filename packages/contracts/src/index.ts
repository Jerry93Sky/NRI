import { z } from 'zod';

export const idSchema = z.string().uuid();
export const registerSchema = z.object({ email: z.email().max(254), password: z.string().min(12).max(128), displayName: z.string().trim().min(1).max(48) });
export const loginSchema = z.object({ email: z.email().max(254), password: z.string().min(1).max(128) });
export const createCampaignSchema = z.object({ title: z.string().trim().min(1).max(80), description: z.string().trim().max(500).default('') });
export const campaignDrawingPermissionSchema = z.object({ enabled: z.boolean() });
export const createSceneSchema = z.object({ campaignId: idSchema, title: z.string().trim().min(1).max(80), gridSize: z.number().int().min(16).max(128).default(48) });
export const createTokenSchema = z.object({ sceneId: idSchema, name: z.string().trim().min(1).max(48), x: z.number().finite().min(-10000).max(10000), y: z.number().finite().min(-10000).max(10000), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#c8794a'), imageAssetId: idSchema.nullable().optional(), hidden: z.boolean().default(false) });
export const duplicateTokenSchema = z.object({ sceneId: idSchema, expectedVersion: z.number().int().positive(), x: z.number().finite().min(-10000).max(10000), y: z.number().finite().min(-10000).max(10000) });
export const duplicateTokensSchema = z.object({ sceneId: idSchema, tokens: z.array(z.object({ tokenId: idSchema, expectedVersion: z.number().int().positive(), x: z.number().finite().min(-10000).max(10000), y: z.number().finite().min(-10000).max(10000) })).min(1).max(50).refine((items) => new Set(items.map((item) => item.tokenId)).size === items.length) });
export const assetCategorySchema = z.enum(['MAP', 'TOKEN', 'DECORATION', 'PORTRAIT', 'OTHER']);
export const createAssetFolderSchema = z.object({ name: z.string().trim().min(1).max(48) });
export const updateAssetFolderSchema = createAssetFolderSchema;
export const updateAssetSchema = z.object({ name: z.string().trim().min(1).max(120).optional(), category: assetCategorySchema.optional(), folderId: idSchema.nullable().optional() }).refine((patch) => Object.values(patch).some((value) => value !== undefined));
export const tokenResourceSchema = z.object({ label: z.string().trim().min(1).max(24), current: z.number().int().min(0).max(9999), maximum: z.number().int().min(0).max(9999), visible: z.boolean() }).refine((resource) => resource.current <= resource.maximum);
export const tokenResourcesSchema = z.tuple([tokenResourceSchema, tokenResourceSchema]);
const tokenPropertyFields = { name: z.string().trim().min(1).max(48), color: z.string().regex(/^#[0-9a-fA-F]{6}$/), imageAssetId: idSchema.nullable(), width: z.number().finite().min(0.25).max(100), height: z.number().finite().min(0.25).max(100), rotation: z.number().finite().min(-360000).max(360000), opacity: z.number().finite().min(0).max(1), borderColor: z.string().regex(/^#[0-9a-fA-F]{6}$/), zIndex: z.number().int().min(-100000).max(100000), hidden: z.boolean(), locked: z.boolean(), showName: z.boolean(), resources: tokenResourcesSchema, gmNote: z.string().max(4000), ownerNote: z.string().max(4000) };
export const updateTokenSchema = z.object(tokenPropertyFields).partial().extend({ expectedVersion: z.number().int().positive() }).refine(({ expectedVersion: _version, ...patch }) => Object.values(patch).some((value) => value !== undefined));
export const tokenGroupPatchSchema = z.object({ color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), hidden: z.boolean().optional(), locked: z.boolean().optional(), showName: z.boolean().optional(), opacity: z.number().finite().min(0).max(1).optional(), zIndex: z.number().int().min(-100000).max(100000).optional(), x: z.number().finite().min(-10000).max(10000).optional(), y: z.number().finite().min(-10000).max(10000).optional() }).refine((patch) => Object.values(patch).some((value) => value !== undefined));
export const updateTokenGroupSchema = z.object({ updates: z.array(z.object({ tokenId: idSchema, expectedVersion: z.number().int().positive(), patch: tokenGroupPatchSchema })).min(2).max(50) }).refine(({ updates }) => new Set(updates.map(({ tokenId }) => tokenId)).size === updates.length);
export const adjustTokenResourceSchema = z.object({ resourceIndex: z.union([z.literal(0), z.literal(1)]), delta: z.union([z.literal(-1), z.literal(1)]), expectedVersion: z.number().int().positive() });
export const sceneLayerKindSchema = z.enum(['BACKGROUND', 'OBJECTS', 'TOKENS', 'GM', 'CUSTOM']);
export const createSceneLayerSchema = z.object({ name: z.string().trim().min(1).max(48), kind: z.literal('CUSTOM'), sortOrder: z.number().int().min(-1000).max(1000).default(4), visibleToPlayers: z.boolean().default(true), locked: z.boolean().default(false) });
export const updateSceneLayerSchema = z.object({ name: z.string().trim().min(1).max(48).optional(), sortOrder: z.number().int().min(-1000).max(1000).optional(), visibleToPlayers: z.boolean().optional(), locked: z.boolean().optional(), expectedVersion: z.number().int().positive() }).refine(({ expectedVersion: _version, ...patch }) => Object.values(patch).some((value) => value !== undefined));
export const sceneObjectKindSchema = z.enum(['IMAGE', 'LINE', 'FREEHAND', 'RECTANGLE', 'ELLIPSE', 'TEXT']);
const sceneObjectShape = {
  layerId: idSchema, kind: sceneObjectKindSchema, x: z.number().finite().min(-32768).max(32768), y: z.number().finite().min(-32768).max(32768), width: z.number().finite().positive().max(16384), height: z.number().finite().positive().max(16384), rotation: z.number().finite().min(-360000).max(360000), opacity: z.number().finite().min(0).max(1), zIndex: z.number().int().min(-100000).max(100000), assetId: idSchema.nullable().optional(), color: z.string().regex(/^#[\da-fA-F]{6}$/).nullable().optional(), strokeWidth: z.number().finite().min(0).max(256).nullable().optional(), points: z.array(z.object({ x: z.number().finite().min(-32768).max(32768), y: z.number().finite().min(-32768).max(32768) })).max(10000).nullable().optional(), text: z.string().max(500).nullable().optional(), visible: z.boolean(), locked: z.boolean(),
};
export const sceneObjectFieldsSchema = z.object(sceneObjectShape);
export const createSceneObjectSchema = sceneObjectFieldsSchema.extend({ width: sceneObjectShape.width.default(64), height: sceneObjectShape.height.default(64), rotation: sceneObjectShape.rotation.default(0), opacity: sceneObjectShape.opacity.default(1), zIndex: sceneObjectShape.zIndex.default(0), visible: sceneObjectShape.visible.default(true), locked: sceneObjectShape.locked.default(false) }).refine((value) => value.kind !== 'IMAGE' || value.assetId != null).refine((value) => value.kind !== 'TEXT' || Boolean(value.text?.trim()));
export const updateSceneObjectSchema = sceneObjectFieldsSchema.partial().extend({ expectedVersion: z.number().int().positive() }).refine(({ expectedVersion: _version, ...patch }) => Object.values(patch).some((value) => value !== undefined)).refine(({ kind, text }) => kind !== 'TEXT' || Boolean(text?.trim())).refine(({ text }) => text === undefined || (typeof text === 'string' && Boolean(text.trim())));
export const duplicateSceneObjectsSchema = z.object({ layerId: idSchema, objects: z.array(z.object({ objectId: idSchema, expectedVersion: z.number().int().positive(), x: sceneObjectShape.x, y: sceneObjectShape.y })).min(1).max(50).refine((items) => new Set(items.map((item) => item.objectId)).size === items.length) });
export const sceneObjectLifecycleSchema = z.object({
  action: z.enum(['delete', 'restore']),
  objects: z.array(z.object({ objectId: idSchema, expectedVersion: z.number().int().positive() })).min(1).max(50)
    .refine((items) => new Set(items.map(({ objectId }) => objectId)).size === items.length),
});
export const moveTokenSchema = z.object({ tokenId: idSchema, x: z.number().finite().min(-10000).max(10000), y: z.number().finite().min(-10000).max(10000), expectedVersion: z.number().int().positive() });
export const diceSchema = z.object({ expression: z.string().regex(/^\s*(\d{1,2})?d(4|6|8|10|12|20|100)([+-]\d{1,4})?\s*$/i).max(16), hidden: z.boolean().default(false) });
export const inviteSchema = z.object({ campaignId: idSchema, expiresInHours: z.number().int().min(1).max(168).default(72) });

export type RegisterInput = z.infer<typeof registerSchema>;
export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;
export type CreateSceneInput = z.infer<typeof createSceneSchema>;
export type CreateTokenInput = z.infer<typeof createTokenSchema>;
export type AssetCategory = z.infer<typeof assetCategorySchema>;
export type UpdateAssetInput = z.infer<typeof updateAssetSchema>;
export type UpdateTokenInput = z.infer<typeof updateTokenSchema>;
export type TokenResource = z.infer<typeof tokenResourceSchema>;
export type AdjustTokenResourceInput = z.infer<typeof adjustTokenResourceSchema>;
export type CreateSceneLayerInput = z.infer<typeof createSceneLayerSchema>;
export type SceneLayerKind = z.infer<typeof sceneLayerKindSchema>;
export type CreateSceneObjectInput = z.infer<typeof createSceneObjectSchema>;
export type UpdateSceneObjectInput = z.infer<typeof updateSceneObjectSchema>;
export type DuplicateSceneObjectsInput = z.infer<typeof duplicateSceneObjectsSchema>;
export type MoveTokenInput = z.infer<typeof moveTokenSchema>;

export type TokenResourceView = Pick<TokenResource, 'label' | 'current' | 'maximum'> & { visible?: boolean };
export type PublicToken = { id: string; sceneId: string; name: string; x: number; y: number; color: string; imageAssetId: string | null; width: number; height: number; rotation: number; opacity: number; borderColor: string; zIndex: number; locked: boolean; showName: boolean; resources: [TokenResourceView | null, TokenResourceView | null]; gmNote?: string; ownerNote?: string; hidden?: boolean; version: number; ownerUserId: string | null };
export type TokenMoved = { type: 'token.moved'; token: PublicToken };
export type PublicSceneLayer = {
  id: string; sceneId: string; name: string; kind: string; sortOrder: number;
  visibleToPlayers: boolean; locked: boolean; version: number;
};
export type PublicSceneObject = {
  id: string; sceneId: string; layerId: string; kind: string;
  x: number; y: number; width: number; height: number; rotation: number; opacity: number; zIndex: number;
  assetId: string | null; color: string | null; strokeWidth: number | null;
  points: Array<{ x: number; y: number }> | null; text: string | null;
  visible: boolean; locked: boolean; version: number; ownedByMe?: boolean;
};

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

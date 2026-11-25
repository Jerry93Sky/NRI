import { describe, expect, it } from 'vitest';
import { adjustTokenResourceSchema, assetCategorySchema, canMoveToken, createSceneLayerSchema, createSceneObjectSchema, createTokenSchema, duplicateTokenSchema, duplicateTokensSchema, parseDiceExpression, updateAssetSchema, updateSceneObjectSchema, updateTokenGroupSchema, updateTokenSchema, tokenResourcesSchema } from './index.js';

describe('campaign-scoped token permissions', () => {
  it('allows the owner of a visible player token', () => expect(canMoveToken('PLAYER', 'u1', 'u1', false)).toBe(true));
  it('rejects moving another player token', () => expect(canMoveToken('PLAYER', 'u2', 'u1', false)).toBe(false));
  it('rejects moving hidden tokens as a player', () => expect(canMoveToken('PLAYER', 'u1', 'u1', true)).toBe(false));
  it('allows GM control', () => expect(canMoveToken('GM', 'gm', null, true)).toBe(true));
  it('rejects non-members', () => expect(canMoveToken(null, 'stranger', null, false)).toBe(false));
});

describe('dice expression parser', () => {
  it('parses supported bounded expressions', () => expect(parseDiceExpression('2d20+3')).toEqual({ count: 2, sides: 20, modifier: 3 }));
  it('defaults a missing count and modifier', () => expect(parseDiceExpression('d6')).toEqual({ count: 1, sides: 6, modifier: 0 }));
  it('rejects unsupported or unbounded expressions', () => {
    expect(parseDiceExpression('100d20')).toBeNull();
    expect(parseDiceExpression('d7')).toBeNull();
    expect(parseDiceExpression('1d20; DROP TABLE users')).toBeNull();
    expect(parseDiceExpression('d20+2000')).toBeNull();
  });
});

describe('scene layer and object contracts', () => {
  it('validates layer creation defaults and limits', () => {
    expect(createSceneLayerSchema.parse({ name: 'Effects', kind: 'CUSTOM' })).toMatchObject({ sortOrder: 4, visibleToPlayers: true, locked: false });
    expect(createSceneLayerSchema.safeParse({ name: '', kind: 'CUSTOM' }).success).toBe(false);
    expect(createSceneLayerSchema.safeParse({ name: 'Extra GM', kind: 'GM' }).success).toBe(false);
  });
  it('requires campaign objects to reference valid layers and image assets', () => {
    const base = { layerId: '99c025bf-4a53-4608-8caa-0bdb98ac1e90', kind: 'RECTANGLE', x: 10, y: 15 };
    expect(createSceneObjectSchema.parse(base)).toMatchObject({ width: 64, height: 64, opacity: 1, visible: true });
    expect(createSceneObjectSchema.safeParse({ ...base, kind: 'IMAGE' }).success).toBe(false);
    expect(createSceneObjectSchema.safeParse({ ...base, width: -1 }).success).toBe(false);
  });
  it('requires non-empty bounded text for text objects', () => {
    const base = { layerId: '99c025bf-4a53-4608-8caa-0bdb98ac1e90', kind: 'TEXT', x: 10, y: 15 };
    expect(createSceneObjectSchema.parse({ ...base, text: 'Read the inscription' })).toMatchObject({ kind: 'TEXT', text: 'Read the inscription' });
    expect(createSceneObjectSchema.safeParse({ ...base, text: ' '.repeat(4) }).success).toBe(false);
    expect(createSceneObjectSchema.safeParse({ ...base, text: 'x'.repeat(501) }).success).toBe(false);
    expect(updateSceneObjectSchema.safeParse({ expectedVersion: 2, text: 'Updated inscription' }).success).toBe(true);
    expect(updateSceneObjectSchema.safeParse({ expectedVersion: 2, text: '' }).success).toBe(false);
    expect(updateSceneObjectSchema.safeParse({ expectedVersion: 2, text: null }).success).toBe(false);
  });
  it('requires optimistic versions for object updates', () => {
    expect(updateSceneObjectSchema.safeParse({ x: 20, expectedVersion: 2 }).success).toBe(true);
    expect(updateSceneObjectSchema.safeParse({ x: 20 }).success).toBe(false);
    expect(updateSceneObjectSchema.parse({ expectedVersion: 2, locked: false })).toEqual({ expectedVersion: 2, locked: false });
  });
});

describe('token property contracts', () => {
  it('validates bounded token properties and requires optimistic versions', () => {
    expect(updateTokenSchema.parse({ expectedVersion: 3, width: 1.5, rotation: 45, hidden: true })).toMatchObject({ expectedVersion: 3, width: 1.5, rotation: 45, hidden: true });
    expect(updateTokenSchema.safeParse({ expectedVersion: 3, opacity: 1.1 }).success).toBe(false);
    expect(updateTokenSchema.safeParse({ expectedVersion: 3, width: 0.1 }).success).toBe(false);
    expect(updateTokenSchema.parse({ expectedVersion: 3, gmNote: 'private prep', ownerNote: 'Share with token owner' })).toMatchObject({ gmNote: 'private prep', ownerNote: 'Share with token owner' });
    expect(updateTokenSchema.safeParse({ expectedVersion: 3, gmNote: 'x'.repeat(4001) }).success).toBe(false);
    expect(updateTokenSchema.safeParse({ name: 'Goblin' }).success).toBe(false);
    expect(updateTokenSchema.parse({ expectedVersion: 3, imageAssetId: null })).toMatchObject({ expectedVersion: 3, imageAssetId: null });
    expect(createTokenSchema.safeParse({ sceneId: '99c025bf-4a53-4608-8caa-0bdb98ac1e90', name: 'Hero', x: 0, y: 0, imageAssetId: 'not-a-uuid' }).success).toBe(false);
    expect(duplicateTokenSchema.safeParse({ sceneId: '99c025bf-4a53-4608-8caa-0bdb98ac1e90', expectedVersion: 1, x: 30, y: 48 }).success).toBe(true);
    expect(duplicateTokenSchema.safeParse({ sceneId: '99c025bf-4a53-4608-8caa-0bdb98ac1e90', expectedVersion: 0, x: 30, y: 48 }).success).toBe(false);
    expect(duplicateTokensSchema.safeParse({ sceneId: '99c025bf-4a53-4608-8caa-0bdb98ac1e90', tokens: [{ tokenId: '99c025bf-4a53-4608-8caa-0bdb98ac1e90', expectedVersion: 1, x: 30, y: 48 }] }).success).toBe(true);
    expect(duplicateTokensSchema.safeParse({ sceneId: '99c025bf-4a53-4608-8caa-0bdb98ac1e90', tokens: [{ tokenId: '99c025bf-4a53-4608-8caa-0bdb98ac1e90', expectedVersion: 1, x: 30, y: 48 }, { tokenId: '99c025bf-4a53-4608-8caa-0bdb98ac1e90', expectedVersion: 1, x: 50, y: 48 }] }).success).toBe(false);
  });
  it('requires exactly two system-neutral resources with bounded current values', () => {
    expect(tokenResourcesSchema.safeParse([{ label: 'Health', current: 4, maximum: 8, visible: true }, { label: 'Focus', current: 1, maximum: 3, visible: false }]).success).toBe(true);
    expect(tokenResourcesSchema.safeParse([{ label: 'Health', current: 9, maximum: 8, visible: true }, { label: 'Focus', current: 0, maximum: 3, visible: false }]).success).toBe(false);
    expect(tokenResourcesSchema.safeParse([{ label: 'Health', current: 1, maximum: 8, visible: true }]).success).toBe(false);
    expect(adjustTokenResourceSchema.safeParse({ resourceIndex: 1, delta: -1, expectedVersion: 2 }).success).toBe(true);
    expect(adjustTokenResourceSchema.safeParse({ resourceIndex: 2, delta: 0, expectedVersion: 2 }).success).toBe(false);
  });
});

describe('asset library contracts', () => {
  it('limits asset metadata to known categories and valid names', () => {
    expect(assetCategorySchema.parse('TOKEN')).toBe('TOKEN');
    expect(assetCategorySchema.safeParse('EXECUTABLE').success).toBe(false);
    expect(updateAssetSchema.parse({ name: 'Goblin portrait', category: 'PORTRAIT' })).toEqual({ name: 'Goblin portrait', category: 'PORTRAIT' });
    expect(updateAssetSchema.safeParse({}).success).toBe(false);
  });
});

describe('token group update contract', () => {
  it('requires two unique, versioned tokens and a bounded patch', () => {
    const first = '99c025bf-4a53-4608-8caa-0bdb98ac1e90'; const second = 'b32a3b47-6e63-4f43-93b0-a74ade324930';
    expect(updateTokenGroupSchema.safeParse({ updates: [{ tokenId: first, expectedVersion: 1, patch: { locked: true } }, { tokenId: second, expectedVersion: 2, patch: { hidden: true } }] }).success).toBe(true);
    expect(updateTokenGroupSchema.safeParse({ updates: [{ tokenId: first, expectedVersion: 1, patch: { locked: true } }] }).success).toBe(false);
    expect(updateTokenGroupSchema.safeParse({ updates: [{ tokenId: first, expectedVersion: 1, patch: { locked: true } }, { tokenId: first, expectedVersion: 2, patch: { hidden: true } }] }).success).toBe(false);
    expect(updateTokenGroupSchema.safeParse({ updates: [{ tokenId: first, expectedVersion: 1, patch: { locked: true } }, { tokenId: second, expectedVersion: 2, patch: { gmNote: 'not allowed' } }] }).success).toBe(false);
  });
});

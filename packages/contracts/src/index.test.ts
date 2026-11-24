import { describe, expect, it } from 'vitest';
import { canMoveToken, createSceneLayerSchema, createSceneObjectSchema, parseDiceExpression, updateSceneObjectSchema } from './index.js';

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
  it('requires optimistic versions for object updates', () => {
    expect(updateSceneObjectSchema.safeParse({ x: 20, expectedVersion: 2 }).success).toBe(true);
    expect(updateSceneObjectSchema.safeParse({ x: 20 }).success).toBe(false);
    expect(updateSceneObjectSchema.parse({ expectedVersion: 2, locked: false })).toEqual({ expectedVersion: 2, locked: false });
  });
});

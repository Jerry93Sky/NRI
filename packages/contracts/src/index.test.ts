import { describe, expect, it } from 'vitest';
import { canMoveToken, parseDiceExpression } from './index.js';

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

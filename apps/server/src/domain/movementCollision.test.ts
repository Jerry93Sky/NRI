import { describe, expect, it } from 'vitest';
import { movementBlockers, movementIsBlocked } from './movementCollision.js';

const scene = { width: 2048, height: 2048 };
const path = (x: number, y: number, toX: number, toY: number) => ({ start: { x, y }, end: { x: toX, y: toY } });
type Obstacle = Parameters<typeof movementBlockers>[0][number];
const wall: Obstacle = { ...path(100, 100, 100, 200), kind: 'WALL', doorState: null, blocksMovement: true };
const crossing = path(20, 150, 190, 150);
const blocked = (move: ReturnType<typeof path>, blockers = [wall]) => movementIsBlocked(move, scene, movementBlockers(blockers));

describe('movement anchor collision', () => {
  it('blocks the full path including long moves and only needs one matching segment', () => {
    expect(blocked(crossing)).toBe(true);
    expect(blocked(path(0, 150, 2048, 150), [{ ...wall, ...path(1600, 400, 1600, 500) }, wall])).toBe(true);
    expect(blocked(path(0, 99, 2048, 99))).toBe(false);
    expect(blocked(path(20, 150, 90, 150))).toBe(false);
  });

  it.each([['OPEN', false], ['CLOSED', true], ['LOCKED', true]] as const)('applies %s door semantics independently of secrecy', (doorState, expected) => {
    const door = { ...wall, kind: 'DOOR' as const, doorState, visibility: 'SECRET' };
    expect(blocked(crossing, [door])).toBe(expected);
    expect(blocked(crossing, [{ ...door, blocksMovement: false }])).toBe(false);
  });

  it('uses the movement flag on walls and windows instead of their vision flag', () => {
    const transparentWall = { ...wall, blocksVision: true, blocksMovement: false };
    const window = { ...wall, kind: 'WINDOW' as const, blocksVision: false };
    expect(blocked(crossing, [transparentWall])).toBe(false);
    expect(blocked(crossing, [window])).toBe(true);
    expect(blocked(crossing, [{ ...window, blocksMovement: false }])).toBe(false);
  });

  it('blocks tangency beyond the start, landing on a wall, and collinear overlap', () => {
    expect(blocked(path(20, 100, 200, 100))).toBe(true);
    expect(blocked(path(20, 160, 100, 160))).toBe(true);
    expect(blocked(path(100, 20, 100, 230))).toBe(true);
    expect(blocked(path(100, 110, 100, 220))).toBe(true);
  });

  it('allows leaving an initial wall contact including its outward extension, while checking other walls', () => {
    expect(blocked(path(100, 150, 165, 150))).toBe(false);
    expect(blocked(path(100, 150, 25, 150))).toBe(false);
    expect(blocked(path(100, 100, 100, 30))).toBe(false);
    expect(blocked(path(100, 150, 165, 150), [wall, { ...wall, ...path(150, 100, 150, 200) }])).toBe(true);
  });

  it('does not treat zero or sub-quantum displacement as crossing', () => {
    expect(blocked(path(100, 150, 100, 150))).toBe(false);
    expect(blocked(path(100, 150, 100.0002, 150))).toBe(false);
    expect(blocked(path(20, 100.0001, 190, 99.9998))).toBe(true);
  });

  it('checks inclusive scene bounds only for the enabled policy', () => {
    expect(blocked(path(0, 0, 2048, 2048), [])).toBe(false);
    expect(blocked(path(0, 0, 2048.0001, 2048), [])).toBe(true);
    expect(blocked(path(-1, 0, 100, 0), [])).toBe(true);
    expect(movementIsBlocked(path(-1, 150, 5000, 150), scene, null)).toBe(false);
  });

  it('reports consistent results for reordered segments and repeated quantized checks', () => {
    const extra = { ...wall, ...path(100, 99.999, 100, 100) };
    const tangent = path(1, 99.9994, 500, 99.9994);
    expect(Array.from({ length: 20 }, (_, index) => blocked(tangent, index % 2 ? [wall, extra] : [extra, wall]))).toEqual(Array(20).fill(true));
  });
});

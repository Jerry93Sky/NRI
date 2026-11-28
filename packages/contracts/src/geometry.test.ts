import { describe, expect, it } from 'vitest';
import { createObstacleSchema, isDegenerateSegment, pointOnSegment, segmentBounds, segmentFitsScene, segmentsIntersect } from '@nri/contracts/geometry';

const line = (x1: number, y1: number, x2: number, y2: number) => ({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 } });
const wall = { ...line(0, 1, 40, 10), kind: 'WALL', doorState: null, visibility: 'STANDARD', blocksVision: true, blocksMovement: true };

describe('scene geometry', () => {
  it('finds a crossing and rejects parallel segments with overlapping bounds', () => {
    expect(segmentsIntersect(line(1, 1, 10, 10), line(1, 10, 10, 1))).toBe(true);
    expect(segmentsIntersect(line(1, 1, 10, 10), line(1, 2, 10, 11))).toBe(false);
  });

  it('includes shared endpoints and collinear overlaps', () => {
    const segment = line(1, 2, 6, 2);
    expect(segmentsIntersect(segment, line(6, 2, 8, 7))).toBe(true);
    expect(segmentsIntersect(segment, line(8, 2, 3, 2))).toBe(true);
    expect(segmentsIntersect(segment, line(7, 2, 9, 2))).toBe(false);
    expect(segmentsIntersect(segment, line(2, 2, 4, 2))).toBe(true);
  });

  it('uses closed bounds and rejects extrapolation in point-on-segment', () => {
    const segment = line(9, 5, 1, 1);
    expect(segmentBounds(segment)).toEqual({ minX: 1, minY: 1, maxX: 9, maxY: 5 });
    expect(pointOnSegment({ x: 5, y: 3 }, segment)).toBe(true);
    expect(pointOnSegment({ x: 11, y: 6 }, segment)).toBe(false);
    expect(segmentFitsScene(segment, 9, 5)).toBe(true);
    expect(segmentFitsScene(segment, 8, 5)).toBe(false);
  });

  it('quantizes consistently for nearly parallel segments at maximum map size', () => {
    const a = line(0, 20, 16384, 20.001);
    const b = line(0, 20.001, 16384, 20);
    const c = line(0, 20.002, 16384, 20.003);
    expect(Array.from({ length: 20 }, () => segmentsIntersect(a, b))).toEqual(Array(20).fill(true));
    expect(segmentsIntersect(b, { start: a.end, end: a.start })).toBe(true);
    expect(segmentsIntersect(a, c)).toBe(false);
  });

  it('rejects degenerate, non-finite and out-of-range input', () => {
    const collapsed = line(1, 1, 1.0002, 1.0002);
    expect(isDegenerateSegment(collapsed)).toBe(true);
    expect(createObstacleSchema.safeParse({ ...wall, ...collapsed }).success).toBe(false);
    expect(segmentsIntersect(collapsed, line(0, 0, 12, 12))).toBe(false);
    for (const x of [NaN, Infinity, -Infinity, -1, 16385]) {
      expect(createObstacleSchema.safeParse({ ...wall, start: { x, y: 0 } }).success).toBe(false);
      expect(segmentsIntersect(line(x, 0, 5, 5), line(1, 7, 5, 2))).toBe(false);
    }
  });

  it('rounds coordinates and validates door state independently of secrecy', () => {
    const parsed = createObstacleSchema.parse({ ...wall, start: { x: 0.12345, y: 2.5009 }, kind: 'DOOR', doorState: 'LOCKED', visibility: 'SECRET' });
    expect(parsed.start).toEqual({ x: 0.123, y: 2.501 });
    expect(parsed.visibility).toBe('SECRET');
    expect(createObstacleSchema.safeParse({ ...wall, kind: 'DOOR' }).success).toBe(false);
    expect(createObstacleSchema.safeParse({ ...wall, doorState: 'OPEN' }).success).toBe(false);
    expect(createObstacleSchema.safeParse({ ...wall, kind: 'DOOR', doorState: 'SECRET' }).success).toBe(false);
  });
});

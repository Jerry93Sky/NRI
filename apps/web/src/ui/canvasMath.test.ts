import { describe, expect, it } from 'vitest';
import { calculateCellSize, measureSceneDistance, zoomToPointer } from './canvasMath';

describe('canvas camera math', () => {
  it('measures straight and multi-segment paths in scene units', () => {
    expect(measureSceneDistance([{ x: 0, y: 0 }, { x: 48, y: 0 }], 48, 5)).toBe(5);
    expect(measureSceneDistance([{ x: 0, y: 0 }, { x: 48, y: 0 }, { x: 48, y: 48 }], 48, 5)).toBe(10);
    expect(measureSceneDistance([{ x: 0, y: 0 }, { x: 48, y: 48 }], 48, 5)).toBeCloseTo(Math.SQRT2 * 5);
    expect(measureSceneDistance([{ x: 0, y: 0 }], 48, 5)).toBe(0);
  });

  it('keeps the same world coordinate under the cursor while zooming', () => {
    const camera = { scale: 1, x: 80, y: -30 };
    const pointer = { x: 300, y: 250 };
    const before = { x: (pointer.x - camera.x) / camera.scale, y: (pointer.y - camera.y) / camera.scale };
    const after = zoomToPointer(camera, pointer, 1.5);
    expect(after.scale).toBe(1.5);
    expect((pointer.x - after.x) / after.scale).toBeCloseTo(before.x);
    expect((pointer.y - after.y) / after.scale).toBeCloseTo(before.y);
  });

  it('clamps scale without shifting the cursor anchor', () => {
    const camera = { scale: 2, x: 10, y: 20 };
    const pointer = { x: 110, y: 220 };
    const after = zoomToPointer(camera, pointer, 4, 0.25, 2.2);
    expect(after.scale).toBe(2.2);
    expect((pointer.x - after.x) / after.scale).toBeCloseTo(50);
    expect((pointer.y - after.y) / after.scale).toBeCloseTo(100);
  });

  it('calibrates cell size from a measured span and rejects out-of-range results', () => {
    expect(calculateCellSize(192, 4)).toBe(48);
    expect(calculateCellSize(190, 4)).toBe(48);
    expect(calculateCellSize(4, 1)).toBeNull();
    expect(calculateCellSize(1000, 1)).toBeNull();
    expect(calculateCellSize(100, 0)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { zoomToPointer } from './canvasMath';

describe('canvas camera math', () => {
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
});

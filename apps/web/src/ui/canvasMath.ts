export type CameraTransform = { scale: number; x: number; y: number };

export function measureSceneDistance(points: Array<{ x: number; y: number }>, gridSize: number, unitsPerCell: number): number {
  if (!Number.isFinite(gridSize) || gridSize <= 0 || !Number.isFinite(unitsPerCell) || unitsPerCell <= 0) return 0;
  let pixels = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    pixels += Math.hypot(current.x - previous.x, current.y - previous.y);
  }
  return pixels / gridSize * unitsPerCell;
}

export function zoomToPointer(current: CameraTransform, pointer: { x: number; y: number }, factor: number, min = 0.25, max = 2.2): CameraTransform {
  const worldX = (pointer.x - current.x) / current.scale;
  const worldY = (pointer.y - current.y) / current.scale;
  const scale = Math.max(min, Math.min(max, current.scale * factor));
  return { scale, x: pointer.x - worldX * scale, y: pointer.y - worldY * scale };
}

export function calculateCellSize(distance: number, cellCount: number, min = 8, max = 256): number | null {
  if (!Number.isFinite(distance) || !Number.isFinite(cellCount) || distance <= 0 || cellCount <= 0) return null;
  const size = Math.round(distance / cellCount);
  return size >= min && size <= max ? size : null;
}

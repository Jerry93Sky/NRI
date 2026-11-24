export type CameraTransform = { scale: number; x: number; y: number };

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

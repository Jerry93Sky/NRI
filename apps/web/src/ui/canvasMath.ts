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

export function selectTokenIdsInRect(tokens: Array<{ id: string; x: number; y: number; width: number; height: number }>, gridSize: number, rect: { x: number; y: number; width: number; height: number }): string[] {
  if (!Number.isFinite(gridSize) || gridSize <= 0) return [];
  const left = Math.min(rect.x, rect.x + rect.width);
  const right = Math.max(rect.x, rect.x + rect.width);
  const top = Math.min(rect.y, rect.y + rect.height);
  const bottom = Math.max(rect.y, rect.y + rect.height);
  return tokens.filter((token) => {
    const x = token.x * gridSize;
    const y = token.y * gridSize;
    const width = token.width * gridSize;
    const height = token.height * gridSize;
    return x <= right && x + width >= left && y <= bottom && y + height >= top;
  }).map((token) => token.id);
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

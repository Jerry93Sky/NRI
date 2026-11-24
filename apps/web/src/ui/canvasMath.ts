export type CameraTransform = { scale: number; x: number; y: number };

export function zoomToPointer(current: CameraTransform, pointer: { x: number; y: number }, factor: number, min = 0.25, max = 2.2): CameraTransform {
  const worldX = (pointer.x - current.x) / current.scale;
  const worldY = (pointer.y - current.y) / current.scale;
  const scale = Math.max(min, Math.min(max, current.scale * factor));
  return { scale, x: pointer.x - worldX * scale, y: pointer.y - worldY * scale };
}

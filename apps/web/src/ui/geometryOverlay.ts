import type { Graphics } from 'pixi.js';
import type { SceneObstacle, ScenePoint } from '@nri/contracts/geometry';

export function obstacleColor(obstacle: SceneObstacle) {
  if (obstacle.visibility === 'SECRET') return 0xd298ef;
  if (obstacle.kind === 'WINDOW') return 0x7bcbe0;
  if (obstacle.doorState === 'OPEN') return 0x8ac29a;
  if (obstacle.doorState === 'LOCKED') return 0xff8a81;
  return obstacle.kind === 'DOOR' ? 0xf8bf78 : 0xf3e7d1;
}

export function drawObstacles(graphics: Graphics, obstacles: SceneObstacle[]) {
  graphics.clear();
  const colors = new Map<number, SceneObstacle[]>();
  for (const obstacle of obstacles) {
    const color = obstacleColor(obstacle);
    const group = colors.get(color);
    if (group) group.push(obstacle);
    else colors.set(color, [obstacle]);
  }
  for (const [color, group] of colors) {
    for (const { start, end } of group) graphics.moveTo(start.x, start.y).lineTo(end.x, end.y);
    graphics.stroke({ color, width: 4, alpha: 0.95, cap: 'round' });
  }
}

export function pickObstacle(point: ScenePoint, obstacles: SceneObstacle[], tolerance: number) {
  let nearest: SceneObstacle | undefined;
  let distance = tolerance;
  for (const obstacle of obstacles) {
    const { start, end } = obstacle;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const projection = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
    const gap = Math.hypot(point.x - (start.x + projection * dx), point.y - (start.y + projection * dy));
    if (gap < distance) { nearest = obstacle; distance = gap; }
  }
  return nearest;
}

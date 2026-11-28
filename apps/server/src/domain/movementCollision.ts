import { isDegenerateSegment, normalizeScenePoint, pointOnSegment, segmentBounds, segmentFitsScene, segmentsIntersect,
  type ObstacleFields, type SceneSegment } from '@nri/contracts/geometry';

type Obstacle = Pick<ObstacleFields, 'kind' | 'doorState' | 'blocksMovement'> & SceneSegment;
type Bounds = ReturnType<typeof segmentBounds>;
const overlap = (a: Bounds, b: Bounds) => a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
const samePoint = (a: SceneSegment['start'], b: SceneSegment['start']) => a.x === b.x && a.y === b.y;

export function movementBlockers(obstacles: Obstacle[]) {
  return obstacles.filter((obstacle) => obstacle.blocksMovement && (obstacle.kind !== 'DOOR' || obstacle.doorState !== 'OPEN'))
    .map((segment) => ({ segment, bounds: segmentBounds(segment) }));
}

export function movementIsBlocked(path: SceneSegment, scene: { width: number; height: number },
  blockers: ReturnType<typeof movementBlockers> | null) {
  if (!blockers || samePoint(path.start, path.end)) return false;
  if (!segmentFitsScene(path, scene.width, scene.height)) return true;
  const start = normalizeScenePoint(path.start);
  const end = normalizeScenePoint(path.end);
  const normalized = { start, end };
  if (isDegenerateSegment(normalized)) return false;
  const bounds = segmentBounds(normalized);
  return blockers.some(({ segment, bounds: wall }) => {
    if (!overlap(bounds, wall) || !segmentsIntersect(normalized, segment)) return false;
    if (!pointOnSegment(start, segment)) return true;
    // A token placed on a wall may step away. Any contact beyond its start still blocks the move.
    return pointOnSegment(end, segment) || [segment.start, segment.end].some((point) =>
      !samePoint(start, point) && pointOnSegment(point, normalized));
  });
}

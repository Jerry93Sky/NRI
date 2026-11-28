import { z } from 'zod';

export const sceneGeometryScale = 1000;
const maxCoordinate = 16384;
const coordinate = z.number().min(0).max(maxCoordinate);
const pointSchema = z.strictObject({ x: coordinate, y: coordinate });
export const obstacleKindSchema = z.enum(['WALL', 'DOOR', 'WINDOW']);
export const doorStateSchema = z.enum(['OPEN', 'CLOSED', 'LOCKED']);
export const obstacleVisibilitySchema = z.enum(['STANDARD', 'SECRET']);

const obstacleFields = {
  start: pointSchema,
  end: pointSchema,
  kind: obstacleKindSchema,
  doorState: doorStateSchema.nullable(),
  visibility: obstacleVisibilitySchema,
  blocksMovement: z.boolean(),
  blocksVision: z.boolean(),
};

export type ScenePoint = z.infer<typeof pointSchema>;
export type SceneSegment = { start: ScenePoint; end: ScenePoint };
export type ObstacleFields = z.infer<z.ZodObject<typeof obstacleFields>>;
export type SceneObstacle = ObstacleFields & { id: string; campaignId: string; sceneId: string; version: number };
export type SceneGeometry = { campaignId: string; sceneId: string; revision: number; obstacleMovementEnabled: boolean; obstacles: SceneObstacle[] };
export type GeometryInvalidation = Pick<SceneGeometry, 'campaignId' | 'sceneId'>;

const ticks = ({ x, y }: ScenePoint): ScenePoint => ({ x: Math.round(x * sceneGeometryScale), y: Math.round(y * sceneGeometryScale) });
const samePoint = (a: ScenePoint, b: ScenePoint) => a.x === b.x && a.y === b.y;
const validPoint = ({ x, y }: ScenePoint) => Number.isFinite(x) && Number.isFinite(y) &&
  x >= 0 && y >= 0 && x <= maxCoordinate && y <= maxCoordinate;
export const isDegenerateSegment = ({ start, end }: SceneSegment) => samePoint(ticks(start), ticks(end));
export const segmentFitsScene = ({ start, end }: SceneSegment, width: number, height: number) =>
  [start, end].every((point) => validPoint(point) && point.x <= width && point.y <= height);

function validObstacle(fields: ObstacleFields) {
  return !isDegenerateSegment(fields) && (fields.kind === 'DOOR') === (fields.doorState !== null);
}

export const normalizeScenePoint = (point: ScenePoint) => {
  const { x, y } = ticks(point);
  return { x: x / sceneGeometryScale, y: y / sceneGeometryScale };
};
const normalizeObstacle = <T extends ObstacleFields>(value: T): T =>
  ({ ...value, start: normalizeScenePoint(value.start), end: normalizeScenePoint(value.end) });
const expectedVersion = z.number().int().positive().max(2147483647);
export const createObstacleSchema = z.strictObject(obstacleFields).refine(validObstacle).transform(normalizeObstacle);
export const updateObstacleSchema = z.strictObject({ ...obstacleFields, expectedVersion }).refine(validObstacle).transform(normalizeObstacle);
export const deleteObstacleSchema = z.strictObject({ expectedVersion });
export const updateMovementPolicySchema = z.strictObject({
  enabled: z.boolean(),
  expectedRevision: z.number().int().min(0).max(2147483647),
});

export function segmentBounds({ start, end }: SceneSegment) {
  return { minX: Math.min(start.x, end.x), maxX: Math.max(start.x, end.x), minY: Math.min(start.y, end.y), maxY: Math.max(start.y, end.y) };
}

const cross = (a: ScenePoint, b: ScenePoint, c: ScenePoint) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
function onSegment(point: ScenePoint, segment: SceneSegment) {
  const box = segmentBounds(segment);
  return point.x >= box.minX && point.x <= box.maxX && point.y >= box.minY && point.y <= box.maxY;
}

function quantize(segment: SceneSegment): SceneSegment | null {
  if (!validPoint(segment.start) || !validPoint(segment.end)) return null;
  const start = ticks(segment.start);
  const end = ticks(segment.end);
  return samePoint(start, end) ? null : { start, end };
}

export function pointOnSegment(point: ScenePoint, segment: SceneSegment) {
  const line = quantize(segment);
  if (!line || !validPoint(point)) return false;
  const q = ticks(point);
  return cross(line.start, line.end, q) === 0 && onSegment(q, line);
}

/** Closed segments intersect at crossings, endpoints and collinear overlaps. Invalid or degenerate input does not intersect. */
export function segmentsIntersect(a: SceneSegment, b: SceneSegment) {
  const first = quantize(a);
  const second = quantize(b);
  if (!first || !second) return false;
  const c1 = cross(first.start, first.end, second.start);
  const c2 = cross(first.start, first.end, second.end);
  const c3 = cross(second.start, second.end, first.start);
  const c4 = cross(second.start, second.end, first.end);
  if (c1 === 0 && onSegment(second.start, first) || c2 === 0 && onSegment(second.end, first)
    || c3 === 0 && onSegment(first.start, second) || c4 === 0 && onSegment(first.end, second)) return true;
  return c1 !== 0 && c2 !== 0 && c3 !== 0 && c4 !== 0 && (c1 > 0) !== (c2 > 0) && (c3 > 0) !== (c4 > 0);
}

import { idSchema, sceneObjectLifecycleSchema } from '@nri/contracts';
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { auditEvents, sceneObjects } from '../../db/schema.js';
import { sceneObjectProjection } from '../../domain/projections.js';
import { canReadSceneLayer } from '../../domain/sceneAccess.js';
import { commandSessionIsActive, lockCommandSession } from '../../security/commandAccess.js';
import { lockObjectLayers, lockObjectScene, lockSceneObjects } from './access.js';

type Action = 'delete' | 'restore';
type Target = { objectId: string; expectedVersion: number };
type ObjectRow = typeof sceneObjects.$inferSelect;
type Rejection = { error: 'INVALID' | 'UNAUTHENTICATED' | 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT' | 'LAYER_LOCKED' | 'OBJECT_LOCKED' };
export type ObjectLifecyclePublication = {
  action: Action;
  campaignId: string;
  sceneId: string;
  changes: { id: string; layerId: string; version: number; wasPublic: boolean; permanent: boolean }[];
};
type CommittedLifecycle = { publication: ObjectLifecyclePublication; objects: ReturnType<typeof sceneObjectProjection>[] };
type Command =
  | { kind: 'group'; sceneId: string; action: Action; targets: Target[] }
  | { kind: 'single'; action: 'delete'; target: Target }
  | { kind: 'drawings'; action: 'delete'; sceneId: string };

const deleteSchema = z.object({ expectedVersion: z.number().int().positive() });

export function changeObjectLifecycle(tokenHash: string, sceneId: string, payload: unknown) {
  return transactLifecycle(tokenHash, () => {
    const input = sceneObjectLifecycleSchema.safeParse(payload);
    if (!idSchema.safeParse(sceneId).success || !input.success) return;
    const targets = input.data.objects.map((target) => ({ ...target, objectId: target.objectId.toLowerCase() }));
    if (new Set(targets.map(({ objectId }) => objectId)).size !== targets.length) return;
    return { kind: 'group', sceneId, action: input.data.action, targets };
  });
}

export function deleteSceneObject(tokenHash: string, objectId: string, payload: unknown) {
  return transactLifecycle(tokenHash, () => {
    const input = deleteSchema.safeParse(payload);
    if (!idSchema.safeParse(objectId).success || !input.success) return;
    return { kind: 'single', action: 'delete', target: { objectId: objectId.toLowerCase(), expectedVersion: input.data.expectedVersion } };
  });
}

export function clearOwnDrawings(tokenHash: string, sceneId: string) {
  return transactLifecycle(tokenHash, () => idSchema.safeParse(sceneId).success ? { kind: 'drawings', action: 'delete', sceneId } : undefined);
}

async function transactLifecycle(tokenHash: string, parse: () => Command | undefined): Promise<Rejection | CommittedLifecycle> {
  return db.transaction(async (tx) => {
    const session = await lockCommandSession(tx, tokenHash);
    if (!session) return { error: 'UNAUTHENTICATED' };
    const command = parse();
    if (!command) return { error: 'INVALID' };
    // The point endpoint needs the immutable scene ID before taking campaign and scene locks.
    const [point] = command.kind === 'single'
      ? await tx.select({ sceneId: sceneObjects.sceneId }).from(sceneObjects).where(eq(sceneObjects.id, command.target.objectId)).limit(1)
      : [];
    const sceneId = command.kind === 'single' ? point?.sceneId : command.sceneId;
    if (!sceneId) return { error: 'NOT_FOUND' };
    const context = await lockObjectScene(tx, sceneId, session.userId);
    if ('error' in context) return { error: command.kind === 'single' ? 'NOT_FOUND' : context.error };
    const { role, scene } = context;
    if (command.kind === 'group' && role === 'PLAYER') return { error: 'FORBIDDEN' };
    if (role === 'PLAYER' && !scene.isActive) return { error: 'NOT_FOUND' };

    const drawings = command.kind === 'drawings';
    const targets = command.kind === 'group' ? command.targets : command.kind === 'single' ? [command.target] : [];
    const expected = new Map(targets.map(({ objectId, expectedVersion }) => [objectId, expectedVersion]));
    const ownedDrawing = and(eq(sceneObjects.createdBy, session.userId), eq(sceneObjects.kind, 'FREEHAND'), isNull(sceneObjects.deletedAt));
    const locations = await tx.select({ id: sceneObjects.id, layerId: sceneObjects.layerId }).from(sceneObjects)
      .where(and(eq(sceneObjects.sceneId, scene.id), drawings ? ownedDrawing : inArray(sceneObjects.id, [...expected.keys()])));
    if (!drawings && locations.length !== expected.size) return { error: 'NOT_FOUND' };

    const permanent = drawings || role === 'PLAYER';
    const layers = await lockObjectLayers(tx, scene.id, locations.map(({ layerId }) => layerId));
    const rows = await lockSceneObjects(tx, scene.id, locations.map(({ id }) => id), permanent ? 'update' : 'no key update');
    if (!drawings && rows.length !== expected.size) return { error: 'NOT_FOUND' };
    if (!await commandSessionIsActive(tx, tokenHash)) return { error: 'UNAUTHENTICATED' };
    const objects = drawings ? rows.filter((object) => !object.deletedAt && object.createdBy === session.userId && object.kind === 'FREEHAND') : rows;
    const discovered = new Map(locations.map(({ id, layerId }) => [id, layerId]));

    if (role === 'PLAYER' && command.kind === 'single') {
      const object = objects[0]!;
      const layer = layers.get(object.layerId);
      if (object.deletedAt || !object.visible || !layer || !canReadSceneLayer(role, scene.isActive, false, layer.visibleToPlayers, layer.kind)) return { error: 'NOT_FOUND' };
      if (object.kind !== 'FREEHAND' || object.createdBy !== session.userId) return { error: 'FORBIDDEN' };
    }
    if (command.kind === 'single' && objects[0]!.deletedAt) return { error: 'NOT_FOUND' };
    if (objects.some((object) => discovered.get(object.id) !== object.layerId)) return { error: 'CONFLICT' };
    if (objects.some((object) => !layers.has(object.layerId))) return { error: 'NOT_FOUND' };
    if (!drawings && objects.some((object) => object.version !== expected.get(object.id) || Boolean(object.deletedAt) !== (command.action === 'restore'))) {
      return { error: 'CONFLICT' };
    }
    // The permanent clear command keeps its existing cleanup semantics even after drawing is disabled.
    if (!drawings && objects.some(({ layerId }) => layers.get(layerId)!.locked)) return { error: 'LAYER_LOCKED' };
    if (!drawings && objects.some(({ locked }) => locked)) return { error: 'OBJECT_LOCKED' };

    let updated: ObjectRow[] = [];
    if (objects.length) {
      const ids = objects.map(({ id }) => id);
      const targetsMatch = drawings ? and(inArray(sceneObjects.id, ids), ownedDrawing) : or(...objects.map(({ id, version }) =>
        and(eq(sceneObjects.id, id), eq(sceneObjects.version, version))));
      const filter = and(eq(sceneObjects.sceneId, scene.id), targetsMatch,
        command.action === 'delete' ? isNull(sceneObjects.deletedAt) : isNotNull(sceneObjects.deletedAt));
      updated = permanent
        ? await tx.delete(sceneObjects).where(filter).returning()
        : await tx.update(sceneObjects).set({ deletedAt: command.action === 'delete' ? new Date() : null,
          version: sql`${sceneObjects.version} + 1` }).where(filter).returning();
      if (updated.length !== objects.length) throw new Error('Locked scene objects changed before lifecycle write');
      await tx.insert(auditEvents).values(drawings ? [{
        campaignId: scene.campaignId, actorId: session.userId, action: 'scene.own_drawings_cleared', targetId: scene.id, detail: String(updated.length),
      }] : updated.map(({ id }) => ({
        campaignId: scene.campaignId, actorId: session.userId, action: command.action === 'delete' ? 'scene.object_deleted' : 'scene.object_restored', targetId: id,
      })));
    }
    return {
      publication: { campaignId: scene.campaignId, sceneId: scene.id, action: command.action,
        changes: updated.map((object) => {
          const layer = layers.get(object.layerId)!;
          return { id: object.id, layerId: object.layerId, version: object.version, permanent,
            wasPublic: scene.isActive && object.visible && layer.visibleToPlayers && layer.kind !== 'GM' };
        }) },
      objects: updated.map((object) => sceneObjectProjection(object, role, session.userId)),
    };
  }, { isolationLevel: 'read committed' });
}

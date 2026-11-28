import { and, asc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import { sceneGeometryScale, segmentFitsScene, type ObstacleFields, type SceneObstacle } from '@nri/contracts/geometry';
import { db } from '../../db/index.js';
import { auditEvents, sceneGeometry, sceneObstacles } from '../../db/schema.js';
import { lockCampaignSceneActor, type Transaction } from '../../security/commandAccess.js';
import { lockOperationReceipt, saveOperationReceipt } from '../../security/operationReceipts.js';

type Command =
  | { kind: 'create'; fields: ObstacleFields }
  | { kind: 'update'; id: string; expectedVersion: number; fields: ObstacleFields }
  | { kind: 'delete'; id: string; expectedVersion: number };

function obstacleView(row: typeof sceneObstacles.$inferSelect, campaignId: string): SceneObstacle {
  const { startX, startY, endX, endY, ...fields } = row;
  return { ...fields, campaignId,
    start: { x: startX / sceneGeometryScale, y: startY / sceneGeometryScale },
    end: { x: endX / sceneGeometryScale, y: endY / sceneGeometryScale },
  };
}

function obstacleValues({ start, end, ...fields }: ObstacleFields) {
  return { ...fields,
    startX: Math.round(start.x * sceneGeometryScale), startY: Math.round(start.y * sceneGeometryScale),
    endX: Math.round(end.x * sceneGeometryScale), endY: Math.round(end.y * sceneGeometryScale),
  };
}

export async function readSceneGeometry(tokenHash: string, sceneId: string) {
  return db.transaction(async (tx) => {
    const actor = await lockCampaignSceneActor(tx, tokenHash, sceneId);
    if ('error' in actor) return actor;
    if (actor.role === 'PLAYER') return { error: 'FORBIDDEN' } as const;
    const campaignId = actor.scene.campaignId;
    const [geometry] = await tx.select({ revision: sceneGeometry.revision }).from(sceneGeometry).where(eq(sceneGeometry.sceneId, sceneId));
    const obstacles = await tx.select().from(sceneObstacles).where(eq(sceneObstacles.sceneId, sceneId)).orderBy(asc(sceneObstacles.id));
    return { campaignId, sceneId, revision: geometry?.revision ?? 0,
      obstacles: obstacles.map((row) => obstacleView(row, campaignId)) };
  });
}

export async function applyObstacleCommand(tokenHash: string, sceneId: string, command: Command, requestId: string | null) {
  return db.transaction(async (tx) => {
    const actor = await lockCampaignSceneActor(tx, tokenHash, sceneId, { sceneStrength: 'update' });
    if ('error' in actor) return actor;
    if (actor.role === 'PLAYER') return { error: 'FORBIDDEN' } as const;
    const campaignId = actor.scene.campaignId;
    const action = `geometry.${command.kind}`;
    const receipt = requestId ? await lockOperationReceipt(tx,
      { actorId: actor.userId, campaignId, operationType: action, requestId }, { sceneId, command }) : null;
    if (receipt?.kind === 'conflict') return { error: 'CONFLICT' } as const;
    if (receipt?.kind === 'replay') {
      if (command.kind === 'delete') return { campaignId, obstacle: null, replayed: true } as const;
      const [row] = await tx.select().from(sceneObstacles)
        .where(and(eq(sceneObstacles.id, receipt.resultIds[0]!), eq(sceneObstacles.sceneId, sceneId)));
      return row ? { campaignId, obstacle: obstacleView(row, campaignId), replayed: true } as const
        : { error: 'RESULT_UNAVAILABLE' } as const;
    }
    if (command.kind !== 'delete' && !segmentFitsScene(command.fields, actor.scene.width, actor.scene.height)) {
      return { error: 'GEOMETRY_OUT_OF_BOUNDS' } as const;
    }

    let row: typeof sceneObstacles.$inferSelect | undefined;
    if (command.kind === 'create') {
      [row] = await tx.insert(sceneObstacles).values({ sceneId, ...obstacleValues(command.fields) }).returning();
      if (!row) throw new Error('Obstacle insert returned no row');
    } else {
      const scope = and(eq(sceneObstacles.id, command.id), eq(sceneObstacles.sceneId, sceneId));
      const [current] = await tx.select({ version: sceneObstacles.version }).from(sceneObstacles).where(scope);
      if (!current) return { error: 'NOT_FOUND' } as const;
      if (current.version !== command.expectedVersion) return { error: 'CONFLICT' } as const;
      [row] = command.kind === 'delete'
        ? await tx.delete(sceneObstacles).where(scope).returning()
        : await tx.update(sceneObstacles).set({ ...obstacleValues(command.fields), version: current.version + 1 }).where(scope).returning();
      if (!row) throw new Error('Locked obstacle disappeared');
    }

    await tx.insert(sceneGeometry).values({ sceneId, revision: 1 }).onConflictDoUpdate({
      target: sceneGeometry.sceneId, set: { revision: sql`${sceneGeometry.revision} + 1` },
    });
    await tx.insert(auditEvents).values({ campaignId, actorId: actor.userId, action, targetId: row.id });
    if (receipt?.kind === 'new') await saveOperationReceipt(tx, receipt, [row.id]);
    return { campaignId, obstacle: command.kind === 'delete' ? null : obstacleView(row, campaignId), replayed: false } as const;
  });
}

/** Call under the owning scene lock, or the exclusive source campaign lock during campaign copy. */
export async function copySceneGeometry(tx: Transaction, destinations: Map<string, string>) {
  if (destinations.size === 0) return;
  const sources = [...destinations.keys()];
  const settings = await tx.select().from(sceneGeometry).where(inArray(sceneGeometry.sceneId, sources));
  if (settings.length) await tx.insert(sceneGeometry).values(settings.map(({ sceneId, ...values }) =>
    ({ ...values, sceneId: destinations.get(sceneId)!, revision: 0 })));
  const obstacles = await tx.select().from(sceneObstacles).where(inArray(sceneObstacles.sceneId, sources));
  for (let start = 0; start < obstacles.length; start += 500) {
    await tx.insert(sceneObstacles).values(obstacles.slice(start, start + 500).map(({ id: _id, sceneId, ...values }) =>
      ({ ...values, sceneId: destinations.get(sceneId)!, version: 1 })));
  }
}

export async function geometryFitsDimensions(tx: Transaction, sceneId: string, width: number, height: number) {
  const maxX = width * sceneGeometryScale;
  const maxY = height * sceneGeometryScale;
  const [outside] = await tx.select({ id: sceneObstacles.id }).from(sceneObstacles).where(and(
    eq(sceneObstacles.sceneId, sceneId),
    or(gt(sceneObstacles.startX, maxX), gt(sceneObstacles.endX, maxX), gt(sceneObstacles.startY, maxY), gt(sceneObstacles.endY, maxY)),
  )).limit(1);
  return !outside;
}

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { sceneGeometryScale, type ObstacleFields } from '@nri/contracts/geometry';
import { uploadDirectory } from './config/runtime.js';
import { db, pool } from './db/index.js';
import { assets, auditEvents, campaigns, memberships, sceneGeometry, sceneLayers, sceneObstacles, scenes, tokens, users } from './db/schema.js';
import { amberPlayableMaps } from './demoArt.js';
import { defaultLayerRows } from './domain/defaultLayers.js';
import type { Transaction } from './security/commandAccess.js';

const title = 'Geometry Workshop';
const sceneTitle = 'Vault of Four Doors';
type Segment = [number, number, number, number, ObstacleFields['doorState']?, ObstacleFields['visibility']?];
const segments: Segment[] = [
  [190, 190, 750, 190], [190, 190, 190, 750], [190, 750, 750, 750],
  [750, 190, 750, 409], [750, 409, 750, 471, 'OPEN'], [750, 471, 750, 750],
  [800, 190, 1275, 190], [800, 750, 1275, 750], [1275, 190, 1275, 409],
  [1275, 409, 1275, 471, 'CLOSED'], [1275, 471, 1275, 750],
  [800, 850, 800, 1059], [800, 1059, 800, 1121, 'LOCKED'], [800, 1121, 800, 1360],
  [190, 1210, 190, 1290, 'CLOSED', 'SECRET'],
];

async function seedMovementPractice(tx: Transaction, campaignId: string, sceneId: string, ownerId: string) {
  const action = 'geometry.movement_demo_seeded';
  const [marker] = await tx.select({ id: auditEvents.id }).from(auditEvents)
    .where(and(eq(auditEvents.campaignId, campaignId), eq(auditEvents.targetId, sceneId), eq(auditEvents.action, action))).limit(1);
  if (marker) return false;
  const [scene] = await tx.select().from(scenes).where(and(eq(scenes.id, sceneId), eq(scenes.campaignId, campaignId))).for('update');
  if (!scene || scene.archivedAt || scene.width < 816 || scene.height < 432) {
    throw new Error('The demo scene is unavailable or has been resized. Geometry practice tokens were not added.');
  }
  await tx.insert(tokens).values([
    { sceneId, name: 'Wall Trial', x: 672 / scene.gridSize, y: 336 / scene.gridSize, color: '#e1a95c' },
    { sceneId, name: 'Door Trial', x: 672 / scene.gridSize, y: 432 / scene.gridSize, color: '#63bfa5' },
  ]);
  await tx.insert(auditEvents).values({ campaignId, actorId: ownerId, action, targetId: sceneId });
  return true;
}

async function seed() {
  const dbURL = URL.parse(process.env.DATABASE_URL ?? '');
  const origin = URL.parse(process.env.WEB_ORIGIN ?? '');
  if (process.env.NODE_ENV !== 'test' || process.env.NRI_ACCEPTANCE_DEMO !== '1' || dbURL?.hostname !== 'db' ||
      dbURL.pathname !== '/nri_alpha' || origin?.protocol !== 'https:' || origin.hostname !== '127.0.0.1') {
    throw new Error('Run geometry seed through the isolated HTTPS acceptance script.');
  }
  const [owner] = await db.select({ id: users.id }).from(users).where(eq(users.email, 'demo@nri.local'));
  if (!owner) throw new Error('Seed the local Amber demo to create the test GM first.');
  let storedPath: string | undefined;
  try {
    const created = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(18492712)`);
      const [existing] = await tx.select({ campaignId: auditEvents.campaignId, sceneId: auditEvents.targetId }).from(auditEvents)
        .where(and(eq(auditEvents.action, 'geometry.demo_seeded'), eq(auditEvents.actorId, owner.id))).limit(1);
      if (existing?.sceneId) {
        const added = await seedMovementPractice(tx, existing.campaignId, existing.sceneId, owner.id);
        return added ? 'Added two movement practice tokens to the existing demo.' : 'Geometry Workshop already exists; seed made no changes.';
      }
      const [campaign] = await tx.insert(campaigns).values({
        ownerId: owner.id, title, description: 'Practice placing and editing walls and doors on a separate map.',
      }).returning({ id: campaigns.id });
      if (!campaign) throw new Error('Geometry campaign insert returned no row');
      await tx.insert(memberships).values({ campaignId: campaign.id, userId: owner.id, role: 'OWNER' });
      const bytes = await sharp(Buffer.from(amberPlayableMaps.vault)).png({ compressionLevel: 9, palette: true }).toBuffer();
      const key = `${randomUUID()}.png`;
      await mkdir(uploadDirectory, { recursive: true });
      const path = join(uploadDirectory, key);
      const file = await open(path, 'wx');
      storedPath = path;
      try { await file.writeFile(bytes); }
      finally { await file.close(); }
      const [map] = await tx.insert(assets).values({ campaignId: campaign.id, storageKey: key, name: 'Vault reference map.png',
        category: 'MAP', mediaType: 'image/png', size: bytes.length, checksum: createHash('sha256').update(bytes).digest('hex'), uploaderId: owner.id,
      }).returning({ id: assets.id });
      if (!map) throw new Error('Geometry map insert returned no row');
      const [scene] = await tx.insert(scenes).values({ campaignId: campaign.id, title: sceneTitle,
        width: 2048, height: 2048, backgroundAssetId: map.id, isActive: true, published: true, snapToGrid: false,
      }).returning({ id: scenes.id });
      if (!scene) throw new Error('Geometry scene insert returned no row');
      await tx.insert(sceneLayers).values(defaultLayerRows.map((layer) => ({ ...layer, sceneId: scene.id })));
      await tx.insert(sceneGeometry).values({ sceneId: scene.id, revision: 1 });
      await tx.insert(sceneObstacles).values(segments.map(([startX, startY, endX, endY, doorState, visibility]) => ({
        sceneId: scene.id, startX: startX * sceneGeometryScale, startY: startY * sceneGeometryScale,
        endX: endX * sceneGeometryScale, endY: endY * sceneGeometryScale,
        kind: doorState ? 'DOOR' as const : 'WALL' as const, doorState: doorState ?? null,
        visibility: visibility ?? 'STANDARD', blocksMovement: true, blocksVision: true,
      })));
      await tx.insert(auditEvents).values({ campaignId: campaign.id, actorId: owner.id, action: 'geometry.demo_seeded', targetId: scene.id });
      await seedMovementPractice(tx, campaign.id, scene.id, owner.id);
      return `Created ${title} / ${sceneTitle} with two movement practice tokens.`;
    });
    console.info(created);
  } catch (error) {
    if (storedPath) await unlink(storedPath).catch(() => {});
    throw error;
  }
}

try { await seed(); }
finally { await pool.end(); }

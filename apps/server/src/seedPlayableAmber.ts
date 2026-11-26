import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { copyFile, mkdir, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { and, eq, sql } from 'drizzle-orm';
import { amberPlayableMaps, amberPlayablePortrait, amberPlayablePortraits } from './demoArt.js';
import { db, pool } from './db/index.js';
import { assets, auditEvents, campaigns, memberships, messages, sceneLayers, sceneObjects, scenes, tokens } from './db/schema.js';

const campaignTitle = 'Amber Crossing: The Lantern Vault';
const parentTitle = 'Amber Crossing';
const defaultLayers = [
  { name: 'Background', kind: 'BACKGROUND', sortOrder: 0, visibleToPlayers: true, locked: true },
  { name: 'Objects', kind: 'OBJECTS', sortOrder: 1, visibleToPlayers: true, locked: false },
  { name: 'Tokens', kind: 'TOKENS', sortOrder: 2, visibleToPlayers: true, locked: false },
  { name: 'GM', kind: 'GM', sortOrder: 3, visibleToPlayers: false, locked: false },
] as const;

type MapKey = keyof typeof amberPlayableMaps;
type PortraitKey = keyof typeof amberPlayablePortraits;
type AssetInput = { key: string; name: string; category: 'MAP' | 'TOKEN'; bytes: Buffer };
type PreparedFile = { tempPath: string; finalPath: string; stored: boolean };
type DemoToken = {
  name: string; portrait: PortraitKey; x: number; y: number; color: string; isPc?: boolean; hidden?: boolean; gmNote: string;
};
type DemoObject = {
  kind: 'RECTANGLE' | 'ELLIPSE' | 'LINE' | 'FREEHAND' | 'TEXT'; layer: 'Objects' | 'GM';
  x: number; y: number; width: number; height: number; color: string; text?: string;
  points?: Array<{ x: number; y: number }>; strokeWidth?: number; visible?: boolean; zIndex?: number;
};

const maps: Array<{ key: MapKey; title: string; description: string; gridSize: number }> = [
  { key: 'tavern', title: 'The Copper Kettle', description: 'The party meets over a brass lantern and an unfinished ferry map.', gridSize: 64 },
  { key: 'road', title: 'Blueglass Lane', description: 'An old forest road, a damaged cart, and lanterns that answer the wrong voice.', gridSize: 64 },
  { key: 'vault', title: 'The Tollkeeper’s Vault', description: 'A flooded tollhouse beneath the old bridge. This scene is prepared as a GM draft.', gridSize: 64 },
];

const playerCharacters: DemoToken[] = [
  { name: 'Mira Vale', portrait: 'mira', x: 10, y: 14, color: '#b55d4c', isPc: true, gmNote: 'A patient negotiator. Private hook: Mira once saw the old bridge lantern answer a name no one spoke aloud.' },
  { name: 'Kestrel Reed', portrait: 'kestrel', x: 12, y: 14, color: '#4b8878', isPc: true, gmNote: 'A quick scout. Private hook: Kestrel recognizes the blue glass as river-warden work, not bandit craft.' },
  { name: 'Bram Cinder', portrait: 'bram', x: 14, y: 14, color: '#947447', isPc: true, gmNote: 'A steady guardian. Private hook: Bram’s family mark is scratched into the tollhouse door.' },
];

const tokensByMap: Record<MapKey, DemoToken[]> = {
  tavern: [
    ...playerCharacters,
    { name: 'Nessa Wren', portrait: 'nessa', x: 24, y: 7, color: '#a9784c', gmNote: 'Innkeeper. She has the brass lantern, but its blue flame vanished at dusk. She wants the road safe before the ferry leaves.' },
    { name: 'Tovin Brakes', portrait: 'tovin', x: 25, y: 16, color: '#71808a', gmNote: 'Retired toll clerk. The old tollhouse has a side entrance beneath a carved bell. He knows a three-note sequence: low, high, low.' },
  ],
  road: [
    ...playerCharacters.map((pc) => ({ ...pc, x: pc.x - 3, y: 23 })),
    { name: 'Orla Finch', portrait: 'orla', x: 9, y: 14, color: '#809558', gmNote: 'Cartographer. Her wheel is wedged under the bridge approach. She saw a lantern bob toward the river although nobody carried it.' },
    { name: 'Ash Hound', portrait: 'ash', x: 24, y: 14, color: '#59665d', gmNote: 'A wary marsh hound, not a monster. If offered food or space, it leads the party to the dry stones and avoids a fight.' },
  ],
  vault: [
    ...playerCharacters.map((pc) => ({ ...pc, x: pc.x - 3, y: 8 })),
    { name: 'Bell Keeper', portrait: 'keeper', x: 15, y: 16, color: '#617d7c', gmNote: 'A clockwork sentinel. It repeats the toll sequence; answering low-high-low opens the inner gate. It can be calmed without combat.' },
    { name: 'Lantern Warden', portrait: 'warden', x: 23, y: 16, color: '#7e586e', hidden: true, gmNote: 'Hidden until the party reaches the dais. The Warden is Nessa’s missing sibling, protecting a trapped river spirit. The lantern is a seal, not a weapon.' },
  ],
};

const objectsByMap: Record<MapKey, DemoObject[]> = {
  tavern: [
    { kind: 'RECTANGLE', layer: 'Objects', x: 650, y: 880, width: 390, height: 110, color: '#9b714a', zIndex: 3 },
    { kind: 'ELLIPSE', layer: 'Objects', x: 350, y: 1180, width: 160, height: 110, color: '#a77c52', zIndex: 2 },
    { kind: 'TEXT', layer: 'Objects', x: 330, y: 380, width: 420, height: 72, color: '#f0d398', text: 'THE COPPER KETTLE', zIndex: 8 },
    { kind: 'FREEHAND', layer: 'Objects', x: 630, y: 1200, width: 240, height: 180, color: '#e8cf9a', strokeWidth: 7, points: [{ x: 30, y: 145 }, { x: 78, y: 50 }, { x: 118, y: 96 }, { x: 188, y: 34 }, { x: 216, y: 145 }], zIndex: 9 },
    { kind: 'TEXT', layer: 'GM', x: 1190, y: 1510, width: 430, height: 130, color: '#f1c77e', text: 'GM NOTE · Tovin’s key is sewn inside the green cushion.', visible: false, zIndex: 20 },
  ],
  road: [
    { kind: 'RECTANGLE', layer: 'Objects', x: 820, y: 730, width: 180, height: 145, color: '#775a40', zIndex: 3 },
    { kind: 'LINE', layer: 'Objects', x: 510, y: 900, width: 330, height: 180, color: '#dfc797', strokeWidth: 8, points: [{ x: 8, y: 155 }, { x: 80, y: 112 }, { x: 176, y: 98 }, { x: 310, y: 16 }], zIndex: 5 },
    { kind: 'ELLIPSE', layer: 'Objects', x: 1360, y: 480, width: 110, height: 110, color: '#e5bd70', zIndex: 6 },
    { kind: 'TEXT', layer: 'Objects', x: 250, y: 1670, width: 520, height: 80, color: '#e4d3aa', text: 'BLUEGLASS LANE', zIndex: 8 },
    { kind: 'TEXT', layer: 'GM', x: 1240, y: 1320, width: 520, height: 150, color: '#f2c37a', text: 'GM NOTE · The hound’s tracks circle the safe ford; it is frightened, not hostile.', visible: false, zIndex: 20 },
  ],
  vault: [
    { kind: 'ELLIPSE', layer: 'Objects', x: 1010, y: 980, width: 330, height: 250, color: '#9a7747', zIndex: 4 },
    { kind: 'RECTANGLE', layer: 'Objects', x: 430, y: 1240, width: 210, height: 90, color: '#756145', zIndex: 3 },
    { kind: 'LINE', layer: 'Objects', x: 900, y: 710, width: 410, height: 120, color: '#c8b27d', strokeWidth: 6, points: [{ x: 10, y: 90 }, { x: 90, y: 25 }, { x: 210, y: 100 }, { x: 400, y: 15 }], zIndex: 5 },
    { kind: 'TEXT', layer: 'Objects', x: 940, y: 1380, width: 600, height: 90, color: '#efcc8b', text: 'LOW · HIGH · LOW', zIndex: 8 },
    { kind: 'TEXT', layer: 'GM', x: 1410, y: 620, width: 380, height: 140, color: '#f2c37a', text: 'GM NOTE · The Warden is hidden at the dais. The bell sequence resolves the encounter without combat.', visible: false, zIndex: 20 },
  ],
};

const genericResources = (isPc: boolean): [
  { label: string; current: number; maximum: number; visible: boolean },
  { label: string; current: number; maximum: number; visible: boolean },
] => isPc
  ? [
      { label: 'Resolve', current: 3, maximum: 3, visible: true },
      { label: 'Wounds', current: 0, maximum: 3, visible: true },
    ]
  : [
      { label: 'Guard', current: 2, maximum: 2, visible: false },
      { label: 'Morale', current: 1, maximum: 1, visible: false },
    ];

async function buildAssets(): Promise<AssetInput[]> {
  const mapInputs = await Promise.all(Object.entries(amberPlayableMaps).map(async ([key, svg]) => ({
    key: `map-${key}`, name: `Amber Crossing — ${maps.find((item) => item.key === key)!.title}.png`, category: 'MAP' as const,
    bytes: await sharp(Buffer.from(svg)).png({ compressionLevel: 9, palette: true }).toBuffer(),
  })));
  const portraitInputs = await Promise.all(Object.entries(amberPlayablePortraits).map(async ([key, palette]) => ({
    key: `portrait-${key}`, name: `Amber Crossing — ${key} token.png`, category: 'TOKEN' as const,
    bytes: await sharp(Buffer.from(amberPlayablePortrait(palette))).png({ compressionLevel: 9, palette: true }).toBuffer(),
  })));
  return [...mapInputs, ...portraitInputs];
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');
  const parsedUrl = new URL(databaseUrl);
  const databaseName = parsedUrl.pathname.replace(/^\//, '');
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsedUrl.hostname) || !['nri_dev', 'nri_demo'].includes(databaseName)) {
    throw new Error('This additive demo seed only runs against loopback PostgreSQL databases named nri_dev or nri_demo.');
  }

  const parentCampaigns = await db.select({ id: campaigns.id, ownerId: campaigns.ownerId }).from(campaigns)
    .where(and(eq(campaigns.title, parentTitle), sql`${campaigns.archivedAt} IS NULL`)).limit(2);
  if (parentCampaigns.length !== 1) throw new Error('Expected exactly one active Amber Crossing campaign to identify its owner; no rows will be changed.');
  const parent = parentCampaigns[0]!;
  const existing = await db.select({ id: campaigns.id }).from(campaigns)
    .where(and(eq(campaigns.ownerId, parent.ownerId), eq(campaigns.title, campaignTitle))).limit(1);
  if (existing[0]) {
    console.info('Playable Lantern Vault campaign already exists; seed made no changes.');
    return;
  }

  const assetInputs = await buildAssets();
  const uploadDirectory = resolve(process.cwd(), '../..', process.env.UPLOAD_DIR ?? '.data/uploads');
  await mkdir(uploadDirectory, { recursive: true });
  const preparedFiles: PreparedFile[] = [];
  const assetKeys = new Map<string, string>();
  for (const input of assetInputs) {
    const storageKey = `amber-playable-${randomUUID()}.png`;
    const tempPath = resolve(uploadDirectory, `.amber-playable-${randomUUID()}.pending`);
    const finalPath = resolve(uploadDirectory, storageKey);
    await writeFile(tempPath, input.bytes, { flag: 'wx' });
    preparedFiles.push({ tempPath, finalPath, stored: false });
    assetKeys.set(input.key, storageKey);
  }

  try {
    const seedResult = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(18492711)`);
      const concurrentCampaign = await tx.select({ id: campaigns.id }).from(campaigns)
        .where(and(eq(campaigns.ownerId, parent.ownerId), eq(campaigns.title, campaignTitle))).limit(1);
      if (concurrentCampaign[0]) return { campaignId: concurrentCampaign[0].id, created: false };

      const [campaign] = await tx.insert(campaigns).values({
        ownerId: parent.ownerId,
        title: campaignTitle,
        description: 'A 30–60 minute, rules-neutral three-scene starter mystery for exploring the NRI tabletop.',
        playersCanDraw: true,
      }).returning({ id: campaigns.id });
      if (!campaign) throw new Error('Demo campaign insert failed.');
      await tx.insert(memberships).values({ campaignId: campaign.id, userId: parent.ownerId, role: 'OWNER' });

      const assetIds = new Map<string, string>();
      for (const input of assetInputs) {
        const storageKey = assetKeys.get(input.key)!;
        const [asset] = await tx.insert(assets).values({
          campaignId: campaign.id,
          name: input.name,
          category: input.category,
          storageKey,
          mediaType: 'image/png',
          size: input.bytes.byteLength,
          checksum: createHash('sha256').update(input.bytes).digest('hex'),
          uploaderId: parent.ownerId,
        }).returning({ id: assets.id });
        if (!asset) throw new Error(`Asset insert failed: ${input.key}`);
        assetIds.set(input.key, asset.id);
      }

      const sceneIds = new Map<MapKey, string>();
      for (const [index, map] of maps.entries()) {
        const [scene] = await tx.insert(scenes).values({
          campaignId: campaign.id,
          title: map.title,
          backgroundAssetId: assetIds.get(`map-${map.key}`)!,
          gridSize: map.gridSize,
          width: 2048,
          height: 2048,
          unitsPerCell: 5,
          unitLabel: 'ft',
          sortOrder: index,
          isActive: index === 0,
          published: index === 0,
        }).returning({ id: scenes.id });
        if (!scene) throw new Error(`Scene insert failed: ${map.title}`);
        sceneIds.set(map.key, scene.id);
        const layerIds = new Map<string, string>();
        for (const layer of defaultLayers) {
          const [createdLayer] = await tx.insert(sceneLayers).values({ ...layer, sceneId: scene.id }).returning({ id: sceneLayers.id });
          if (!createdLayer) throw new Error(`Layer insert failed: ${map.title}/${layer.name}`);
          layerIds.set(layer.name, createdLayer.id);
        }

        for (const token of tokensByMap[map.key]) {
          const isPc = Boolean(token.isPc);
          await tx.insert(tokens).values({
            sceneId: scene.id,
            name: token.name,
            x: token.x,
            y: token.y,
            color: token.color,
            imageAssetId: assetIds.get(`portrait-${token.portrait}`)!,
            width: 1,
            height: 1,
            borderColor: isPc ? '#f0d59b' : '#d9b57b',
            showName: true,
            resources: genericResources(isPc),
            gmNote: token.gmNote,
            hidden: Boolean(token.hidden),
          });
        }

        for (const object of objectsByMap[map.key]) {
          const { layer, ...shape } = object;
          await tx.insert(sceneObjects).values({
            sceneId: scene.id,
            layerId: layerIds.get(layer)!,
            createdBy: parent.ownerId,
            kind: shape.kind,
            x: shape.x,
            y: shape.y,
            width: shape.width,
            height: shape.height,
            rotation: 0,
            opacity: 1,
            zIndex: shape.zIndex ?? 0,
            color: shape.color,
            strokeWidth: shape.strokeWidth ?? null,
            points: shape.points ?? null,
            text: shape.text ?? null,
            visible: shape.visible ?? true,
            locked: false,
          });
        }
      }

      await tx.insert(messages).values({
        campaignId: campaign.id,
        senderId: parent.ownerId,
        body: 'The brass lantern has gone blue. Nessa asks the table to follow its glow to the old tollhouse and bring everyone home.',
      });
      await tx.insert(auditEvents).values({ campaignId: campaign.id, actorId: parent.ownerId, action: 'campaign.playable_demo_seeded', targetId: campaign.id, detail: 'Original procedural Lantern Vault scenario' });

      for (const file of preparedFiles) {
        await copyFile(file.tempPath, file.finalPath, fsConstants.COPYFILE_EXCL);
        file.stored = true;
      }
      return { campaignId: campaign.id, created: true, sceneIds };
    });
    console.info(seedResult.created
      ? `Created the additive playable campaign ${campaignTitle} (${seedResult.campaignId}); the source Amber Crossing campaign was not changed.`
      : `Playable Lantern Vault campaign already exists (${seedResult.campaignId}); seed made no changes.`);
  } catch (error) {
    await Promise.allSettled(preparedFiles.map(async (file) => {
      await unlink(file.tempPath).catch(() => undefined);
      if (file.stored) await unlink(file.finalPath).catch(() => undefined);
    }));
    throw error;
  } finally {
    await Promise.allSettled(preparedFiles.map((file) => unlink(file.tempPath)));
  }
}

try {
  await main();
} finally {
  await pool.end();
}

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import sharp from 'sharp';

const url = new URL(process.env.DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/nri_load') {
  throw new Error('Load fixtures require a dedicated loopback database named nri_load.');
}
if (!process.env.UPLOAD_DIR) throw new Error('Set UPLOAD_DIR to the matching isolated media directory.');
const uploadDir = resolve(process.env.UPLOAD_DIR);
const fixturePath = resolve('.data/nri-load/fixture.json');
const fixtureExists = await stat(fixturePath).then(() => true, (error) => {
  if (error.code !== 'ENOENT') throw error;
  return false;
});
if (fixtureExists) throw new Error('Move the previous fixture file before generating another run.');
await Promise.all([mkdir(uploadDir, { recursive: true }), mkdir(dirname(fixturePath), { recursive: true })]);
const profiles = [
  { name: 'A', playerCount: 4, tokenCount: 30, objectCount: 100, mapSize: 2048 },
  { name: 'B', playerCount: 6, tokenCount: 100, objectCount: 500, mapSize: 4096 },
  { name: 'C', playerCount: 12, tokenCount: 500, objectCount: 2000, mapSize: 4096 },
];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const connection = new pg.Client({ connectionString: url.href });
await connection.connect();
const fixtures = [];
try {
  for (const profile of profiles) {
    const id = randomUUID();
    const campaignId = randomUUID();
    const sceneId = randomUUID();
    const otherSceneId = randomUUID();
    const layerId = randomUUID();
    const tokenId = randomUUID();
    const assetId = randomUUID();
    const storageKey = `load-${profile.name}-${id}.png`;
    const title = `Load profile ${profile.name} ${id.slice(0, 8)}`;
    const accounts = Array.from({ length: profile.playerCount + 1 }, (_item, index) => ({
      userId: randomUUID(), name: index ? `Load Player ${index}` : 'Load Guide',
      role: index ? 'PLAYER' : 'OWNER', session: randomBytes(32).toString('base64url'),
    }));
    const owner = accounts[0];
    const map = await sharp({
      create: { width: profile.mapSize, height: profile.mapSize, channels: 3, background: '#2b3e37' },
    }).composite([{
      input: Buffer.from('<svg width="256" height="256"><path fill="#34493f" d="M0 0h128v128H0z M128 128h128v128H128z"/><circle cx="128" cy="128" r="34" fill="#4d6054"/></svg>'),
      tile: true,
    }]).png().toBuffer();
    await writeFile(resolve(uploadDir, storageKey), map, { flag: 'wx' });
    await connection.query('begin');
    try {
      for (const account of accounts) {
        await connection.query('insert into users (id,email,password_hash,display_name) values ($1,$2,$3,$4)', [
          account.userId, `${account.userId}@load.example.test`, '!fixture-session-only', account.name,
        ]);
        await connection.query("insert into user_sessions (token_hash,user_id,expires_at) values ($1,$2,now()+interval '2 hours')", [sha256(account.session), account.userId]);
      }
      await connection.query('insert into campaigns (id,owner_id,title) values ($1,$2,$3)', [campaignId, owner.userId, title]);
      for (const account of accounts) {
        await connection.query('insert into campaign_memberships (campaign_id,user_id,role) values ($1,$2,$3)', [campaignId, account.userId, account.role]);
      }
      await connection.query("insert into assets (id,campaign_id,name,category,storage_key,media_type,size,checksum,uploader_id) values ($1,$2,$3,'MAP',$4,'image/png',$5,$6,$7)", [
        assetId, campaignId, `Load map ${profile.mapSize}`, storageKey, map.byteLength, sha256(map), owner.userId,
      ]);
      await connection.query("insert into scenes (id,campaign_id,title,background_asset_id,width,height,is_active,published) values ($1,$2,'Benchmark table',$3,$4,$4,true,true)", [sceneId, campaignId, assetId, profile.mapSize]);
      await connection.query("insert into scenes (id,campaign_id,title,sort_order) values ($1,$2,'Empty scene',1)", [otherSceneId, campaignId]);
      await connection.query("insert into scene_layers (id,scene_id,name,kind) values ($1,$2,'Objects','OBJECTS')", [layerId, sceneId]);
      await connection.query("insert into tokens (id,scene_id,name,x,y,color) values ($1,$2,'Measured token',1,1,'#e6b86c')", [tokenId, sceneId]);
      await connection.query("insert into tokens (scene_id,name,x,y,color) select $1,'Token '||n,n%40+1,n/40+1,'#c88970' from generate_series(1,$2) n", [sceneId, profile.tokenCount - 1]);
      await connection.query("insert into scene_objects (scene_id,layer_id,kind,x,y,width,height,color) select $1,$2,'RECTANGLE',(n%60)*64,(n/60)*64,40,34,'#54695b' from generate_series(1,$3) n", [sceneId, layerId, profile.objectCount]);
      await connection.query('commit');
    } catch (error) {
      await connection.query('rollback');
      throw error;
    }
    fixtures.push({ ...profile, title, campaignId, sceneId, otherSceneId, tokenId, accounts });
    console.info(`Created profile ${profile.name}: ${profile.tokenCount} tokens, ${profile.objectCount} objects, ${map.byteLength} map bytes.`);
  }
} finally { await connection.end(); }
await writeFile(fixturePath, JSON.stringify(fixtures), { mode: 0o600, flag: 'wx' });
console.info('Local fixture credentials saved in ignored .data/nri-load/fixture.json.');

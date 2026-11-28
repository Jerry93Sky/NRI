import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

const database = new URL(process.env.DATABASE_URL);
assert.match(database.pathname, /^\/nri_retry_upgrade_test$/u, 'Use the isolated migration-upgrade database');
const source = resolve('drizzle');
const prefix = 'nri-retry-upgrade-';
const tempRoot = await mkdtemp(join(tmpdir(), prefix));
const pool = new pg.Pool({ connectionString: database.href });
try {
  // This script owns its explicitly isolated database and recreates the pre-0020 state on every run.
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  const journal = JSON.parse(await readFile(join(source, 'meta', '_journal.json'), 'utf8'));
  const priorEntries = journal.entries.slice(0, 20);
  assert.equal(priorEntries.length, 20, 'The legacy baseline has migrations 0000 through 0019');
  await mkdir(join(tempRoot, 'meta'));
  for (const entry of priorEntries) await copyFile(join(source, `${entry.tag}.sql`), join(tempRoot, `${entry.tag}.sql`));
  await writeFile(join(tempRoot, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: priorEntries }, null, 2));
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: tempRoot });

  const { rows: [user] } = await pool.query(`INSERT INTO users (email, password_hash, display_name)
    VALUES ($1, 'migration-fixture', 'Migration fixture') RETURNING id`, ['fixture@example.invalid']);
  const { rows: [campaign] } = await pool.query(`INSERT INTO campaigns (owner_id, title)
    VALUES ($1, 'Retry migration fixture') RETURNING id`, [user.id]);
  await pool.query('INSERT INTO chat_messages (campaign_id, sender_id, body) VALUES ($1, $2, $3)', [campaign.id, user.id, 'legacy chat row']);
  await pool.query(`INSERT INTO dice_rolls (campaign_id, user_id, expression, result, detail)
    VALUES ($1, $2, '1d20', 7, '{"rolls":[7],"modifier":0}')`, [campaign.id, user.id]);

  const retryEntries = journal.entries.slice(0, 22);
  for (const entry of retryEntries.slice(20)) await copyFile(join(source, `${entry.tag}.sql`), join(tempRoot, `${entry.tag}.sql`));
  await writeFile(join(tempRoot, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: retryEntries }, null, 2));
  await migrate(db, { migrationsFolder: tempRoot });
  const { rows: chatRows } = await pool.query('SELECT body, client_message_id, request_digest FROM chat_messages WHERE campaign_id=$1', [campaign.id]);
  const { rows: diceRows } = await pool.query('SELECT expression, result, request_id, request_digest FROM dice_rolls WHERE campaign_id=$1', [campaign.id]);
  assert.deepEqual(chatRows, [{ body: 'legacy chat row', client_message_id: null, request_digest: null }]);
  assert.deepEqual(diceRows, [{ expression: '1d20', result: 7, request_id: null, request_digest: null }]);
  const { rows: [count] } = await pool.query('SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations');
  assert.equal(count.count, 22);
  const { rows: receiptRows } = await pool.query(`INSERT INTO rest_operation_receipts
    (actor_id, campaign_id, operation_type, request_id, payload_digest, result_ids)
    VALUES ($1, NULL, 'campaign.create', $2, repeat('a', 64), '["campaign-result"]') RETURNING actor_id`, [user.id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']);
  assert.equal(receiptRows.length, 1, 'campaign creation receipts support the pre-campaign actor scope');
  await assert.rejects(pool.query(`INSERT INTO rest_operation_receipts
    (actor_id, campaign_id, operation_type, request_id, payload_digest, result_ids)
    VALUES ($1, NULL, 'campaign.create', $2, repeat('b', 64), '["campaign-result"]')`, [user.id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']), /duplicate key/u);
  console.info('PASS: migration 20→21 preserves legacy chat/dice rows; 21→22 adds scoped REST receipts with actor-only campaign-create uniqueness.');

  const { rows: [asset] } = await pool.query(`INSERT INTO assets (campaign_id, storage_key, media_type, size, checksum, uploader_id)
    VALUES ($1, 'fixture-png', 'image/png', 123, repeat('a', 64), $2) RETURNING id`, [campaign.id, user.id]);
  const { rows: [scene] } = await pool.query(`INSERT INTO scenes (campaign_id, title, background_asset_id, is_active, published)
    VALUES ($1, 'Pre-geometry scene', $2, true, true) RETURNING id`, [campaign.id, asset.id]);
  const { rows: [layer] } = await pool.query(`INSERT INTO scene_layers (scene_id, name, kind)
    VALUES ($1, 'Fixture objects', 'OBJECTS') RETURNING id`, [scene.id]);
  await pool.query(`INSERT INTO scene_objects (scene_id, layer_id, kind, x, y) VALUES ($1, $2, 'RECTANGLE', 20, 30)`, [scene.id, layer.id]);
  await pool.query(`INSERT INTO tokens (scene_id, name, x, y, color) VALUES ($1, 'Migration token', 2, 3, '#996644')`, [scene.id]);
  await pool.query(`INSERT INTO initiative_trackers (campaign_id, scene_id, active, round) VALUES ($1, $2, true, 3)`, [campaign.id, scene.id]);

  const legacy = async () => (await pool.query(`SELECT
    (SELECT to_jsonb(c) FROM campaigns c WHERE id = $1) AS campaign,
    (SELECT to_jsonb(s) FROM scenes s WHERE id = $2) AS scene,
    (SELECT to_jsonb(a) FROM assets a WHERE id = $3) AS map,
    (SELECT to_jsonb(o) FROM scene_objects o WHERE scene_id = $2) AS object,
    (SELECT to_jsonb(t) FROM tokens t WHERE scene_id = $2) AS token,
    (SELECT to_jsonb(m) FROM chat_messages m WHERE campaign_id = $1) AS chat,
    (SELECT to_jsonb(i) FROM initiative_trackers i WHERE campaign_id = $1) AS initiative`,
    [campaign.id, scene.id, asset.id])).rows[0];
  const before = await legacy();
  assert.ok(Object.values(before).every(Boolean));
  await migrate(db, { migrationsFolder: source });
  assert.deepEqual(await legacy(), before);
  const { rows: [geometry] } = await pool.query(`SELECT
    (SELECT count(*)::int FROM scene_geometry WHERE scene_id = $1) AS state,
    (SELECT count(*)::int FROM scene_obstacles WHERE scene_id = $1) AS obstacles,
    (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS migrations`, [scene.id]);
  assert.deepEqual(geometry, { state: 0, obstacles: 0, migrations: 23 });
  console.info('PASS: migration 22→23 retains campaign, scene, map, tokens, objects, chat and initiative without creating geometry rows.');
} finally {
  await pool.end();
  const resolvedTemp = resolve(tempRoot);
  assert.ok(resolvedTemp.startsWith(resolve(tmpdir(), prefix)), 'Temporary migration folder is within the generated temp prefix');
  await rm(resolvedTemp, { recursive: true, force: true });
}

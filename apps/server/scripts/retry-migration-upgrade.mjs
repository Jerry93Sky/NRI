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
  const priorEntries = journal.entries.slice(0, -2);
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

  await migrate(db, { migrationsFolder: source });
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
} finally {
  await pool.end();
  const resolvedTemp = resolve(tempRoot);
  assert.ok(resolvedTemp.startsWith(resolve(tmpdir(), prefix)), 'Temporary migration folder is within the generated temp prefix');
  await rm(resolvedTemp, { recursive: true, force: true });
}

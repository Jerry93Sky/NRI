import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { sceneObjectProjection } from '../dist/domain/projections.js';

const repetitions = 20;
const precision = (number) => Number(number.toFixed(3));
const rank = (samples, quantile) => [...samples].sort((a, b) => a - b)[Math.ceil(quantile * samples.length) - 1];
export const percentiles = (values) => values.length ? { p50: precision(rank(values, 0.50)), p95: precision(rank(values, 0.95)) } : null;

export async function settle(db) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const { rows: [row] } = await db.query(`SELECT NOT EXISTS (
      SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
      AND pid <> pg_backend_pid() AND state <> 'idle'
    ) AS settled`);
    if (row.settled) return;
    await delay(10);
  }
  assert.fail('Publisher did not finish the profiling transaction');
}

export async function snapshot(db) {
  return (await db.query(`SELECT query, calls FROM pg_stat_statements
    WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
    AND query NOT LIKE '%pg_stat_statements%' AND query NOT LIKE '%pg_stat_activity%'`)).rows;
}

function receive({ socket, role }, event, count, started) {
  return new Promise((resolve, reject) => {
    const ids = new Set();
    let bytes = 0;
    const listener = (payload) => {
      const id = payload.object?.id ?? payload.layer?.id;
      assert.ok(id);
      ids.add(id);
      bytes += Buffer.byteLength(JSON.stringify([event, payload]), 'utf8');
      if (ids.size < count) return;
      clearTimeout(timer);
      socket.off(event, listener);
      resolve({ ids: [...ids].sort(), ms: performance.now() - started, bytes, role });
    };
    const timer = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`Missing ${event} in profiling run`));
    }, 6500);
    socket.on(event, listener);
  });
}

async function profileOperation(db, recipients, { operation, event, count, execute }) {
  await settle(db);
  const before = new Map((await snapshot(db)).map(({ query, calls }) => [query, Number(calls)]));
  const http = [];
  const untilLast = [];
  const afterHttp = [];
  const bytes = { GM: [], PLAYER: [] };
  for (let i = 0; i < repetitions; i++) {
    const started = performance.now();
    const delivery = Promise.all(recipients.map((recipient) => receive(recipient, event, count, started)));
    delivery.catch(() => {});
    const objects = await execute(i);
    const response = performance.now() - started;
    http.push(response);
    const receipts = await delivery;
    if (receipts.length === 0) continue;
    const ids = objects.map(({ id }) => id).sort();
    for (const receipt of receipts) {
      assert.deepEqual(receipt.ids, ids);
      bytes[receipt.role].push(receipt.bytes);
    }
    const last = Math.max(...receipts.map(({ ms }) => ms));
    untilLast.push(last);
    afterHttp.push(last - response);
  }
  await settle(db);
  let sql = 0;
  let boundary = 0;
  for (const row of await snapshot(db)) {
    const calls = Number(row.calls) - (before.get(row.query) ?? 0);
    if (/^(begin|commit)\b/iu.test(row.query)) boundary += calls;
    else sql += calls;
  }
  console.log('DELIVERY_PROFILE', JSON.stringify({
    operation, objects: count, sockets: recipients.length, repetitions, sql: sql / repetitions, boundary: boundary / repetitions,
    httpMs: percentiles(http), lastWireMs: percentiles(untilLast), afterHttpMs: percentiles(afterHttp),
    gmJsonBytes: percentiles(bytes.GM), playerJsonBytes: percentiles(bytes.PLAYER),
  }));
}

function profileProjections(source) {
  const iterations = 500;
  let observed = 0;
  for (const count of [1, 10, 50]) {
    const rows = source.slice(0, count).map((object) => ({ ...object, deletedAt: null }));
    for (const role of ['GM', 'PLAYER']) {
      // Warm the projection loop before sampling.
      for (let warm = 0; warm < iterations; warm++) for (const row of rows) observed += sceneObjectProjection(row, role).version;
      const times = [];
      for (let sample = 0; sample < repetitions; sample++) {
        const started = performance.now();
        for (let run = 0; run < iterations; run++) for (const row of rows) observed += sceneObjectProjection(row, role).version;
        times.push((performance.now() - started) * 1000 / iterations);
      }
      console.log('PROJECTION_PROFILE', JSON.stringify({ role, objects: count, repetitions, iterations,
        batchMicroseconds: percentiles(times) }));
    }
  }
  assert.ok(observed > 0);
}

export async function profileSceneEvents({ db, source, copy, create, edit, layer, layerEdit, primary, gm, player, observer }) {
  const recipients = [];
  for (const count of [0, 1, 4, 8]) {
    if (count === 1) recipients.push({ socket: await primary(), role: 'GM' });
    if (count === 4) recipients.push({ socket: await gm(), role: 'GM' }, { socket: await player(), role: 'PLAYER' }, { socket: await observer(), role: 'PLAYER' });
    if (count === 8) recipients.push({ socket: await gm(), role: 'GM' }, { socket: await primary(), role: 'GM' },
      { socket: await player(), role: 'PLAYER' }, { socket: await observer(), role: 'PLAYER' });
    for (const size of [1, 10, 50]) {
      await profileOperation(db, recipients, { operation: 'copy', event: 'scene:object_created', count: size,
        execute: () => copy(source.slice(0, size)) });
    }
    if (count === 0 || count === 4) {
      await profileOperation(db, recipients, { operation: 'create', event: 'scene:object_created', count: 1,
        execute: async () => [await create()] });
      let object = source.at(-1);
      await profileOperation(db, recipients, { operation: 'edit', event: 'scene:object_updated', count: 1,
        execute: async (step) => { object = (await edit(object, { x: 400 + step })).object; return [object]; } });
      source[source.length - 1] = object;
      await profileOperation(db, recipients, { operation: 'layer_edit', event: 'scene:layer_updated', count: 1,
        execute: async (step) => { layer = await layerEdit(layer, { name: `Profile layer ${count}/${step}` }); return [layer]; } });
    }
  }
  profileProjections(source);
}

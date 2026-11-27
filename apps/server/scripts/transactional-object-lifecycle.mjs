import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { io } from 'socket.io-client';

const api = new URL(process.env.NRI_API_URL ?? 'http://127.0.0.1:3000');
const database = new URL(process.env.DATABASE_URL);
assert.equal(process.env.NODE_ENV, 'test');
for (const url of [api, database]) assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Use isolated local services');
assert.match(database.pathname, /^\/nri_(?:test|object_test)$/u, 'Use a dedicated test database');
const db = new pg.Pool({ connectionString: database.href, query_timeout: 6500 });
const timeout = 6500;
const profileEnabled = process.env.NRI_OBJECT_PERF === '1';
if (profileEnabled) assert.equal(database.pathname, '/nri_object_test', 'Profile on a dedicated local database');
const sockets = [];
const events = [];
const eventsOfInterest = new Set(['scene:object_created', 'scene:object_deleted', 'scene:object_updated']);
let passed = 0;
const query = (sql, params) => db.query(sql, params);

async function scenario(name, run) {
  await run();
  console.log(`PASS ${++passed} ${name}`);
}

async function request(path, method, actor, body, expected = 200) {
  const response = await fetch(new URL(path, api), {
    method,
    signal: AbortSignal.timeout(timeout + 2000),
    headers: { ...(actor ? { cookie: actor.cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = response.status === 204 ? null : await response.json();
  assert.equal(response.status, expected, `${method} ${path} returned ${JSON.stringify(result)}`);
  const cookie = response.headers.getSetCookie().find((entry) => entry.startsWith('nri_session='))?.split(';')[0];
  return { result, cookie };
}

async function register(displayName) {
  const { result, cookie } = await request('/api/auth/register', 'POST', null,
    { email: `${randomUUID()}@nri.local`, displayName, password: randomUUID() }, 201);
  assert.ok(cookie);
  return { id: result.user.id, cookie };
}

async function connect(actor, campaignId, role) {
  const socket = io(api.origin, { autoConnect: false, reconnection: false, transports: ['websocket'], extraHeaders: { cookie: actor.cookie } });
  sockets.push(socket);
  socket.onAny((name, data) => {
    if (eventsOfInterest.has(name)) events.push({ socket, name, id: data.object?.id ?? data.objectId, data });
  });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
    socket.connect();
  });
  assert.deepEqual(await socket.timeout(timeout).emitWithAck('campaign:join', campaignId), { ok: true, role });
  return socket;
}

async function until(read, message) {
  const deadline = Date.now() + timeout - 500;
  while (Date.now() < deadline) {
    const current = await read();
    if (current) return current;
    await delay(15);
  }
  assert.fail(message);
}

function waitEvent(mark, socket, name, id) {
  return until(() => events.slice(mark).find((event) => event.socket === socket && event.name === name && event.id === id)?.data,
    `${name} for ${id} did not reach the expected socket`);
}

async function quiet(mark, ids, recipients = sockets, names = eventsOfInterest) {
  // Observe packet absence here. PostgreSQL lock graphs, not this delay, order competing requests.
  await delay(120);
  assert.deepEqual(events.slice(mark).filter((event) => recipients.includes(event.socket) && names.has(event.name) && ids.includes(event.id)), []);
}

async function waitOn(blockers, queryLike, exclude = []) {
  return until(async () => {
    const { rows } = await query(`SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND state = 'active' AND lower(query) LIKE $1
        AND pg_blocking_pids(pid) && $2::int[] AND NOT (pid = ANY($3::int[]))`, [queryLike, blockers, exclude]);
    assert.ok(rows.length < 2, `Ambiguous blockers for ${queryLike}`);
    return rows[0]?.pid;
  }, `No transaction with ${queryLike} waited for PostgreSQL backend(s) ${blockers}`);
}

async function gated(sql, params, contend) {
  const gate = await db.connect();
  const pending = [];
  const start = (operation) => {
    const promise = operation();
    pending.push(promise);
    promise.catch(() => {});
    return promise;
  };
  try {
    await gate.query('BEGIN');
    const { rowCount } = await gate.query(sql, params);
    assert.equal(rowCount, 1);
    await contend(gate.processID, start);
    await gate.query('COMMIT');
    return await Promise.all(pending);
  } finally {
    await gate.query('ROLLBACK').finally(() => gate.release());
    await Promise.allSettled(pending);
  }
}

function writerFirst(sql, params, write, writeSQL, command, commandSQL) {
  return gated(sql, params, async (gate, start) => {
    start(write);
    const writer = await waitOn([gate], writeSQL);
    start(command);
    await waitOn([gate, writer], commandSQL, [writer]);
  });
}

async function state(object) {
  return (await query('SELECT id, layer_id, x, version, deleted_at, visible, created_by FROM scene_objects WHERE id = $1', [object.id])).rows[0];
}

async function audit(object) {
  const { rows } = await query("SELECT action FROM audit_events WHERE target_id = $1 AND action IN ('scene.object_deleted', 'scene.object_restored') ORDER BY created_at, id", [object.id]);
  return rows.map(({ action }) => action);
}

const memberGate = 'SELECT user_id FROM campaign_memberships WHERE campaign_id = $1 AND user_id = $2 FOR UPDATE';
const memberRead = '%from "campaign_memberships"%for share%';
const layerGate = 'SELECT id FROM scene_layers WHERE id = $1 FOR UPDATE';
const layerRead = '%from "scene_layers"%for share%';
const objectGate = 'SELECT id FROM scene_objects WHERE id = $1 FOR UPDATE';
const objectWrite = '%from "scene_objects"%for no key update%';
const sessionGate = 'SELECT user_id FROM user_sessions WHERE token_hash = $1 FOR UPDATE';
const sessionRead = '%from "user_sessions"%for share%';

try {
  const owner = await register('Lifecycle Owner');
  const gm = await register('Lifecycle GM');
  const player = await register('Lifecycle Player');
  const observer = await register('Lifecycle Observer');
  const campaign = async (title) => (await request('/api/campaigns', 'POST', owner, { title }, 201)).result.campaign;
  const scene = async (host, title) => (await request('/api/scenes', 'POST', owner, { campaignId: host.id, title }, 201)).result.scene;
  const host = await campaign('Transactional object lifecycle');
  const foreign = await campaign('Foreign lifecycle fixtures');
  const active = await scene(host, 'Active scene');
  const draft = await scene(host, 'Draft scene');
  const foreignScene = await scene(foreign, 'Foreign scene');
  const { result: invite } = await request('/api/invitations', 'POST', owner, { campaignId: host.id }, 201);
  for (const actor of [gm, player, observer]) await request(`/api/invitations/${invite.invitation}/accept`, 'POST', actor);
  const member = (actor) => `/api/campaigns/${host.id}/members/${actor.id}`;
  const role = (actor, value) => request(`${member(actor)}/role`, 'POST', owner, { role: value });
  const remove = (actor) => request(member(actor), 'DELETE', owner, undefined, 204);
  await role(gm, 'GM');

  const ownerSocket = await connect(owner, host.id, 'OWNER');
  const gmSocket = await connect(gm, host.id, 'GM');
  const playerSocket = await connect(player, host.id, 'PLAYER');
  let watcher = await connect(observer, host.id, 'PLAYER');
  const readLayers = async (target) => (await request(`/api/scenes/${target.id}/layers`, 'GET', owner)).result;
  const activeLayers = await readLayers(active);
  const publicLayer = activeLayers.find(({ kind }) => kind === 'OBJECTS');
  const gmLayer = activeLayers.find(({ kind }) => kind === 'GM');
  const draftLayer = (await readLayers(draft)).find(({ kind }) => kind === 'OBJECTS');
  const foreignLayer = (await readLayers(foreignScene)).find(({ kind }) => kind === 'OBJECTS');
  const custom = async (name) => (await request(`/api/scenes/${active.id}/layers`, 'POST', owner, {
    name, kind: 'CUSTOM', visibleToPlayers: true,
  }, 201)).result.layer;
  const layerEdit = async (layer, patch) => (await request(`/api/layers/${layer.id}`, 'PATCH', owner, { expectedVersion: layer.version, ...patch })).result.layer;
  const create = async (layer = publicLayer, target = active, fields = {}, actor = owner) => (await request(`/api/scenes/${target.id}/objects`, 'POST', actor, {
    layerId: layer.id, kind: 'TEXT', x: 20, y: 30, text: 'Fixture object', ...fields,
  }, 201)).result.object;
  const edit = async (object, patch, status = 200) => (await request(`/api/objects/${object.id}`, 'PATCH', owner, { expectedVersion: object.version, ...patch }, status)).result;

  async function life(action, targets, { actor = gm, targetScene = active, status = 200 } = {}) {
    return (await request(`/api/scenes/${targetScene.id}/object-lifecycle`, 'PATCH', actor, {
      action, objects: targets.map(({ id, version }) => ({ objectId: id, expectedVersion: version })),
    }, status)).result;
  }

  async function change(action, targets, socket = playerSocket, options = {}) {
    const mark = events.length;
    const { objects } = await life(action, targets, options);
    const current = new Map(objects.map((object) => [object.id, object]));
    assert.deepEqual([...current.keys()].sort(), targets.map(({ id }) => id.toLowerCase()).sort());
    for (const target of targets) {
      const object = current.get(target.id.toLowerCase());
      const row = await state(object);
      assert.equal(row.version, target.version + 1);
      assert.equal(object.version, row.version);
      assert.equal(Boolean(row.deleted_at), action === 'delete');
      assert.equal(Object.hasOwn(object, 'deletedAt'), false);
      const wire = await waitEvent(mark, socket, action === 'delete' ? 'scene:object_deleted' : 'scene:object_created', object.id);
      if (action === 'delete') assert.deepEqual(wire, { sceneId: options.targetScene?.id ?? active.id, objectId: object.id });
      else assert.equal(wire.object.version, row.version);
    }
    return objects;
  }

  async function rejected(action, targets, status, error, options = {}) {
    const before = await Promise.all(targets.map(state));
    const mark = events.length;
    assert.deepEqual(await life(action, targets, { ...options, status }), { error });
    assert.deepEqual(await Promise.all(targets.map(state)), before);
    await quiet(mark, targets.map(({ id }) => id.toLowerCase()));
  }

  if (profileEnabled) {
    const probeCampaign = await campaign('Lifecycle SQL profile');
    const probeScene = await scene(probeCampaign, 'Profile scene');
    const probeLayer = (await readLayers(probeScene)).find(({ kind }) => kind === 'OBJECTS');
    const invitation = (await request('/api/invitations', 'POST', owner, { campaignId: probeCampaign.id }, 201)).result;
    for (const actor of [gm, player, observer]) await request(`/api/invitations/${invitation.invitation}/accept`, 'POST', actor);
    await request(`/api/campaigns/${probeCampaign.id}/members/${gm.id}/role`, 'POST', owner, { role: 'GM' });
    const probeSockets = [];
    const samples = 12;
    const median = (values) => {
      const sorted = [...values].sort((left, right) => left - right);
      return Number(((sorted[5] + sorted[6]) / 2).toFixed(2));
    };
    const snapshot = async () => (await query(`SELECT query, calls, total_exec_time FROM pg_stat_statements
      WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND query NOT LIKE '%pg_stat_statements%' AND query NOT LIKE '%pg_stat_activity%'`)).rows;
    for (const recipientCount of [0, 1, 4]) {
      if (recipientCount === 1) probeSockets.push(await connect(owner, probeCampaign.id, 'OWNER'));
      if (recipientCount === 4) {
        probeSockets.push(await connect(gm, probeCampaign.id, 'GM'));
        probeSockets.push(await connect(player, probeCampaign.id, 'PLAYER'));
        probeSockets.push(await connect(observer, probeCampaign.id, 'PLAYER'));
      }
      for (const size of [1, 10]) {
        let batch = await Promise.all(Array.from({ length: size }, () => create(probeLayer, probeScene)));
        const byQuery = new Map((await snapshot()).map((row) => [row.query, row]));
        const http = [];
        const wire = [];
        const afterHttp = [];
        for (let turn = 0; turn < samples; turn++) {
          const action = turn % 2 === 0 ? 'delete' : 'restore';
          const event = action === 'delete' ? 'scene:object_deleted' : 'scene:object_created';
          const expectedIds = batch.map(({ id }) => id);
          const started = performance.now();
          const receipts = probeSockets.map((socket) => new Promise((resolve, reject) => {
            const unseen = new Set(expectedIds);
            const listener = (packet) => {
              unseen.delete(packet.objectId ?? packet.object?.id);
              if (unseen.size > 0) return;
              clearTimeout(timer);
              socket.off(event, listener);
              resolve(performance.now() - started);
            };
            const timer = setTimeout(() => {
              socket.off(event, listener);
              reject(new Error('Timed out receiving profiled lifecycle events'));
            }, timeout);
            socket.on(event, listener);
          }));
          const allReceipts = Promise.all(receipts);
          allReceipts.catch(() => {});
          ({ objects: batch } = await life(action, batch, { actor: owner, targetScene: probeScene }));
          const httpTime = performance.now() - started;
          http.push(httpTime);
          const times = await allReceipts;
          if (times.length) {
            const last = Math.max(...times);
            wire.push(last);
            afterHttp.push(last - httpTime);
          }
        }
        let statements = 0;
        let boundaries = 0;
        let executionMs = 0;
        await until(async () => (await query(`SELECT NOT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
          AND pid <> pg_backend_pid() AND state <> 'idle'
        ) AS settled`)).rows[0].settled, 'Publisher did not finish its transaction');
        for (const row of await snapshot()) {
          const previous = byQuery.get(row.query);
          const calls = Number(row.calls) - Number(previous?.calls ?? 0);
          if (/^(begin|commit)\b/iu.test(row.query)) boundaries += calls;
          else {
            statements += calls;
            executionMs += row.total_exec_time - (previous?.total_exec_time ?? 0);
          }
        }
        console.log('PROFILE', JSON.stringify({
          size, sockets: recipientCount, samples, sqlPerCommand: statements / samples, boundariesPerCommand: boundaries / samples,
          meanPgExecutionMs: Number((executionMs / samples).toFixed(3)), medianRestMs: median(http),
          ...(wire.length ? { medianLastPacketMs: median(wire), medianPacketAfterHttpMs: median(afterHttp) } : {}),
        }));
      }
    }
    for (const socket of probeSockets) socket.disconnect();
  }

  const single = await create();
  let tombstone;
  let restored;
  await scenario('GM single delete persists tombstone, revision, audit and minimal event', async () => {
    [tombstone] = await change('delete', [single]);
    assert.deepEqual(await audit(single), ['scene.object_deleted']);
  });
  await scenario('GM single restore preserves ID and original data', async () => {
    [restored] = await change('restore', [{ ...tombstone, id: tombstone.id.toUpperCase() }]);
    assert.equal(restored.id, single.id);
    assert.equal(restored.text, single.text);
    assert.deepEqual(await audit(single), ['scene.object_deleted', 'scene.object_restored']);
  });
  await scenario('the manager point DELETE retains 204 and creates a restorable tombstone', async () => {
    const object = await create();
    const mark = events.length;
    const removeObject = (version, status) => request(`/api/objects/${object.id}`, 'DELETE', gm, { expectedVersion: version }, status);
    await removeObject(object.version, 204);
    const deleted = await state(object);
    assert.equal(deleted.version, object.version + 1);
    assert.ok(deleted.deleted_at);
    await waitEvent(mark, playerSocket, 'scene:object_deleted', object.id);
    assert.deepEqual((await removeObject(deleted.version, 404)).result, { error: 'NOT_FOUND' });
    await change('restore', [deleted]);
  });
  const group = [await create(), await create(), await create()];
  let deleted;
  await scenario('group delete updates every row and logs each target', async () => {
    deleted = await change('delete', [...group].reverse());
    for (const object of group) assert.deepEqual(await audit(object), ['scene.object_deleted']);
  });
  await scenario('group restore preserves all IDs and increments each version once', async () => {
    const updated = await change('restore', deleted);
    for (const object of updated) assert.deepEqual(await audit(object), ['scene.object_deleted', 'scene.object_restored']);
  });
  await scenario('version and state conflicts have the established code-only envelope', async () => {
    await rejected('delete', [single], 409, 'CONFLICT');
    await rejected('restore', [restored], 409, 'CONFLICT');
    const [gone] = await change('delete', [restored]);
    await rejected('delete', [gone], 409, 'CONFLICT');
  });
  await scenario('one stale item rejects every member of the group', async () => {
    const fresh = await create();
    await rejected('delete', [fresh, group[1]], 409, 'CONFLICT');
  });
  await scenario('unknown, wrong-scene and cross-campaign object IDs leave valid group members untouched', async () => {
    const local = await create();
    const outside = await create(foreignLayer, foreignScene);
    const inactive = await create(draftLayer, draft);
    await rejected('delete', [local, { id: randomUUID(), version: 1 }], 404, 'NOT_FOUND');
    await rejected('delete', [local, outside], 404, 'NOT_FOUND');
    await rejected('delete', [local, inactive], 404, 'NOT_FOUND');
    await rejected('delete', [inactive], 403, 'FORBIDDEN', { actor: player, targetScene: draft });
    await rejected('delete', [outside], 403, 'FORBIDDEN', { targetScene: foreignScene });
  });
  await scenario('the group contract rejects duplicates and bounds batches', async () => {
    const object = await create();
    await rejected('delete', [object, { ...object, id: object.id.toUpperCase() }], 400, 'INVALID');
    const overflow = Array.from({ length: 51 }, () => ({ id: randomUUID(), version: 1 }));
    assert.deepEqual(await life('delete', overflow, { status: 400 }), { error: 'INVALID' });
  });
  await scenario('private restores never broadcast metadata or creator IDs to Players', async () => {
    const secret = await create(gmLayer, active, { text: 'Private fixture note' });
    const mark = events.length;
    const [gone] = await change('delete', [secret], gmSocket);
    const [live] = await change('restore', [gone], gmSocket);
    assert.equal(live.visible, false);
    const event = await waitEvent(mark, gmSocket, 'scene:object_created', secret.id);
    assert.equal(event.object.text, 'Private fixture note');
    await quiet(mark, [secret.id], [playerSocket, watcher]);
    await rejected('delete', [secret], 409, 'CONFLICT');
    await rejected('delete', [secret], 403, 'FORBIDDEN', { actor: player });
    await rejected('delete', [{ id: randomUUID(), version: 1 }], 403, 'FORBIDDEN', { actor: player });
    const list = (await request(`/api/scenes/${active.id}/objects`, 'GET', player)).result;
    assert.equal(list.some(({ id }) => id === secret.id), false);
  });
  await scenario('draft lifecycle is manager-only in replies and delivery', async () => {
    const object = await create(draftLayer, draft);
    const mark = events.length;
    const [gone] = await change('delete', [object], gmSocket, { targetScene: draft });
    await change('restore', [gone], gmSocket, { targetScene: draft });
    await quiet(mark, [object.id], [playerSocket, watcher]);
  });
  await scenario('object and layer lock rules reject delete or restore without partial writes', async () => {
    const layer = await custom('Locked layer');
    const inLayer = await create(layer);
    const object = await create();
    const [gone] = await change('delete', [inLayer]);
    await layerEdit(layer, { locked: true });
    await rejected('restore', [gone], 409, 'LAYER_LOCKED');
    const lockedObject = (await edit(object, { locked: true })).object;
    await rejected('delete', [await create(), lockedObject], 409, 'OBJECT_LOCKED');
  });

  async function demotion(action) {
    const root = await create();
    const target = action === 'restore' ? (await change('delete', [root]))[0] : root;
    const before = await state(target);
    const mark = events.length;
    const [, result] = await writerFirst(memberGate, [host.id, gm.id], () => role(gm, 'PLAYER'),
      'update "campaign_memberships"%', () => life(action, [target], { status: 403 }), memberRead);
    assert.deepEqual(result, { error: 'FORBIDDEN' });
    assert.deepEqual(await state(target), before);
    await quiet(mark, [target.id]);
    await role(gm, 'GM');
  }
  await scenario('a queued role demotion blocks a concurrent delete', () => demotion('delete'));
  await scenario('a queued role demotion blocks a concurrent restore', () => demotion('restore'));

  await scenario('layer lock queued first is seen by concurrent lifecycle validation', async () => {
    const layer = await custom('Layer lock race');
    const object = await create(layer);
    const before = await state(object);
    const mark = events.length;
    const [, result] = await writerFirst(layerGate, [layer.id], () => layerEdit(layer, { locked: true }),
      '%from "scene_layers"%for no key update%', () => life('delete', [object], { status: 409 }), layerRead);
    assert.deepEqual(result, { error: 'LAYER_LOCKED' });
    assert.deepEqual(await state(object), before);
    await quiet(mark, [object.id]);
  });
  await scenario('removing a layer first purges its tombstones and makes restore unavailable', async () => {
    const layer = await custom('Layer removal race');
    const [object] = await change('delete', [await create(layer)]);
    const mark = events.length;
    const [, result] = await writerFirst(layerGate, [layer.id], () => request(`/api/layers/${layer.id}`, 'DELETE', owner,
      { expectedVersion: layer.version }, 204), '%from "scene_layers"%for update%', () => life('restore', [object], { status: 404 }), layerRead);
    assert.deepEqual(result, { error: 'NOT_FOUND' });
    assert.equal(await state(object), undefined);
    await quiet(mark, [object.id]);
  });
  await scenario('a concurrent move to another layer invalidates the old lifecycle revision', async () => {
    const destination = await custom('Moved destination');
    const object = await create();
    const mark = events.length;
    const [editReply, deleteReply] = await writerFirst(objectGate, [object.id], () => edit(object, { layerId: destination.id }), objectWrite,
      () => life('delete', [object], { status: 409 }), objectWrite);
    assert.deepEqual(deleteReply, { error: 'CONFLICT' });
    assert.equal(editReply.object.layerId, destination.id);
    const row = await state(object);
    assert.deepEqual([row.layer_id, row.version, row.deleted_at], [destination.id, object.version + 1, null]);
    await waitEvent(mark, playerSocket, 'scene:object_updated', object.id);
    await quiet(mark, [object.id], sockets, new Set(['scene:object_deleted']));
  });
  await scenario('scene archive queued first denies a lifecycle command without writes', async () => {
    const object = await create(draftLayer, draft);
    const before = await state(object);
    const mark = events.length;
    const [, result] = await writerFirst('SELECT id FROM campaigns WHERE id = $1 FOR NO KEY UPDATE', [host.id],
      () => request(`/api/scenes/${draft.id}/archive`, 'PUT', owner, { expectedVersion: draft.version }),
      '%from "campaigns"%for no key update%', () => life('delete', [object], { targetScene: draft, status: 404 }), '%from "campaigns"%for share%');
    assert.deepEqual(result, { error: 'NOT_FOUND' });
    assert.deepEqual(await state(object), before);
    await quiet(mark, [object.id]);
  });
  await scenario('competing edit and delete cannot overwrite each other', async () => {
    const object = await create();
    const mark = events.length;
    const [deletedReply, editReply] = await writerFirst(objectGate, [object.id], () => life('delete', [object]), objectWrite,
      () => edit(object, { x: 99 }, 404), objectWrite);
    assert.deepEqual(editReply, { error: 'NOT_FOUND' });
    const row = await state(object);
    assert.equal(row.version, deletedReply.objects[0].version);
    assert.equal(row.x, object.x);
    assert.ok(row.deleted_at);
    await waitEvent(mark, playerSocket, 'scene:object_deleted', object.id);
    await quiet(mark, [object.id], sockets, new Set(['scene:object_updated']));
  });
  await scenario('overlapping batches with opposite order have one atomic winner', async () => {
    const targets = [await create(), await create()];
    const first = targets.map(({ id }) => id).sort()[0];
    const mark = events.length;
    const [success, conflict] = await writerFirst(objectGate, [first], () => life('delete', targets), objectWrite,
      () => life('delete', [...targets].reverse(), { actor: owner, status: 409 }), objectWrite);
    assert.deepEqual(conflict, { error: 'CONFLICT' });
    assert.equal(success.objects.length, targets.length);
    for (const object of targets) {
      assert.equal((await state(object)).version, object.version + 1);
      assert.deepEqual(await audit(object), ['scene.object_deleted']);
      await waitEvent(mark, watcher, 'scene:object_deleted', object.id);
    }
  });
  await scenario('SQL failure after the batch update rolls back rows and audit and publishes nothing', async () => {
    const targets = [await create(), await create()];
    const before = await Promise.all(targets.map(state));
    const mark = events.length;
    const id = targets[1].id;
    assert.match(id, /^[a-f0-9-]{36}$/u);
    const name = `lifecycle_rollback_${randomUUID().replaceAll('-', '')}`;
    await query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Intentional failure in isolated lifecycle test'; END; $$`);
    try {
      await query(`CREATE TRIGGER ${name} BEFORE INSERT ON audit_events FOR EACH ROW
        WHEN (NEW.action = 'scene.object_deleted' AND NEW.target_id = '${id}'::uuid) EXECUTE FUNCTION ${name}()`);
      assert.deepEqual(await life('delete', targets, { status: 500 }), { error: 'INTERNAL_ERROR' });
      assert.deepEqual(await Promise.all(targets.map(state)), before);
      assert.deepEqual(await Promise.all(targets.map(audit)), [[], []]);
      await quiet(mark, targets.map(({ id }) => id));
    } finally {
      await query(`DROP TRIGGER IF EXISTS ${name} ON audit_events`);
      await query(`DROP FUNCTION ${name}()`);
    }
  });

  function recipientGate(actor) {
    return [createHash('sha256').update(actor.cookie.split('=')[1]).digest('hex')];
  }
  await scenario('a layer hidden after commit suppresses Player restore packets', async () => {
    const layer = await custom('Audience layer race');
    const [object] = await change('delete', [await create(layer)]);
    const mark = events.length;
    const [result] = await gated(sessionGate, recipientGate(player), async (pid, start) => {
      const response = await start(() => life('restore', [object]));
      assert.equal((await state(object)).version, response.objects[0].version);
      assert.equal((await state(object)).deleted_at, null);
      await waitOn([pid], sessionRead);
      assert.equal(events.slice(mark).some(({ id }) => id === object.id), false);
      await layerEdit(layer, { visibleToPlayers: false });
    });
    const delivered = await waitEvent(mark, ownerSocket, 'scene:object_created', object.id);
    assert.equal(delivered.object.version, result.objects[0].version);
    await quiet(mark, [object.id], [playerSocket, watcher]);
  });
  await scenario('a recipient demoted after commit loses private restore on both open sockets', async () => {
    await role(observer, 'GM');
    const secondWatcher = await connect(observer, host.id, 'GM');
    const [object] = await change('delete', [await create(gmLayer)], ownerSocket);
    const mark = events.length;
    await gated(sessionGate, recipientGate(observer), async (pid, start) => {
      await start(() => life('restore', [object]));
      await waitOn([pid], sessionRead);
      await role(observer, 'PLAYER');
    });
    await waitEvent(mark, gmSocket, 'scene:object_created', object.id);
    await quiet(mark, [object.id], [watcher, secondWatcher, playerSocket]);
  });
  await scenario('public restore contains no creator ID and refills the snapshot on reconnect', async () => {
    const [object] = await change('delete', [await create()]);
    watcher.disconnect();
    const mark = events.length;
    const [live] = await change('restore', [object], playerSocket);
    const restoredEvent = await waitEvent(mark, playerSocket, 'scene:object_created', object.id);
    assert.equal(Object.hasOwn(restoredEvent.object, 'createdBy'), false);
    assert.equal(Object.hasOwn(restoredEvent.object, 'deletedAt'), false);
    watcher = await connect(observer, host.id, 'PLAYER');
    const list = (await request(`/api/scenes/${active.id}/objects`, 'GET', observer)).result;
    const fromSnapshot = list.find(({ id }) => id === object.id);
    assert.equal(fromSnapshot.version, live.version);
    assert.equal(Object.hasOwn(fromSnapshot, 'createdBy'), false);
  });
  await scenario('Player can permanently clean their own freehand after drawing permission is disabled', async () => {
    const drawingPath = `/api/campaigns/${host.id}/player-drawing`;
    const stroke = { kind: 'FREEHAND', text: null, points: [{ x: 1, y: 1 }, { x: 2, y: 2 }], color: '#121212' };
    await request(drawingPath, 'PUT', owner, { enabled: true });
    const own = await create(publicLayer, active, stroke, player);
    const ownBulk = await create(publicLayer, active, stroke, player);
    const someoneElse = await create(publicLayer, active, stroke, observer);
    await request(drawingPath, 'PUT', owner, { enabled: false });
    await rejected('delete', [own], 403, 'FORBIDDEN', { actor: player });
    const hidden = await create(gmLayer);
    const removeObject = (object, status) => request(`/api/objects/${object.id}`, 'DELETE', player, { expectedVersion: object.version }, status);
    assert.deepEqual((await removeObject(someoneElse, 403)).result, { error: 'FORBIDDEN' });
    assert.deepEqual((await removeObject(hidden, 404)).result, { error: 'NOT_FOUND' });
    const mark = events.length;
    await removeObject(own, 204);
    assert.equal(await state(own), undefined);
    assert.deepEqual(await audit(own), ['scene.object_deleted']);
    const { result } = await request(`/api/scenes/${active.id}/my-drawings`, 'DELETE', player);
    assert.deepEqual(result, { deletedCount: 1 });
    assert.equal(await state(ownBulk), undefined);
    assert.ok(await state(someoneElse));
    for (const object of [own, ownBulk]) await waitEvent(mark, watcher, 'scene:object_deleted', object.id);
    const { rows } = await query("SELECT detail FROM audit_events WHERE action = 'scene.own_drawings_cleared' AND target_id = $1 AND actor_id = $2", [active.id, player.id]);
    assert.deepEqual(rows, [{ detail: '1' }]);
  });

  await scenario('membership withdrawal queued first rejects a manager lifecycle command', async () => {
    await role(observer, 'GM');
    const object = await create();
    const before = await state(object);
    const mark = events.length;
    const [, reply] = await writerFirst(memberGate, [host.id, observer.id], () => remove(observer),
      'delete from "campaign_memberships"%', () => life('delete', [object], { actor: observer, status: 403 }), memberRead);
    assert.deepEqual(reply, { error: 'FORBIDDEN' });
    assert.deepEqual(await state(object), before);
    await quiet(mark, [object.id]);
  });
  await scenario('lifecycle holding membership commits before removal and further use is denied', async () => {
    const object = await create();
    const mark = events.length;
    const [result] = await gated(objectGate, [object.id], async (pid, start) => {
      start(() => life('delete', [object]));
      const actor = await waitOn([pid], objectWrite);
      start(() => remove(gm));
      await waitOn([actor], 'delete from "campaign_memberships"%');
    });
    assert.equal((await state(object)).version, object.version + 1);
    await waitEvent(mark, ownerSocket, 'scene:object_deleted', object.id);
    await rejected('restore', result.objects, 403, 'FORBIDDEN');
  });
  await scenario('logout queued first invalidates a concurrent object lifecycle command', async () => {
    const object = await create();
    const mark = events.length;
    const before = await state(object);
    const [, reply] = await writerFirst(sessionGate, recipientGate(owner),
      () => request('/api/auth/logout', 'POST', owner, undefined, 204), 'delete from "user_sessions"%',
      () => life('delete', [object], { actor: owner, status: 401 }), sessionRead);
    assert.deepEqual(reply, { error: 'UNAUTHENTICATED' });
    assert.deepEqual(await state(object), before);
    await quiet(mark, [object.id]);
  });
  console.log(`Passed ${passed} transactional object lifecycle scenarios against PostgreSQL`);
} finally {
  for (const socket of sockets) socket.disconnect();
  await db.end();
}

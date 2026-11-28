import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { io } from 'socket.io-client';

const api = new URL(process.env.NRI_API_URL ?? 'http://127.0.0.1:3000');
const database = new URL(process.env.DATABASE_URL);
assert.equal(process.env.NODE_ENV, 'test');
for (const url of [api, database]) assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Use isolated local services');
assert.match(database.pathname, /^\/nri_(?:test|realtime_test)$/u, 'Use a dedicated test database');
const db = new pg.Pool({ connectionString: database.href, query_timeout: 6500 });
const timeout = 6500;
const sockets = [];
const events = [];
const eventsOfInterest = new Set(['scene:object_created', 'scene:object_deleted', 'scene:object_updated',
  'scene:layer_created', 'scene:layer_updated', 'scene:layer_hidden', 'scene:layer_deleted']);
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
    if (eventsOfInterest.has(name)) events.push({ socket, name, id: data.object?.id ?? data.objectId ?? data.layer?.id ?? data.layerId, data });
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
  const unexpected = events.slice(mark).filter((event) => recipients.includes(event.socket) && names.has(event.name) && ids.includes(event.id));
  assert.deepEqual(unexpected.map(({ name, id }) => ({ name, id })), []);
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
    await contend(gate.processID, start, gate);
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
function cookieHash(actor) {
  return createHash('sha256').update(actor.cookie.split('=')[1]).digest('hex');
}

async function state(object) {
  return (await query('SELECT id, layer_id, x, version, deleted_at, visible, created_by FROM scene_objects WHERE id = $1', [object.id])).rows[0];
}

const sessionGate = 'SELECT user_id FROM user_sessions WHERE token_hash = $1 FOR UPDATE';
const sessionRead = '%from "user_sessions"%for share%';
const layerGate = 'SELECT id FROM scene_layers WHERE id = $1 FOR UPDATE';
const layerShare = '%from "scene_layers"%for share%';
const layerWrite = '%from "scene_layers"%for no key update%';
const createdEvent = 'scene:object_created';
const updatedEvent = 'scene:object_updated';
const deletedEvent = 'scene:object_deleted';

try {
  const owner = await register('Realtime Owner');
  const gm = await register('Realtime GM');
  const player = await register('Realtime Player');
  const observer = await register('Realtime Observer');
  const makeCampaign = async (title) => (await request('/api/campaigns', 'POST', owner, { title }, 201)).result.campaign;
  const makeScene = async (campaign, title) => (await request('/api/scenes', 'POST', owner, { campaignId: campaign.id, title }, 201)).result.scene;
  const campaign = await makeCampaign('Secure delivery fixture');
  const foreign = await makeCampaign('Foreign delivery fixture');
  const active = await makeScene(campaign, 'Active');
  const draft = await makeScene(campaign, 'Draft');
  const foreignScene = await makeScene(foreign, 'Other campaign');
  const { result: invite } = await request('/api/invitations', 'POST', owner, { campaignId: campaign.id }, 201);
  async function joinMembership(actor) { await request(`/api/invitations/${invite.invitation}/accept`, 'POST', actor); }
  for (const actor of [gm, player, observer]) await joinMembership(actor);
  const memberPath = (actor) => `/api/campaigns/${campaign.id}/members/${actor.id}`;
  const changeRole = (actor, role) => request(`${memberPath(actor)}/role`, 'POST', owner, { role });
  await changeRole(gm, 'GM');
  const ownerSocket = await connect(owner, campaign.id, 'OWNER');
  const gmSocket = await connect(gm, campaign.id, 'GM');
  const gmSecond = await connect(gm, campaign.id, 'GM');
  const playerSocket = await connect(player, campaign.id, 'PLAYER');
  let watcher = await connect(observer, campaign.id, 'PLAYER');
  const foreignSocket = await connect(owner, foreign.id, 'OWNER');
  const layers = async (scene = active) => (await request(`/api/scenes/${scene.id}/layers`, 'GET', owner)).result;
  const defaults = await layers();
  const visibleLayer = defaults.find(({ kind }) => kind === 'OBJECTS');
  const gmLayer = defaults.find(({ kind }) => kind === 'GM');
  const draftLayer = (await layers(draft)).find(({ kind }) => kind === 'OBJECTS');
  const foreignLayer = (await layers(foreignScene)).find(({ kind }) => kind === 'OBJECTS');
  let serial = 0;
  const textObject = (layer, patch = {}) => ({ layerId: layer.id, kind: 'TEXT', x: 20, y: 30, text: 'Fixture note', ...patch });

  const custom = async (fields = {}, scene = active) => (await request(`/api/scenes/${scene.id}/layers`, 'POST', owner, {
    name: `Fixture ${++serial}`, kind: 'CUSTOM', visibleToPlayers: true, ...fields,
  }, 201)).result.layer;
  const layerEdit = async (layer, patch) => (await request(`/api/layers/${layer.id}`, 'PATCH', owner, { expectedVersion: layer.version, ...patch })).result.layer;
  const layerDelete = (layer) => request(`/api/layers/${layer.id}`, 'DELETE', owner, { expectedVersion: layer.version }, 204);
  const create = async (layer = visibleLayer, { scene = active, patch, actor = owner } = {}) =>
    (await request(`/api/scenes/${scene.id}/objects`, 'POST', actor, textObject(layer, patch), 201)).result.object;
  const edit = async (object, patch, status = 200) =>
    (await request(`/api/objects/${object.id}`, 'PATCH', owner, { expectedVersion: object.version, ...patch }, status)).result;
  const copy = async (targets, layer = visibleLayer, scene = active) =>
    (await request(`/api/scenes/${scene.id}/objects/duplicate`, 'POST', owner,
      { layerId: layer.id, objects: targets.map(({ id, version }, index) => ({ objectId: id, expectedVersion: version, x: 40 + index, y: 55 })) }, 201)).result.objects;
  const playerObjects = async (scene = active, actor = player) => (await request(`/api/scenes/${scene.id}/objects`, 'GET', actor)).result;
  const removeObject = (object) => request(`/api/objects/${object.id}`, 'DELETE', owner, { expectedVersion: object.version }, 204);

  async function changeAfterCommit(blocker, command, change) {
    const [result] = await gated(sessionGate, [cookieHash(blocker)], async (pid, start) => {
      const outcome = await start(command);
      await waitOn([pid], sessionRead);
      await change(outcome);
    });
    return result;
  }

  async function setupObject(layer = visibleLayer, options) {
    const mark = events.length;
    const object = await create(layer, options);
    await waitEvent(mark, ownerSocket, createdEvent, object.id);
    await Promise.all(sockets.filter((socket) => socket.connected).map(async (socket) => {
      assert.deepEqual(await socket.timeout(timeout).emitWithAck('scene:pointer', null), { error: 'INVALID' });
    }));
    return object;
  }

  if (process.argv.includes('--profile')) {
    assert.equal(database.pathname, '/nri_realtime_test');
    const { profileSceneEvents } = await import('./secure-realtime-profile.mjs');
    const source = await Promise.all(Array.from({ length: 50 }, () => create()));
    for (const socket of sockets) socket.disconnect();
    const layer = await custom();
    await profileSceneEvents({ db, source, copy, create, edit, layer, layerEdit, primary: () => connect(owner, campaign.id, 'OWNER'),
      gm: () => connect(gm, campaign.id, 'GM'),
      player: () => connect(player, campaign.id, 'PLAYER'), observer: () => connect(observer, campaign.id, 'PLAYER') });
  } else {
    await scenario('public creation and edit send current versions with per-role projections', async () => {
      const mark = events.length;
      const object = await create();
      const playerPacket = await waitEvent(mark, playerSocket, createdEvent, object.id);
      assert.equal(playerPacket.object.version, 1);
      assert.equal(Object.hasOwn(playerPacket.object, 'createdBy'), false);
      assert.equal((await waitEvent(mark, gmSocket, createdEvent, object.id)).object.createdBy, owner.id);
      const opened = events.length;
      const { object: updated } = await edit(object, { x: 99 });
      const row = await state(object);
      assert.deepEqual([row.x, row.version, row.deleted_at], [99, updated.version, null]);
      assert.equal((await waitEvent(opened, watcher, updatedEvent, object.id)).object.version, row.version);
      await quiet(mark, [object.id], [foreignSocket]);
    });

    await scenario('private object, GM layer and draft only reach managers', async () => {
      const mark = events.length;
      const hidden = await create(visibleLayer, { patch: { visible: false } });
      const secret = await create(gmLayer);
      const prepared = await create(draftLayer, { scene: draft });
      for (const object of [hidden, secret, prepared]) {
        const packet = await waitEvent(mark, gmSocket, createdEvent, object.id);
        assert.equal(packet.object.createdBy, owner.id);
        const row = await state(object);
        assert.equal(packet.object.version, row.version);
        assert.equal((await playerObjects()).some(({ id }) => id === object.id), false);
      }
      const changed = events.length;
      await edit(hidden, { text: 'Private revision' });
      const packet = await waitEvent(changed, ownerSocket, updatedEvent, hidden.id);
      assert.equal(packet.object.text, 'Private revision');
      await quiet(mark, [hidden.id, secret.id, prepared.id], [playerSocket, watcher, foreignSocket]);
    });

    await scenario('copying from hidden source keeps single and group copies private', async () => {
      const hiddenLayer = await custom({ visibleToPlayers: false });
      const targets = [await setupObject(hiddenLayer), await setupObject(hiddenLayer)];
      const mark = events.length;
      const clones = [...await copy(targets.slice(0, 1)), ...await copy(targets)];
      for (const clone of clones) {
        assert.equal(clone.visible, false);
        assert.equal((await state(clone)).visible, false);
        assert.equal((await waitEvent(mark, gmSocket, createdEvent, clone.id)).object.visible, false);
      }
      await quiet(mark, clones.map(({ id }) => id), [playerSocket, watcher]);
    });

    await scenario('committed creation checks role again for both tabs of a demoted GM', async () => {
      const mark = events.length;
      const object = await changeAfterCommit(player, () => create(gmLayer), async (stored) => {
        assert.equal((await state(stored)).version, 1);
        await changeRole(gm, 'PLAYER');
      });
      assert.ok(await waitEvent(mark, ownerSocket, createdEvent, object.id));
      await quiet(mark, [object.id], [gmSocket, gmSecond, playerSocket, watcher]);
      await changeRole(gm, 'GM');
    });

    await scenario('layer hide purges public view and reopen reloads current IDs and versions only', async () => {
      const mark = events.length;
      let layer = await custom();
      assert.equal((await waitEvent(mark, playerSocket, 'scene:layer_created', layer.id)).layer.version, layer.version);
      let object = await setupObject(layer);
      const secret = await setupObject(layer, { patch: { visible: false } });
      const hide = events.length;
      layer = await layerEdit(layer, { name: 'Secret layer title', visibleToPlayers: false, sortOrder: 9 });
      assert.deepEqual(await waitEvent(hide, watcher, 'scene:layer_hidden', layer.id), { sceneId: active.id, layerId: layer.id });
      assert.equal((await waitEvent(hide, gmSocket, 'scene:layer_updated', layer.id)).layer.name, 'Secret layer title');
      assert.equal((await playerObjects()).some(({ id }) => id === object.id), false);
      const hiddenEdit = events.length;
      object = (await edit(object, { x: 92 })).object;
      await waitEvent(hiddenEdit, ownerSocket, updatedEvent, object.id);
      await quiet(hiddenEdit, [object.id], [playerSocket, watcher]);
      const show = events.length;
      layer = await layerEdit(layer, { visibleToPlayers: true, name: 'Open again', locked: true });
      const visible = (await waitEvent(show, playerSocket, 'scene:layer_updated', layer.id)).layer;
      assert.deepEqual([visible.version, visible.name, visible.sortOrder, visible.locked], [layer.version, 'Open again', 9, true]);
      const list = await playerObjects();
      assert.equal(list.find(({ id }) => id === object.id).version, object.version);
      assert.equal(Object.hasOwn(list.find(({ id }) => id === object.id), 'createdBy'), false);
      assert.equal(list.some(({ id }) => id === secret.id), false);
    });

    await scenario('layer removal is ID-only, campaign-scoped and audited', async () => {
      const layer = await custom();
      const mark = events.length;
      await layerDelete(layer);
      assert.deepEqual(await waitEvent(mark, playerSocket, 'scene:layer_deleted', layer.id), { sceneId: active.id, layerId: layer.id });
      assert.equal((await query('SELECT id FROM scene_layers WHERE id = $1', [layer.id])).rowCount, 0);
      assert.equal((await query("SELECT id FROM audit_events WHERE action = 'scene.layer_deleted' AND target_id = $1", [layer.id])).rowCount, 1);
      await quiet(mark, [layer.id], [foreignSocket]);
    });

    await scenario('moves project all four source to target visibility transitions', async () => {
      const privateA = await custom({ visibleToPlayers: false });
      const privateB = await custom({ visibleToPlayers: false });
      const publicB = await custom();
      let object = await setupObject();
      let mark = events.length;
      object = (await edit(object, { layerId: privateA.id })).object;
      assert.deepEqual(await waitEvent(mark, playerSocket, deletedEvent, object.id), { sceneId: active.id, objectId: object.id });
      await waitEvent(mark, gmSocket, updatedEvent, object.id);
      await quiet(mark, [object.id], [playerSocket], new Set([updatedEvent]));
      mark = events.length;
      object = (await edit(object, { layerId: privateB.id })).object;
      await waitEvent(mark, gmSocket, updatedEvent, object.id);
      await quiet(mark, [object.id], [watcher, playerSocket]);
      mark = events.length;
      object = (await edit(object, { layerId: publicB.id })).object;
      assert.equal((await waitEvent(mark, playerSocket, updatedEvent, object.id)).object.layerId, publicB.id);
      mark = events.length;
      object = (await edit(object, { layerId: visibleLayer.id })).object;
      assert.equal((await waitEvent(mark, playerSocket, updatedEvent, object.id)).object.layerId, visibleLayer.id);
      assert.equal((await state(object)).layer_id, visibleLayer.id);
    });

    for (const operation of ['create', 'edit', 'move']) {
      await scenario(`${operation} waits for a competing layer hide and publishes only the current permitted state`, async () => {
        const layerMark = events.length;
        const layer = await custom();
        await waitEvent(layerMark, ownerSocket, 'scene:layer_created', layer.id);
        const source = operation === 'edit' ? await setupObject(layer) : operation === 'move' ? await setupObject() : undefined;
        const mark = events.length;
        const [, object] = await writerFirst(layerGate, [layer.id], () => layerEdit(layer, { visibleToPlayers: false }), layerWrite,
          () => operation === 'create' ? create(layer) : edit(source, operation === 'move' ? { layerId: layer.id } : { x: 72 }).then(({ object }) => object),
          layerShare);
        const expected = operation === 'create' ? createdEvent : updatedEvent;
        assert.equal((await state(object)).layer_id, layer.id);
        assert.ok(await waitEvent(mark, ownerSocket, expected, object.id));
        await quiet(mark, [object.id], [playerSocket, watcher], new Set([createdEvent, updatedEvent]));
        if (operation === 'move') await waitEvent(mark, playerSocket, deletedEvent, object.id);
      });
    }

    await scenario('committed edit suppresses Player projection if the layer hides before publication', async () => {
      const layer = await custom();
      const object = await setupObject(layer);
      const mark = events.length;
      await changeAfterCommit(player, () => edit(object, { x: 52 }), () => layerEdit(layer, { visibleToPlayers: false }));
      assert.equal((await waitEvent(mark, gmSocket, updatedEvent, object.id)).object.x, 52);
      await waitEvent(mark, playerSocket, 'scene:layer_hidden', layer.id);
      await quiet(mark, [object.id], [playerSocket, watcher]);
      assert.equal((await playerObjects()).some(({ id }) => id === object.id), false);
    });

    await scenario('superseded edit never sends the old object revision', async () => {
      let object = await setupObject();
      const mark = events.length;
      await changeAfterCommit(player, () => edit(object, { x: 71 }), async ({ object: old }) => {
        assert.deepEqual([old.x, (await state(old)).x], [71, 71]);
        object = (await edit(old, { x: 84 })).object;
      });
      assert.equal((await waitEvent(mark, playerSocket, updatedEvent, object.id)).object.version, object.version);
      const received = events.slice(mark).filter((entry) => entry.id === object.id && entry.socket === playerSocket && entry.name === updatedEvent);
      assert.deepEqual(received.map(({ data }) => data.object.x), [84]);
      assert.deepEqual(await edit({ ...object, version: object.version - 1 }, { x: 101 }, 409), { error: 'CONFLICT' });
      assert.equal((await state(object)).x, 84);
    });

    await scenario('a pending hide still removes a previously public object after a later private edit', async () => {
      const object = await setupObject();
      const mark = events.length;
      await changeAfterCommit(player, () => edit(object, { visible: false }), ({ object: hidden }) => edit(hidden, { text: 'Latest private value' }));
      assert.deepEqual(await waitEvent(mark, playerSocket, deletedEvent, object.id), { sceneId: active.id, objectId: object.id });
      await quiet(mark, [object.id], [playerSocket, watcher], new Set([updatedEvent]));
      assert.equal((await state(object)).visible, false);
    });

    await scenario('tombstone suppresses a previously committed pending update', async () => {
      const object = await setupObject();
      const mark = events.length;
      await changeAfterCommit(player, () => edit(object, { x: 66 }), ({ object: current }) => removeObject(current));
      await waitEvent(mark, playerSocket, deletedEvent, object.id);
      await quiet(mark, [object.id], [playerSocket, watcher, gmSocket], new Set([updatedEvent]));
      assert.ok((await state(object)).deleted_at);
    });

    await scenario('rapid hide and reopen discard stale layer packets and allow the latest snapshot', async () => {
      const layer = await custom();
      const object = await setupObject(layer);
      const mark = events.length;
      await changeAfterCommit(player, () => layerEdit(layer, { visibleToPlayers: false, name: 'Unsent private name' }),
        async (hidden) => { await layerEdit(hidden, { visibleToPlayers: true, name: 'Current open name' }); });
      const packet = await waitEvent(mark, watcher, 'scene:layer_updated', layer.id);
      assert.deepEqual([packet.layer.name, packet.layer.version], ['Current open name', layer.version + 2]);
      await quiet(mark, [layer.id], [watcher, playerSocket], new Set(['scene:layer_hidden']));
      assert.equal((await playerObjects()).filter(({ id }) => id === object.id).length, 1);
    });

    await scenario('scene archive after commit stops queued draft publication', async () => {
      const mark = events.length;
      const object = await changeAfterCommit(player, () => create(draftLayer, { scene: draft }), () =>
        request(`/api/scenes/${draft.id}/archive`, 'PUT', owner, { expectedVersion: draft.version }));
      assert.equal((await state(object)).version, 1);
      await quiet(mark, [object.id]);
      assert.deepEqual((await request(`/api/scenes/${draft.id}/objects`, 'GET', owner, undefined, 404)).result, { error: 'NOT_FOUND' });
    });

    await scenario('membership removal after commit stops pending public updates', async () => {
      const object = await setupObject();
      const mark = events.length;
      await changeAfterCommit(player, () => edit(object, { x: 41 }), () => request(memberPath(observer), 'DELETE', owner, undefined, 204));
      await waitEvent(mark, playerSocket, updatedEvent, object.id);
      await quiet(mark, [object.id], [watcher, foreignSocket]);
      await joinMembership(observer);
      watcher.disconnect();
      watcher = await connect(observer, campaign.id, 'PLAYER');
      assert.equal((await playerObjects(active, observer)).find(({ id }) => id === object.id).x, 41);
    });

    await scenario('session expiry during publication drops still-connected recipient', async () => {
      const mark = events.length;
      const [object] = await gated(sessionGate, [cookieHash(observer)], async (pid, start, gate) => {
        const object = await start(() => create());
        assert.ok(await state(object));
        await waitOn([pid], sessionRead);
        await gate.query("UPDATE user_sessions SET expires_at = clock_timestamp() - interval '1 second' WHERE token_hash = $1", [cookieHash(observer)]);
      });
      await waitEvent(mark, playerSocket, createdEvent, object.id);
      await quiet(mark, [object.id], [watcher]);
      assert.deepEqual((await request(`/api/scenes/${active.id}/objects`, 'GET', observer, undefined, 401)).result, { error: 'UNAUTHENTICATED' });
      watcher.disconnect();
    });

    await scenario('logout before queued recipient validation removes all tabs of that session', async () => {
      const [blocker, target] = [gm, player].sort((left, right) => cookieHash(left).localeCompare(cookieHash(right)));
      const removed = target === gm ? [gmSocket, gmSecond] : [playerSocket];
      const mark = events.length;
      const object = await changeAfterCommit(blocker, () => create(), () => request('/api/auth/logout', 'POST', target, undefined, 204));
      await waitEvent(mark, ownerSocket, createdEvent, object.id);
      await quiet(mark, [object.id], removed);
      assert.equal((await query('SELECT user_id FROM user_sessions WHERE token_hash = $1', [cookieHash(target)])).rowCount, 0);
    });

    await scenario('forced rollback commits no edited row, audit or packet', async () => {
      const object = await setupObject();
      const mark = events.length;
      const before = await state(object);
      assert.match(object.id, /^[a-f0-9-]{36}$/u);
      const hook = `delivery_rollback_${randomUUID().replaceAll('-', '')}`;
      await query(`CREATE FUNCTION ${hook}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Intentional failure in isolated realtime test'; END; $$`);
      try {
        await query(`CREATE TRIGGER ${hook} BEFORE INSERT ON audit_events FOR EACH ROW
          WHEN (NEW.action = 'scene.object_updated' AND NEW.target_id = '${object.id}'::uuid) EXECUTE FUNCTION ${hook}()`);
        assert.deepEqual(await edit(object, { x: 444 }, 500), { error: 'INTERNAL_ERROR' });
        assert.deepEqual(await state(object), before);
        assert.equal((await query("SELECT id FROM audit_events WHERE action = 'scene.object_updated' AND target_id = $1", [object.id])).rowCount, 0);
        await quiet(mark, [object.id], sockets, new Set([updatedEvent, deletedEvent]));
      } finally {
        await query(`DROP TRIGGER IF EXISTS ${hook} ON audit_events`);
        await query(`DROP FUNCTION ${hook}()`);
      }
    });
    console.log(`Passed ${passed} secure realtime scenarios against PostgreSQL`);
  }
} finally {
  for (const socket of sockets) socket.disconnect();
  await db.end();
}

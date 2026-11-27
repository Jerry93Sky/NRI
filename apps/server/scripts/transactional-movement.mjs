import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { io } from 'socket.io-client';

const api = new URL(process.env.NRI_API_URL ?? 'http://127.0.0.1:3000');
const database = new URL(process.env.DATABASE_URL);
assert.equal(process.env.NODE_ENV, 'test');
for (const url of [api, database]) assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Use isolated local services');
assert.match(database.pathname, /^\/nri_(?:test|command_test)$/u, 'Use a dedicated movement test database');

const db = new pg.Pool({ connectionString: database.href, query_timeout: 6000 });
const connections = [];
const events = [];
const timeout = 6000;
const password = randomUUID();
const movementEvents = new Set(['token:moved', 'token:updated', 'token:created', 'token:hidden']);
let passed = 0;

async function scenario(name, run) {
  await run();
  console.log(`PASS ${++passed} ${name}`);
}

async function request(path, method, actor, body, status = 200) {
  const response = await fetch(new URL(path, api), {
    method,
    signal: AbortSignal.timeout(timeout + 2000),
    headers: { ...(actor ? { cookie: actor.cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = response.status === 204 ? null : await response.json();
  assert.equal(response.status, status, `${method} ${path} returned ${JSON.stringify(result)}`);
  return { result, cookie: response.headers.getSetCookie().find((entry) => entry.startsWith('nri_session='))?.split(';')[0] };
}

async function register(displayName) {
  const { result, cookie } = await request('/api/auth/register', 'POST', null,
    { email: `${randomUUID()}@nri.local`, displayName, password }, 201);
  assert.ok(cookie);
  return { id: result.user.id, cookie };
}

async function connect(actor, campaignId, role) {
  const socket = io(api.origin, { autoConnect: false, reconnection: false, transports: ['websocket'], extraHeaders: { cookie: actor.cookie } });
  connections.push(socket);
  socket.onAny((name, data) => { if (movementEvents.has(name) || name.startsWith('membership:')) events.push({ socket, name, data }); });
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
    const result = await read();
    if (result) return result;
    await delay(15);
  }
  assert.fail(message);
}

function received(since, socket, name, id) {
  return events.slice(since).find((event) => event.socket === socket && event.name === name &&
    (event.data.id === id || event.data.userId === id))?.data;
}

function waitForEvent(since, socket, name, id) {
  return until(() => received(since, socket, name, id), `${name} was not received for the fixture ${id}`);
}

async function quiet(since, ids, names = movementEvents, sockets = connections) {
  // This bounded observation checks packet absence; PostgreSQL lock graphs order all race tests.
  await delay(120);
  assert.equal(events.slice(since).some(({ socket, name, data }) =>
    sockets.includes(socket) && names.has(name) && ids.includes(data.id)), false, 'Unexpected realtime token event');
}

async function state(id) {
  const { rows } = await db.query('SELECT id, x, y, version, locked, hidden, owner_user_id FROM tokens WHERE id = $1', [id]);
  assert.equal(rows.length, 1);
  return rows[0];
}

async function auditCount(id) {
  const { rows: [row] } = await db.query("SELECT count(*)::int AS count FROM audit_events WHERE target_id = $1 AND action IN ('token.moved', 'token.group_updated')", [id]);
  return row.count;
}

function move(socket, token, x = 47, y = 93) {
  return socket.timeout(timeout).emitWithAck('token:move', { tokenId: token.id, expectedVersion: token.version, x, y });
}

function patch(token, fields = { x: 47, y: 93 }) {
  return { tokenId: token.id, expectedVersion: token.version, patch: fields };
}

async function group(actor, scene, updates, status = 200) {
  return (await request(`/api/scenes/${scene.id}/tokens/group`, 'PATCH', actor, { updates }, status)).result;
}

function waitOn(blockers, queryLike, exclude = []) {
  return until(async () => {
    const { rows } = await db.query(`SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND state = 'active' AND lower(query) LIKE $1
        AND pg_blocking_pids(pid) && $2::int[] AND NOT (pid = ANY($3::int[]))`, [queryLike, blockers, exclude]);
    assert.ok(rows.length < 2, `Ambiguous blockers for ${queryLike}`);
    return rows[0]?.pid;
  }, `No transaction with ${queryLike} waited for PostgreSQL backend(s) ${blockers}`);
}

const tokenLock = '%from "tokens"%for no key update%';
const membershipLock = '%from "campaign_memberships"%for share%';
const campaignLock = '%from "campaigns"%for share%';
const campaignWriteLock = '%from "campaigns"%for update%';

async function gated(query, params, contend) {
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
    const { rows } = await gate.query(query, params);
    assert.equal(rows.length, 1, 'The gate must lock exactly one fixture row');
    await contend(gate.processID, start);
    await gate.query('COMMIT');
    return await Promise.all(pending);
  } finally {
    await gate.query('ROLLBACK').finally(() => gate.release());
    await Promise.allSettled(pending);
  }
}

function writerFirst(gateQuery, params, write, writeSQL, command, commandSQL) {
  return gated(gateQuery, params, async (gatePid, start) => {
    start(write);
    const writer = await waitOn([gatePid], writeSQL);
    start(command);
    await waitOn([gatePid, writer], commandSQL, [writer]);
  });
}

const memberGate = 'SELECT user_id FROM campaign_memberships WHERE campaign_id = $1 AND user_id = $2 FOR UPDATE';
const tokenGate = 'SELECT id FROM tokens WHERE id = $1 FOR UPDATE';
const campaignGate = 'SELECT id FROM campaigns WHERE id = $1 FOR NO KEY UPDATE';

try {
  const owner = await register('Command Owner');
  const gm = await register('Command GM');
  const player = await register('Command Player');
  const other = await register('Command Observer');

  const makeCampaign = async (title) => (await request('/api/campaigns', 'POST', owner, { title }, 201)).result.campaign;
  const makeScene = async (campaign, title) => (await request('/api/scenes', 'POST', owner, { campaignId: campaign.id, title }, 201)).result.scene;
  const campaign = await makeCampaign('Movement regression');
  const foreignCampaign = await makeCampaign('Foreign movement fixtures');
  let active = await makeScene(campaign, 'Active');
  const draft = await makeScene(campaign, 'Draft');
  const foreignScene = await makeScene(foreignCampaign, 'Other campaign');
  const { result: invite } = await request('/api/invitations', 'POST', owner, { campaignId: campaign.id }, 201);
  for (const actor of [gm, player, other]) await request(`/api/invitations/${invite.invitation}/accept`, 'POST', actor);
  const memberPath = (actor) => `/api/campaigns/${campaign.id}/members/${actor.id}`;
  let gmRole;
  const changeRole = async (actor, role) => {
    const result = await request(`${memberPath(actor)}/role`, 'POST', owner, { role });
    if (actor === gm) gmRole = role;
    return result;
  };
  const removed = new Set();
  const remove = async (actor) => {
    const result = await request(memberPath(actor), 'DELETE', owner, undefined, 204);
    removed.add(actor.id);
    return result;
  };
  await changeRole(gm, 'GM');

  const gmSocket = await connect(gm, campaign.id, 'GM');
  const gmSecond = await connect(gm, campaign.id, 'GM');
  let playerSocket = await connect(player, campaign.id, 'PLAYER');
  const playerSecond = await connect(player, campaign.id, 'PLAYER');
  const observer = await connect(other, campaign.id, 'PLAYER');
  const ownerSocket = await connect(owner, campaign.id, 'OWNER');

  function publicSockets() {
    return [ownerSocket, gmSocket, gmSecond, ...(removed.has(player.id) ? [] : [playerSocket, playerSecond]),
      ...(removed.has(other.id) ? [] : [observer])];
  }

  async function waitForSetup(mark, event, token, privateScene = false) {
    const listeners = privateScene || token.hidden
      ? [ownerSocket, ...(gmRole === 'GM' ? [gmSocket, gmSecond] : [])] : publicSockets();
    await Promise.all(listeners.map((socket) => until(() => events.slice(mark).some((packet) =>
      packet.socket === socket && packet.name === event && packet.data.id === token.id && packet.data.version === token.version),
    `${event} was not received for setup token ${token.id} at revision ${token.version}`)));
    return token;
  }

  async function makeToken(name, scene = active, hidden = false) {
    const mark = events.length;
    const token = (await request('/api/tokens', 'POST', owner, { sceneId: scene.id, name, x: 2, y: 3, hidden }, 201)).result.token;
    return scene.id === foreignScene.id ? token : waitForSetup(mark, 'token:created', token, scene.id !== active.id);
  }
  async function assign(token, actor) {
    return (await request(`/api/tokens/${token.id}/owner`, 'POST', owner, { ownerUserId: actor?.id ?? null })).result.token;
  }
  async function edit(token, fields) {
    return (await request(`/api/tokens/${token.id}`, 'PATCH', owner, { expectedVersion: token.version, ...fields })).result.token;
  }
  async function setupAssignment(token, actor) {
    const mark = events.length;
    return waitForSetup(mark, 'token:updated', await assign(token, actor), token.sceneId !== active.id);
  }
  async function setupEdit(token, fields) {
    const mark = events.length;
    return waitForSetup(mark, 'token:updated', await edit(token, fields));
  }
  async function denied(socket, token, error = 'FORBIDDEN', expectedVersion = token.version) {
    const before = await state(token.id);
    const mark = events.length;
    assert.deepEqual(await move(socket, { ...token, version: expectedVersion }), { error });
    assert.deepEqual(await state(token.id), before);
    await quiet(mark, [token.id], new Set(['token:moved']));
  }
  async function moved(socket, listener, token, x, y) {
    const mark = events.length;
    const ack = await move(socket, token, x, y);
    assert.equal(ack.ok, true, JSON.stringify(ack));
    assert.deepEqual([ack.token.x, ack.token.y, ack.token.version], [x, y, token.version + 1]);
    const event = await waitForEvent(mark, listener, 'token:moved', token.id);
    assert.deepEqual([event.x, event.y, event.version], [x, y, token.version + 1]);
    const row = await state(token.id);
    assert.deepEqual([row.x, row.y, row.version], [x, y, token.version + 1]);
    return ack.token;
  }

  let playerToken = await setupAssignment(await makeToken('Owned'), player);
  playerToken = await setupEdit(playerToken, {
    gmNote: 'GM-only fixture note', ownerNote: 'Owner-only fixture note',
    resources: [
      { label: 'Private resource', current: 2, maximum: 5, visible: false },
      { label: 'Public resource', current: 3, maximum: 5, visible: true },
    ],
  });
  const unclaimed = await makeToken('Unclaimed');
  const locked = await setupEdit(await makeToken('Locked'), { locked: true });
  const hidden = await setupAssignment(await makeToken('Hidden', active, true), player);
  const foreign = await makeToken('Foreign', foreignScene);
  const unpublished = await setupAssignment(await makeToken('Draft token', draft), player);

  await scenario('GM can move an unclaimed token and persist a single audit record', async () => {
    await moved(gmSocket, observer, unclaimed, 27, 40);
    assert.equal(await auditCount(unclaimed.id), 1);
  });
  await scenario('owner can move a visible token with a public success projection', async () => {
    playerToken = await moved(playerSocket, observer, playerToken, 39, 20);
    assert.equal(Object.hasOwn(playerToken, 'gmNote'), false);
    assert.equal(Object.hasOwn(playerToken, 'ownerNote'), false);
  });
  await scenario('player cannot move another player’s token', () => denied(observer, playerToken));
  await scenario('GM cannot move a locked token', () => denied(gmSocket, locked));
  await scenario('player receives no projection for hidden token', () => denied(playerSocket, hidden));
  await scenario('single and group movement cannot cross campaigns', async () => {
    await denied(playerSocket, foreign);
    const before = await Promise.all([state(playerToken.id), state(foreign.id)]);
    const mark = events.length;
    assert.deepEqual(await group(owner, active, [patch(playerToken), patch(foreign)], 404), { error: 'NOT_FOUND' });
    assert.deepEqual(await group(gm, foreignScene, [patch(playerToken), patch(foreign)], 404), { error: 'NOT_FOUND' });
    assert.deepEqual(await Promise.all([state(playerToken.id), state(foreign.id)]), before);
    await quiet(mark, [playerToken.id, foreign.id]);
  });
  await scenario('player cannot move a token on a draft scene', () => denied(playerSocket, unpublished));

  let stalePlayerToken;
  let conflict;
  await scenario('two concurrent moves serialize on PostgreSQL and only one version wins', async () => {
    const mark = events.length;
    const auditBefore = await auditCount(playerToken.id);
    stalePlayerToken = playerToken;
    const [winner, loser] = await gated(tokenGate, [playerToken.id], async (pid, start) => {
      start(() => move(playerSocket, playerToken, -12, 24));
      const first = await waitOn([pid], tokenLock);
      start(() => move(playerSecond, playerToken, 51, 85));
      await waitOn([pid, first], tokenLock, [first]);
    });
    assert.equal(winner.ok, true, JSON.stringify(winner));
    assert.equal(loser.error, 'CONFLICT');
    conflict = loser;
    playerToken = winner.token;
    assert.deepEqual([playerToken.x, playerToken.y, playerToken.version], [-12, 24, stalePlayerToken.version + 1]);
    assert.deepEqual(loser.token.version, winner.token.version);
    const row = await state(playerToken.id);
    assert.deepEqual([row.x, row.y, row.version], [-12, 24, playerToken.version]);
    assert.equal(await auditCount(playerToken.id), auditBefore + 1);
    await waitForEvent(mark, observer, 'token:moved', playerToken.id);
    assert.equal(events.slice(mark).filter(({ socket, name, data }) => socket === observer && name === 'token:moved' && data.id === playerToken.id).length, 1);
  });

  const first = await makeToken('Group A');
  const second = await makeToken('Group B');
  async function groupRejected(updates, status, error, targets = [first, second]) {
    const ids = targets.map(({ id }) => id);
    const snapshots = () => Promise.all(ids.map(state));
    const before = await snapshots();
    const mark = events.length;
    assert.deepEqual(await group(gm, active, updates, status), { error });
    assert.deepEqual(await snapshots(), before);
    await quiet(mark, ids);
  }

  await scenario('stale group version rejects the entire batch', () =>
    groupRejected([patch(first), patch({ ...second, version: second.version + 1 })], 409, 'CONFLICT'));
  await scenario('a locked target rejects every position in a group', () =>
    groupRejected([patch(first), patch(locked)], 403, 'FORBIDDEN', [first, locked]));

  await scenario('role demotion queued first prevents REST group mutation', async () => {
    const before = await Promise.all([state(first.id), state(second.id)]);
    const mark = events.length;
    const [, result] = await writerFirst(memberGate, [campaign.id, gm.id], () => changeRole(gm, 'PLAYER'),
      '%from "campaign_memberships"%for update%', () => group(gm, active, [patch(first), patch(second)], 403), campaignLock);
    assert.deepEqual(result, { error: 'FORBIDDEN' });
    assert.deepEqual(await Promise.all([state(first.id), state(second.id)]), before);
    await quiet(mark, [first.id, second.id]);
  });

  await scenario('owner reassignment queued first invalidates the former owner’s move', async () => {
    const token = await setupAssignment(await makeToken('Reassigned'), player);
    const mark = events.length;
    const [updated, ack] = await writerFirst(tokenGate, [token.id], () => assign(token, other), tokenLock,
      () => move(playerSocket, token), tokenLock);
    assert.deepEqual(ack, { error: 'FORBIDDEN' });
    const row = await state(token.id);
    assert.deepEqual([row.x, row.y, row.owner_user_id, row.version], [token.x, token.y, other.id, updated.version]);
    await quiet(mark, [token.id], new Set(['token:moved']));
  });

  await scenario('archiving a scene first suppresses concurrent movement', async () => {
    const token = await setupAssignment(await makeToken('Archived concurrently'), player);
    const mark = events.length;
    const before = await state(token.id);
    const [response, ack] = await writerFirst(campaignGate, [campaign.id],
      () => request(`/api/scenes/${active.id}/archive`, 'PUT', owner, { expectedVersion: active.version }),
      '%from "campaigns"%for no key update%', () => move(playerSocket, token), campaignLock);
    assert.deepEqual(ack, { error: 'FORBIDDEN' });
    assert.ok(response.result.scene.archivedAt);
    assert.deepEqual(await state(token.id), before);
    await quiet(mark, [token.id], new Set(['token:moved']));
    active = (await request(`/api/scenes/${active.id}/restore`, 'PUT', owner, { expectedVersion: response.result.scene.version })).result.scene;
    active = (await request(`/api/scenes/${active.id}/activate`, 'PUT', owner, { expectedVersion: active.version })).result.scene;
  });

  await scenario('locking a token first prevents a concurrent move', async () => {
    const token = await setupAssignment(await makeToken('Locked concurrently'), player);
    const mark = events.length;
    const [updated, ack] = await writerFirst(tokenGate, [token.id], () => edit(token, { locked: true }), tokenLock,
      () => move(playerSocket, token), tokenLock);
    assert.deepEqual(ack, { error: 'FORBIDDEN' });
    const row = await state(token.id);
    assert.deepEqual([row.x, row.y, row.version, row.locked], [token.x, token.y, updated.version, true]);
    await quiet(mark, [token.id], new Set(['token:moved']));
  });

  await scenario('demoted accounts with two open sockets receive no privileged movement', async () => {
    const mark = events.length;
    await moved(ownerSocket, ownerSocket, hidden, 33, 61);
    await quiet(mark, [hidden.id], movementEvents, [gmSocket, gmSecond, playerSocket, playerSecond]);
    await denied(gmSecond, hidden);
  });

  await scenario('reconnect after conflict sees persistent token state and may use the fresh version', async () => {
    playerSocket.disconnect();
    playerSocket = await connect(player, campaign.id, 'PLAYER');
    const { result } = await request(`/api/scenes/${active.id}/tokens`, 'GET', player);
    const snapshot = result.find(({ id }) => id === playerToken.id);
    assert.equal(snapshot.version, conflict.token.version);
    playerToken = await moved(playerSocket, playerSecond, snapshot, 50, 20);
  });

  await scenario('conflict exposes only resources and notes authorized for its actor', async () => {
    assert.equal(Object.hasOwn(conflict.token, 'gmNote'), false);
    assert.equal(conflict.token.ownerNote, 'Owner-only fixture note');
    assert.deepEqual(conflict.token.resources, [null, { label: 'Public resource', current: 3, maximum: 5 }]);
    await denied(observer, { ...playerToken, version: stalePlayerToken.version });
    await denied(playerSocket, { ...hidden, version: 1 });
  });

  await scenario('REST and Socket.IO share version, lock and bounds rules with their existing envelopes', async () => {
    await changeRole(gm, 'GM');
    const mark = events.length;
    const { tokens: batch } = await group(gm, active, [patch({ ...second, id: second.id.toUpperCase() }), patch(first)]);
    assert.deepEqual(batch.map(({ id }) => id), [second.id, first.id]);
    for (const token of batch) {
      const row = await state(token.id);
      assert.deepEqual([row.x, row.y, row.version], [47, 93, token.version]);
      assert.equal(await auditCount(token.id), 1);
      const event = await waitForEvent(mark, observer, 'token:updated', token.id);
      assert.equal(event.version, row.version);
      assert.equal(Object.hasOwn(event, 'gmNote'), false);
      await Promise.all(publicSockets().map((socket) => waitForEvent(mark, socket, 'token:updated', token.id)));
    }
    const stale = await move(gmSocket, { ...first, id: first.id.toUpperCase() });
    assert.equal(stale.error, 'CONFLICT');
    assert.equal(stale.token.version, batch[1].version);
    await groupRejected(batch.map((token) => patch(token, { x: 10001 })), 400, 'INVALID', batch);
    await denied(gmSocket, locked);
    const before = await state(batch[0].id);
    assert.deepEqual(await move(gmSocket, batch[0], 10001, 0), { error: 'INVALID' });
    assert.deepEqual(await state(batch[0].id), before);
    const oversized = Array.from({ length: 51 }, () => patch({ id: randomUUID(), version: 1 }));
    await groupRejected(oversized, 400, 'INVALID', batch);
    await groupRejected([patch(batch[0]), patch({ ...batch[0], id: batch[0].id.toUpperCase() })], 400, 'INVALID', batch);
  });

  await scenario('opposite group input orders share a token lock order and avoid deadlock', async () => {
    const batch = await Promise.all([state(first.id), state(second.id)]);
    const ids = batch.map(({ id }) => id).sort();
    const mark = events.length;
    const [winner, loser] = await gated(tokenGate, [ids[0]], async (pid, start) => {
      start(() => group(gm, active, batch.map((token) => patch(token, { x: 71 }))));
      const actor = await waitOn([pid], tokenLock);
      start(() => group(owner, active, [...batch].reverse().map((token) => patch(token, { x: 72 })), 409));
      await waitOn([pid, actor], tokenLock, [actor]);
    });
    assert.deepEqual(loser, { error: 'CONFLICT' });
    assert.deepEqual(winner.tokens.map(({ id }) => id), batch.map(({ id }) => id));
    for (const token of batch) {
      const row = await state(token.id);
      assert.deepEqual([row.x, row.version], [71, token.version + 1]);
      const event = await waitForEvent(mark, observer, 'token:updated', token.id);
      assert.deepEqual([event.x, event.version], [row.x, row.version]);
    }
  });

  await scenario('membership removal queued first rejects movement on every active connection', async () => {
    const token = await setupAssignment(await makeToken('Removal queued first'), player);
    const mark = events.length;
    const before = await state(token.id);
    const [, ack] = await writerFirst(memberGate, [campaign.id, player.id], () => remove(player),
      'delete from "campaign_memberships"%', () => move(playerSocket, token), campaignLock);
    assert.deepEqual(ack, { error: 'FORBIDDEN' });
    await denied(playerSecond, token);
    assert.deepEqual(await state(token.id), before);
    for (const socket of [playerSocket, playerSecond]) await waitForEvent(mark, socket, 'membership:removed', player.id);
    const next = events.length;
    await moved(gmSocket, observer, token, 60, 60);
    await quiet(next, [token.id], movementEvents, [playerSocket, playerSecond]);
  });

  await scenario('move holding membership commits before concurrent removal and subsequent moves fail', async () => {
    const token = await setupAssignment(await makeToken('Move queued first'), other);
    const mark = events.length;
    const [ack] = await gated(tokenGate, [token.id], async (pid, start) => {
      start(() => move(observer, token));
      const actorPid = await waitOn([pid], tokenLock);
      start(() => remove(other));
      await waitOn([actorPid], campaignWriteLock);
    });
    assert.equal(ack.ok, true, JSON.stringify(ack));
    const row = await state(token.id);
    assert.deepEqual([row.x, row.y, row.version], [47, 93, token.version + 1]);
    await waitForEvent(mark, ownerSocket, 'token:moved', token.id);
    await denied(observer, ack.token);
  });

  await scenario('database rollback after both writes leaves no audit, version change or socket event', async () => {
    const left = await makeToken('Rollback A');
    const right = await makeToken('Rollback B');
    assert.match(right.id, /^[0-9a-f-]{36}$/u);
    const hook = `movement_rollback_${randomUUID().replaceAll('-', '')}`;
    const before = await Promise.all([state(left.id), state(right.id)]);
    const mark = events.length;
    await db.query(`CREATE FUNCTION ${hook}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Intentional failure in isolated movement test'; END; $$`);
    try {
      await db.query(`CREATE TRIGGER ${hook} BEFORE INSERT ON audit_events FOR EACH ROW
        WHEN (NEW.action = 'token.group_updated' AND NEW.target_id = '${right.id}'::uuid) EXECUTE FUNCTION ${hook}()`);
      assert.deepEqual(await group(gm, active, [patch(left), patch(right)], 500), { error: 'INTERNAL_ERROR' });
      assert.deepEqual(await Promise.all([state(left.id), state(right.id)]), before);
      assert.deepEqual(await Promise.all([auditCount(left.id), auditCount(right.id)]), [0, 0]);
      await quiet(mark, [left.id, right.id]);
    } finally {
      await db.query(`DROP TRIGGER IF EXISTS ${hook} ON audit_events`);
      await db.query(`DROP FUNCTION ${hook}()`);
    }
  });

  await scenario('logout queued first invalidates the session used by a concurrent REST movement', async () => {
    const batch = await Promise.all([state(first.id), state(second.id)]);
    const tokenHash = createHash('sha256').update(gm.cookie.split('=')[1]).digest('hex');
    const mark = events.length;
    const [, result] = await writerFirst('SELECT user_id FROM user_sessions WHERE token_hash = $1 FOR UPDATE', [tokenHash],
      () => request('/api/auth/logout', 'POST', gm, undefined, 204), 'delete from "user_sessions"%',
      () => group(gm, active, batch.map((token) => patch(token, { x: 91 })), 401), '%from "user_sessions"%for share%');
    assert.deepEqual(result, { error: 'UNAUTHENTICATED' });
    assert.deepEqual(await Promise.all(batch.map(({ id }) => state(id))), batch);
    await quiet(mark, batch.map(({ id }) => id));
  });
  console.log(`Passed ${passed} transactional movement scenarios against PostgreSQL`);
} finally {
  for (const socket of connections) socket.disconnect();
  await db.end();
}

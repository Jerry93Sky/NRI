import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { io } from 'socket.io-client';

const api = new URL(process.env.NRI_API_URL ?? 'http://127.0.0.1:3000');
const database = new URL(process.env.DATABASE_URL);
assert.equal(process.env.NODE_ENV, 'test');
for (const url of [api, database]) assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Use isolated local services');
assert.match(database.pathname, /^\/nri_(?:test|private_test)$/u, 'Use a dedicated test database');
const db = new pg.Pool({ connectionString: database.href, query_timeout: 6500 });
const timeout = 6500;
const sockets = [];
const events = [];
const eventsOfInterest = new Set(['chat:private', 'chat:message', 'dice:result', 'initiative:updated', 'initiative:gm_updated',
  'token:owner_note', 'token:created', 'token:updated', 'token:hidden', 'scene:pointer', 'scene:updated', 'scene:activated']);
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
  const email = `${randomUUID()}@nri.local`;
  const password = randomUUID();
  const { result, cookie } = await request('/api/auth/register', 'POST', null, { email, displayName, password }, 201);
  assert.ok(cookie);
  return { id: result.user.id, cookie, email, password };
}

async function connect(actor, campaignId, role) {
  const socket = io(api.origin, { autoConnect: false, reconnection: false, transports: ['websocket'], extraHeaders: { cookie: actor.cookie } });
  sockets.push(socket);
  socket.onAny((name, data) => {
    if (eventsOfInterest.has(name)) events.push({ socket, name, id: data.id ?? data.tracker?.id, data });
  });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
    socket.connect();
  });
  if (campaignId) assert.deepEqual(await socket.timeout(timeout).emitWithAck('campaign:join', campaignId), { ok: true, role });
  else assert.deepEqual(await socket.timeout(timeout).emitWithAck('campaign:join', null), { error: 'INVALID' });
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

const cookieHash = (actor) => createHash('sha256').update(actor.cookie.split('=')[1]).digest('hex');
const sessionGate = 'SELECT user_id FROM user_sessions WHERE token_hash = $1 FOR UPDATE';
const sessionRead = '%from "user_sessions"%for share%';
const memberGate = 'SELECT user_id FROM campaign_memberships WHERE campaign_id = $1 AND user_id = $2 FOR UPDATE';
const memberRead = '%from "campaign_memberships"%for share%';
const campaignRead = '%from "campaigns"%for share%';
const privateChat = new Set(['chat:private', 'chat:message']);
const ownerNotes = new Set(['token:owner_note']);
const initiativeEvents = new Set(['initiative:updated', 'initiative:gm_updated']);

try {
  const owner = await register('Private channels Owner');
  const gm = await register('Private channels GM');
  const player = await register('Private channels Player');
  const observer = await register('Private channels Observer');
  const login = async (actor) => ({ ...actor, cookie: (await request('/api/auth/login', 'POST', null,
    { email: actor.email, password: actor.password })).cookie });
  const makeCampaign = async (title) => (await request('/api/campaigns', 'POST', owner, { title }, 201)).result.campaign;
  const campaign = await makeCampaign('Private channels');
  const foreign = await makeCampaign('Separate campaign');
  const cid = campaign.id;
  const path = '/api/campaigns/' + cid;
  let scene = (await request('/api/scenes', 'POST', owner, { campaignId: cid, title: 'Live' }, 201)).result.scene;
  let draftScene;
  const memberPath = (actor) => path + '/members/' + actor.id;
  const join = async (actor, campaignId = cid) => {
    const { result } = await request('/api/invitations', 'POST', owner, { campaignId }, 201);
    await request('/api/invitations/' + result.invitation + '/accept', 'POST', actor);
  };
  const role = (actor, role) => request(memberPath(actor) + '/role', 'POST', owner, { role });
  const remove = (actor) => request(memberPath(actor), 'DELETE', owner, undefined, 204);
  const logout = (actor) => request('/api/auth/logout', 'POST', actor, undefined, 204);
  for (const actor of [gm, player, observer]) await join(actor);
  await join(observer, foreign.id);
  await role(gm, 'GM');
  const own = await connect(owner, cid, 'OWNER');
  const ack = (socket, event, data) => socket.timeout(timeout).emitWithAck(event, event === 'chat:send' ? { ...data, clientMessageId: data.clientMessageId ?? randomUUID() } : event === 'dice:roll' ? { ...data, requestId: data.requestId ?? randomUUID() } : data);
  const send = (socket, body, recipientId, campaignId = cid) => ack(socket, 'chat:send', { campaignId, body, recipientId });
  const roll = (socket, expression, hidden = true, campaignId = cid) => ack(socket, 'dice:roll', { campaignId, expression, hidden });
  if (process.argv.includes('--profile')) {
    const { runProfile } = await import('./private-channels-profile.mjs');
    const playerWire = await connect(player, cid, 'PLAYER');
    await runProfile({ query, owner, player, own, playerWire, scene, cid, connect, send, roll });
  } else {
    let master = await connect(gm, cid, 'GM');
    const masterTab = await connect(gm, cid, 'GM');
    const observerWire = await connect(observer, cid, 'PLAYER');
    const foreignWire = await connect(observer, foreign.id, 'PLAYER');
    let p = await connect(player, cid, 'PLAYER');
    let pTab = await connect(player, cid, 'PLAYER');
    const pSeparate = await login(player);
    const pPersonal = await connect(pSeparate); // A current member with the app open elsewhere.
    const history = async (actor, status = 200) => (await request(path + '/messages', 'GET', actor, undefined, status)).result;
    const loggedChat = async (body) => (await query('SELECT id FROM chat_messages WHERE campaign_id = $1 AND body = $2', [cid, body])).rows[0];
    const loggedRoll = async (expression) => (await query('SELECT id, hidden, detail FROM dice_rolls WHERE campaign_id = $1 AND expression = $2', [cid, expression])).rows[0];
    const forbidden = { error: 'FORBIDDEN' };
    const rejoinPlayer = async () => {
      await join(player);
      p.disconnect();
      pTab.disconnect();
      p = await connect(player, cid, 'PLAYER');
      pTab = await connect(player, cid, 'PLAYER');
    };

    await scenario('active pointers reach the current campaign audience and drafts stay manager-only', async () => {
      const draft = (await request('/api/scenes', 'POST', owner, { campaignId: cid, title: 'Private draft' }, 201)).result.scene;
      draftScene = draft;
      const mark = events.length;
      assert.deepEqual(await ack(own, 'scene:pointer', { campaignId: cid, sceneId: scene.id, x: 12, y: 24 }), { ok: true });
      assert.deepEqual(await ack(own, 'scene:pointer', { campaignId: cid, sceneId: scene.id, x: 13, y: 24 }), { error: 'RATE_LIMITED' });
      await until(() => events.slice(mark).find((event) => event.socket === p && event.name === 'scene:pointer')?.data, 'Active pointer did not reach player');
      assert.equal(events.slice(mark).some((event) => event.socket === foreignWire && event.name === 'scene:pointer'), false);
      await delay(60);
      const draftMark = events.length;
      assert.deepEqual(await ack(own, 'scene:pointer', { campaignId: cid, sceneId: draft.id, x: 12, y: 24 }), { ok: true });
      await until(() => events.slice(draftMark).find((event) => event.socket === master && event.name === 'scene:pointer')?.data, 'Draft pointer did not reach GM');
      await delay(120);
      assert.equal(events.slice(draftMark).some((event) => [p, pTab, observerWire].includes(event.socket) && event.name === 'scene:pointer'), false);
      assert.deepEqual(await ack(p, 'scene:pointer', { campaignId: cid, sceneId: draft.id, x: 12, y: 24 }), forbidden);
      assert.deepEqual(await ack(own, 'scene:pointer', { campaignId: foreign.id, sceneId: scene.id, x: 12, y: 24 }), forbidden);
      assert.deepEqual(await ack(own, 'scene:pointer', { campaignId: cid, sceneId: scene.id, x: 9000, y: 24 }), { error: 'INVALID' });
      await remove(player);
      assert.deepEqual(await ack(p, 'scene:pointer', { campaignId: cid, sceneId: scene.id, x: 16, y: 20 }), forbidden);
      await rejoinPlayer();
    });

    await scenario('a PostgreSQL role change ordered ahead of pointer publication suppresses the stale GM packet', async () => {
      await delay(60);
      const mark = events.length;
      const [, reply] = await writerFirst(memberGate, [cid, gm.id], () => role(gm, 'PLAYER'), '%from "campaign_memberships"%for update%',
        () => ack(own, 'scene:pointer', { campaignId: cid, sceneId: draftScene.id, x: 33, y: 44 }), campaignRead);
      assert.deepEqual(reply, { ok: true });
      await delay(120);
      assert.equal(events.slice(mark).some((event) => event.socket === master && event.name === 'scene:pointer'), false);
      await role(gm, 'GM');
    });

    await scenario('scene update sends only the current active projection to authorized campaign members', async () => {
      const mark = events.length;
      const updated = (await request('/api/scenes/' + scene.id, 'PATCH', owner, { title: 'Live current', expectedVersion: scene.version })).result.scene;
      scene = updated;
      const packet = await until(() => events.slice(mark).find((event) => event.socket === p && event.name === 'scene:updated')?.data, 'Scene update did not reach player');
      assert.equal(packet.scene.id, scene.id);
      assert.equal(packet.scene.title, 'Live current');
      assert.equal(packet.scene.version, updated.version);
      assert.equal(events.slice(mark).some((event) => event.socket === foreignWire && event.name === 'scene:updated'), false);
    });

    await scenario('a PostgreSQL member deletion ordered before scene publication excludes the stale socket', async () => {
      const mark = events.length;
      await gated(memberGate, [cid, player.id], async (pid, start, gate) => {
        start(() => request('/api/scenes/' + scene.id, 'PATCH', owner, { title: 'Current after removal', expectedVersion: scene.version }));
        await waitOn([pid], memberRead);
        await gate.query('DELETE FROM campaign_memberships WHERE campaign_id = $1 AND user_id = $2', [cid, player.id]);
      });
      const [{ version }] = (await query('SELECT version FROM scenes WHERE id = $1', [scene.id])).rows;
      scene = { ...scene, version };
      await delay(120);
      assert.equal(events.slice(mark).some((event) => [p, pTab].includes(event.socket) && event.name === 'scene:updated'), false);
      await rejoinPlayer();
    });

    await scenario('a superseding scene version committed before publication drops the older scene packet', async () => {
      const mark = events.length;
      await gated('SELECT user_id FROM campaign_memberships WHERE campaign_id = $1 AND user_id = $2 FOR UPDATE', [cid, player.id], async (_pid, start) => {
        start(() => request('/api/scenes/' + scene.id, 'PATCH', owner, { title: 'Superseded scene update', expectedVersion: scene.version }));
        await until(async () => (await query('SELECT version FROM scenes WHERE id = $1', [scene.id])).rows[0]?.version === scene.version + 1,
          'First scene update did not commit');
        start(() => request('/api/scenes/' + scene.id, 'PATCH', owner, { title: 'Newest scene update', expectedVersion: scene.version + 1 }));
        await until(async () => (await query('SELECT version FROM scenes WHERE id = $1', [scene.id])).rows[0]?.version === scene.version + 2,
          'Second scene update did not supersede the first');
      });
      const [{ version, title }] = (await query('SELECT version, title FROM scenes WHERE id = $1', [scene.id])).rows;
      scene = { ...scene, version, title };
      const packet = await until(() => events.slice(mark).find((event) => event.name === 'scene:updated' && event.data.scene.id === scene.id)?.data,
        'Newest scene invalidation was not published');
      assert.equal(packet.scene.version, scene.version);
      assert.equal(packet.scene.title, 'Newest scene update');
      await delay(120);
      assert.deepEqual([...new Set(events.slice(mark).filter((event) => event.name === 'scene:updated' && event.data.scene.id === scene.id)
        .map((event) => event.data.scene.version))], [scene.version]);
    });

    await scenario('activation events carry only the current scene pointer and stale manager roles cannot publish drafts', async () => {
      const draft = (await request('/api/scenes', 'POST', owner, { campaignId: cid, title: 'Next scene' }, 201)).result.scene;
      const mark = events.length;
      const active = (await request('/api/scenes/' + draft.id + '/activate', 'PUT', owner, { expectedVersion: draft.version })).result.scene;
      const packet = await until(() => events.slice(mark).find((event) => event.socket === p && event.name === 'scene:activated')?.data, 'Activation event did not reach player');
      assert.deepEqual(Object.keys(packet).sort(), ['campaignId', 'sceneId']);
      assert.equal(packet.sceneId, active.id);
      const currentScene = (await request(path + '/scenes', 'GET', owner)).result.find(({ id }) => id === scene.id);
      scene = (await request('/api/scenes/' + scene.id + '/activate', 'PUT', owner, { expectedVersion: currentScene.version })).result.scene;
      await role(gm, 'PLAYER');
      await delay(60);
      assert.deepEqual(await ack(master, 'scene:pointer', { campaignId: cid, sceneId: draft.id, x: 12, y: 24 }), forbidden);
      await role(gm, 'GM');
    });

    // PostgreSQL confirms the write is visible to a separate connection before the audience query is released.
    async function afterCommit(blocker, command, committed, change) {
      let saved;
      const [outcome] = await gated(sessionGate, [cookieHash(blocker)], async (pid, start, gate) => {
        start(command);
        saved = await until(committed, 'Committed command did not become visible');
        await waitOn([pid], sessionRead);
        await change(saved, gate);
      });
      return [outcome, saved];
    }

    let firstMessage;
    await scenario('private chat reaches only its participants across tabs and independent sessions', async () => {
      const mark = events.length;
      const response = await send(own, 'Participant-only fixture', player.id);
      assert.equal(response.ok, true);
      firstMessage = response.message;
      for (const socket of [own, p, pTab, pPersonal]) {
        assert.equal((await waitEvent(mark, socket, 'chat:private', firstMessage.id)).body, firstMessage.body);
      }
      await quiet(mark, [firstMessage.id], [master, masterTab, observerWire, foreignWire], privateChat);
      assert.equal((await loggedChat(firstMessage.body)).id, firstMessage.id);
      for (const actor of [gm, observer]) assert.equal((await history(actor)).some(({ id }) => id === firstMessage.id), false);
      assert.deepEqual(await send(p, 'Blocked player target', observer.id), forbidden);
      assert.deepEqual(await send(foreignWire, 'Foreign campaign write', player.id), forbidden);
      assert.deepEqual(await send(own, 'x'.repeat(2001), player.id), { error: 'INVALID' });
      assert.equal(await loggedChat('Blocked player target'), undefined);
      const reply = await send(p, 'Player to GM fixture', gm.id);
      assert.equal(reply.ok, true);
      await waitEvent(mark, master, 'chat:private', reply.message.id);
      const publicMessage = await send(own, 'Public fixture');
      await waitEvent(mark, observerWire, 'chat:message', publicMessage.message.id);
      await quiet(mark, [publicMessage.message.id], [foreignWire, pPersonal], privateChat);
    });

    await scenario('revocation before the write rejects both sender and recipient changes', async () => {
      for (const [sender, target, body] of [[own, player.id, 'Recipient before append'],
        [null, owner.id, 'Sender before append']]) {
        const [, response] = await writerFirst(memberGate, [cid, player.id], () => remove(player), '%delete from "campaign_memberships"%',
          () => send(sender ?? p, body, target), campaignRead);
        assert.deepEqual(response, forbidden);
        assert.equal(await loggedChat(body), undefined);
        assert.deepEqual(await history(player, 404), { error: 'NOT_FOUND' });
        await rejoinPlayer();
      }
    });

    await scenario('committed private chat excludes a removed recipient while preserving participant history', async () => {
      const mark = events.length;
      const body = 'Recipient removed after append';
      const [reply, saved] = await afterCommit(player, () => send(own, body, player.id), () => loggedChat(body), () => remove(player));
      assert.equal(reply.message.id, saved.id);
      await waitEvent(mark, own, 'chat:private', saved.id);
      await quiet(mark, [saved.id], [p, pTab, pPersonal, observerWire, master, foreignWire], privateChat);
      assert.equal((await history(owner)).some(({ id }) => id === saved.id), true);
      await history(player, 404);
      await rejoinPlayer();
      const restored = await history(player);
      assert.ok(restored.some(({ id }) => id === saved.id));
      assert.ok(restored.some(({ id }) => id === firstMessage.id));
      const nextMark = events.length;
      const replyAfterJoin = await send(p, 'History and subscription restored', owner.id);
      await waitEvent(nextMark, own, 'chat:private', replyAfterJoin.message.id);
    });

    await scenario('logout and expiry isolate individual chat sessions of the same participant', async () => {
      const sessions = [[player, [p, pTab]], [pSeparate, [pPersonal]]].sort(([a], [b]) => cookieHash(a).localeCompare(cookieHash(b)));
      const [[blocker, valid], [removed, revoked]] = sessions;
      const mark = events.length;
      const body = 'One recipient session logged out';
      const [, saved] = await afterCommit(blocker, () => send(own, body, player.id), () => loggedChat(body), () => logout(removed));
      for (const socket of valid) await waitEvent(mark, socket, 'chat:private', saved.id);
      await quiet(mark, [saved.id], revoked, privateChat);
      await history(removed, 401);
      const expiryActor = await login(player);
      const expiredWire = await connect(expiryActor);
      const expiredMark = events.length;
      const expiredBody = 'Expired recipient session';
      const [, expired] = await afterCommit(expiryActor, () => send(own, expiredBody, player.id), () => loggedChat(expiredBody),
        (_row, gate) => gate.query("UPDATE user_sessions SET expires_at = clock_timestamp() - interval '1 second' WHERE token_hash = $1", [cookieHash(expiryActor)]));
      await waitEvent(expiredMark, own, 'chat:private', expired.id);
      await quiet(expiredMark, [expired.id], [expiredWire], privateChat);
      await history(expiryActor, 401);
      expiredWire.disconnect();
      const fresh = await login(player);
      p.disconnect();
      pTab.disconnect();
      Object.assign(player, fresh);
      p = await connect(player, cid, 'PLAYER');
      pTab = await connect(player, cid, 'PLAYER');
    });

    await scenario('hidden dice are persisted unchanged and never appear in public chat or foreign sockets', async () => {
      const mark = events.length;
      assert.deepEqual(await roll(p, '3d20+13'), forbidden);
      assert.equal(await loggedRoll('3d20+13'), undefined);
      const secret = await roll(master, '2d20+17');
      assert.equal(secret.ok, true);
      const stored = await loggedRoll('2d20+17');
      assert.equal(stored.hidden, true);
      assert.deepEqual(JSON.parse(stored.detail), { rolls: secret.roll.rolls, modifier: 17 });
      for (const socket of [own, master, masterTab]) await waitEvent(mark, socket, 'dice:result', stored.id);
      await quiet(mark, [stored.id], [p, pTab, pPersonal, observerWire, foreignWire]);
      assert.equal(JSON.stringify(await history(player)).includes(stored.id), false);
      assert.equal(JSON.stringify(await history(gm)).includes(stored.id), false);
      const visible = await roll(p, '1d12+18', false);
      assert.equal(visible.ok, true);
      await waitEvent(mark, observerWire, 'dice:result', visible.roll.id);
      await quiet(mark, [visible.roll.id], [foreignWire]);
    });

    await scenario('demotion after hidden roll commit filters both tabs, including the initiating acknowledgement', async () => {
      const mark = events.length;
      const expression = '1d8+19';
      const [reply, saved] = await afterCommit(observer, () => roll(master, expression), () => loggedRoll(expression), () => role(gm, 'PLAYER'));
      assert.deepEqual(reply, forbidden);
      await waitEvent(mark, own, 'dice:result', saved.id);
      await quiet(mark, [saved.id], [master, masterTab, p, pTab, observerWire, foreignWire]);
      await role(gm, 'GM');
    });

    await scenario('hidden dice exclude revoked members and independently logged-out GM sessions', async () => {
      const other = await login(gm);
      const otherWire = await connect(other, cid, 'GM');
      const [blocker, removed] = [gm, other].sort((a, b) => cookieHash(a).localeCompare(cookieHash(b)));
      const mark = events.length;
      const expression = '1d8+20';
      const [, saved] = await afterCommit(blocker, () => roll(own, expression), () => loggedRoll(expression), () => logout(removed));
      await waitEvent(mark, own, 'dice:result', saved.id);
      await quiet(mark, [saved.id], removed === gm ? [master, masterTab] : [otherWire]);
      const expiryMark = events.length;
      const expiredExpression = '1d8+22';
      const [, expired] = await afterCommit(blocker, () => roll(own, expiredExpression), () => loggedRoll(expiredExpression),
        (_row, gate) => gate.query("UPDATE user_sessions SET expires_at = clock_timestamp() - interval '1 second' WHERE token_hash = $1", [cookieHash(blocker)]));
      await waitEvent(expiryMark, own, 'dice:result', expired.id);
      await quiet(expiryMark, [expired.id], blocker === gm ? [master, masterTab] : [otherWire]);
      Object.assign(gm, await login(gm));
      master = await connect(gm, cid, 'GM');
      const next = '1d8+21';
      const nextMark = events.length;
      const [, removedRoll] = await afterCommit(observer, () => roll(own, next), () => loggedRoll(next), () => remove(gm));
      await waitEvent(nextMark, own, 'dice:result', removedRoll.id);
      await quiet(nextMark, [removedRoll.id], [master, masterTab, otherWire]);
      await join(gm);
      await role(gm, 'GM');
      master = await connect(gm, cid, 'GM');
    });

    const trackerDb = async () => (await query('SELECT id, scene_id, active, version FROM initiative_trackers WHERE campaign_id = $1', [cid])).rows[0];
    const initiative = async (actor, status = 200) => (await request(path + '/initiative', 'GET', actor, undefined, status)).result;
    const command = async (action, body, status = 200, actor = owner) =>
      (await request(path + '/initiative/' + action, 'POST', actor, body, status)).result;
    const createToken = async (name) => (await request('/api/tokens', 'POST', owner, { sceneId: scene.id, name, x: 1, y: 1 }, 201)).result.token;
    const edit = async (token, patch) => (await request('/api/tokens/' + token.id, 'PATCH', owner, { expectedVersion: token.version, ...patch })).result.token;
    const tokenState = async (id) => (await query('SELECT version, owner_note, owner_user_id FROM tokens WHERE id = $1', [id])).rows[0];
    const assign = async (token, user) => (await request('/api/tokens/' + token.id + '/owner', 'POST', owner, { ownerUserId: user.id })).result.token;
    const snapshotToken = async (actor, id) => (await request('/api/scenes/' + scene.id + '/tokens', 'GET', actor)).result.find((token) => token.id === id);
    const token = await createToken('Linked initiative token');
    const entries = [{ tokenId: null, label: 'Closed turn fixture', score: 25, hidden: true },
      { tokenId: token.id, label: 'Visible turn fixture', score: 15 }];
    const startBody = { sceneId: scene.id, entries };
    const withVersion = (view) => ({ expectedVersion: view.tracker.version });
    const waitView = (mark, socket, name, version) => until(() => events.slice(mark).find((event) =>
      event.socket === socket && event.name === name && event.data.tracker.version === version)?.data,
    name + ' revision ' + version + ' was not delivered');
    let turn;
    let visibleToken = token;

    await scenario('initiative start and round changes expose a coherent projection without hidden IDs', async () => {
      const mark = events.length;
      turn = await command('start', startBody);
      const version = turn.tracker.version;
      const snapshot = await waitView(mark, p, 'initiative:updated', version);
      assert.equal(snapshot.entries.length, 1);
      assert.equal(snapshot.tracker.currentEntryId, null);
      assert.equal(JSON.stringify(snapshot).includes(turn.entries[0].id), false);
      assert.equal(JSON.stringify(snapshot).includes(entries[0].label), false);
      assert.deepEqual(await initiative(player), { tracker: snapshot.tracker, entries: snapshot.entries });
      assert.deepEqual((await waitView(mark, master, 'initiative:gm_updated', version)).entries, turn.entries);
      await quiet(mark, [turn.tracker.id], [foreignWire], initiativeEvents);
      const visible = await command('advance', withVersion(turn));
      assert.equal((await initiative(player)).tracker.currentEntryId, visible.entries[1].id);
      turn = await command('advance', withVersion(visible));
      assert.equal(turn.tracker.round, 2);
      await waitView(mark, p, 'initiative:updated', turn.tracker.version);
    });

    await scenario('initiative conflicts and a superseded publication converge on the newest revision', async () => {
      const mark = events.length;
      const old = turn.tracker.version;
      await afterCommit(observer, () => command('advance', withVersion(turn)), async () => {
        const row = await trackerDb();
        return row.version === old + 1 && row;
      }, async () => {
        assert.deepEqual(await command('advance', { expectedVersion: old }, 409), { error: 'CONFLICT' });
        turn = await command('advance', { expectedVersion: old + 1 });
      });
      await waitView(mark, p, 'initiative:updated', turn.tracker.version);
      await delay(120);
      assert.equal(events.slice(mark).some(({ name, data }) => initiativeEvents.has(name) && data.tracker.version === old + 1), false);
    });

    await scenario('token hiding refreshes initiative at the same revision without leaking the linked entry', async () => {
      const mark = events.length;
      visibleToken = await edit(visibleToken, { hidden: true });
      await waitView(mark, p, 'initiative:updated', turn.tracker.version);
      assert.deepEqual((await initiative(player)).entries, []);
      assert.equal((await initiative(player)).tracker.currentEntryId, null);
      assert.equal((await initiative(gm)).entries.length, 2);
      const reveal = events.length;
      visibleToken = await edit(visibleToken, { hidden: false });
      const revision = turn.tracker.version;
      await Promise.all([p, pTab, observerWire, master, own].map((socket) => waitView(reveal, socket, 'initiative:updated', revision)));
      assert.equal((await initiative(player)).entries.some(({ tokenId }) => tokenId === token.id), true);
    });

    await scenario('initiative demotion and removal after commit exclude private projections and snapshots', async () => {
      const mark = events.length;
      const old = turn.tracker.version;
      [turn] = await afterCommit(observer, () => command('advance', { expectedVersion: old }), async () => {
        const row = await trackerDb();
        return row.version === old + 1 && row;
      }, async () => {
        await role(gm, 'PLAYER');
        await remove(player);
      });
      assert.equal((await waitView(mark, master, 'initiative:updated', turn.tracker.version)).entries.length, 1);
      await quiet(mark, [turn.tracker.id], [p, pTab], initiativeEvents);
      await quiet(mark, [turn.tracker.id], [master], new Set(['initiative:gm_updated']));
      assert.equal((await initiative(gm)).entries.length, 1);
      await initiative(player, 404);
      await rejoinPlayer();
      await role(gm, 'GM');
      const stopped = await command('stop', withVersion(turn));
      assert.equal(stopped.tracker.active, false);
      assert.equal((await initiative(player)).tracker.version, stopped.tracker.version);
      await waitView(mark, own, 'initiative:gm_updated', stopped.tracker.version);
    });

    let noteToken;
    await scenario('owner notes reach current owner tabs and remain absent from other Player projections', async () => {
      noteToken = await createToken('Notes fixture');
      const mark = events.length;
      noteToken = await assign(noteToken, player);
      for (const socket of [p, pTab]) await waitEvent(mark, socket, 'token:owner_note', noteToken.id);
      const audienceMark = events.length;
      noteToken = await edit(noteToken, { ownerNote: 'Original current owner note', gmNote: 'Separate GM note' });
      for (const socket of [p, pTab]) {
        const packet = await waitEvent(audienceMark, socket, 'token:owner_note', noteToken.id);
        assert.equal(packet.ownerNote, noteToken.ownerNote);
        assert.equal(Object.hasOwn(packet, 'gmNote'), false);
      }
      await quiet(mark, [noteToken.id], [observerWire, foreignWire], ownerNotes);
      assert.equal((await snapshotToken(player, noteToken.id)).ownerNote, noteToken.ownerNote);
      assert.equal(Object.hasOwn(await snapshotToken(observer, noteToken.id), 'ownerNote'), false);
    });

    await scenario('reassignment after commit drops the old private packet across former owner tabs', async () => {
      const mark = events.length;
      const old = noteToken;
      const [, saved] = await afterCommit(player, () => edit(old, { ownerNote: 'Transfer boundary note' }), async () => {
        const row = await tokenState(old.id);
        return row.version === old.version + 1 && row;
      }, async () => { noteToken = await assign(old, observer); });
      assert.equal(saved.owner_note, 'Transfer boundary note');
      assert.equal((await waitEvent(mark, observerWire, 'token:owner_note', old.id)).ownerNote, saved.owner_note);
      const update = await waitEvent(mark, p, 'token:updated', old.id);
      assert.equal(update.ownerUserId, observer.id);
      assert.equal(Object.hasOwn(update, 'ownerNote'), false);
      await quiet(mark, [old.id], [p, pTab, foreignWire], ownerNotes);
      assert.equal(Object.hasOwn(await snapshotToken(player, old.id), 'ownerNote'), false);
      assert.equal((await snapshotToken(observer, old.id)).ownerNote, saved.owner_note);
    });

    await scenario('superseded, hidden and revoked owner notes never reach the stale audience', async () => {
      const afterEdit = (old, text, change) => afterCommit(observer, () => edit(old, { ownerNote: text }), async () => {
        const row = await tokenState(old.id);
        return row.version === old.version + 1 && row;
      }, change);
      let mark = events.length;
      const old = noteToken;
      await afterEdit(old, 'Superseded owner note', async () => {
        noteToken = await edit({ ...old, version: old.version + 1 }, { ownerNote: 'Latest owner note' });
      });
      assert.equal((await waitEvent(mark, observerWire, 'token:owner_note', old.id)).ownerNote, 'Latest owner note');
      await delay(120);
      assert.deepEqual(events.slice(mark).filter((event) => event.socket === observerWire && event.name === 'token:owner_note' && event.id === old.id)
        .map(({ data }) => data.ownerNote), ['Latest owner note']);
      mark = events.length;
      const visible = noteToken;
      await afterEdit(visible, 'Hidden boundary note', async () => {
        noteToken = await edit({ ...visible, version: visible.version + 1 }, { hidden: true });
      });
      await waitEvent(mark, observerWire, 'token:hidden', old.id);
      await quiet(mark, [old.id], [observerWire, p, pTab, foreignWire], ownerNotes);
      assert.equal(await snapshotToken(observer, old.id), undefined);
      const revealMark = events.length;
      noteToken = await edit(noteToken, { hidden: false });
      await waitEvent(revealMark, observerWire, 'token:owner_note', old.id);
      mark = events.length;
      const revealed = noteToken;
      await afterEdit(revealed, 'Removed owner note', () => remove(observer));
      await quiet(mark, [old.id], [observerWire, p, pTab, foreignWire], ownerNotes);
      await request('/api/scenes/' + scene.id + '/tokens', 'GET', observer, undefined, 404);
      await join(observer);
      await connect(observer, cid, 'PLAYER');
    });

    await scenario('archiving the live scene suppresses a pending initiative projection and reconnect returns an empty snapshot', async () => {
      turn = await command('start', startBody);
      await waitView(0, p, 'initiative:updated', turn.tracker.version);
      const mark = events.length;
      const old = turn.tracker.version;
      await afterCommit(player, () => command('advance', { expectedVersion: old }), async () => {
        const row = await trackerDb();
        return row.version === old + 1 && row;
      }, () => request('/api/scenes/' + scene.id + '/archive', 'PUT', owner, { expectedVersion: scene.version }));
      const snapshot = await waitView(mark, p, 'initiative:updated', old + 2);
      assert.deepEqual(snapshot.entries, []);
      assert.equal(snapshot.tracker.active, false);
      assert.equal(snapshot.tracker.currentEntryId, null);
      assert.equal((await trackerDb()).scene_id, null);
      await delay(60);
      assert.deepEqual(await ack(own, 'scene:pointer', { campaignId: cid, sceneId: scene.id, x: 16, y: 20 }), forbidden);
      assert.equal(events.slice(mark).some(({ name, data }) => initiativeEvents.has(name) && data.tracker.version === old + 1), false);
      const fresh = await login(player);
      await connect(fresh, cid, 'PLAYER');
      assert.deepEqual(await initiative(fresh), { tracker: snapshot.tracker, entries: [] });
    });

    console.log('Private channel regressions passed: ' + passed);
  }
} finally {
  for (const socket of sockets) socket.disconnect();
  await db.end();
}

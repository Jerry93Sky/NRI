import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { io } from 'socket.io-client';

const origin = new URL(process.env.NRI_OPS_ORIGIN);
assert.equal(origin.protocol, 'https:');
assert.equal(origin.hostname, '127.0.0.1');
assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0', 'HTTPS verification must remain enabled');
const file = process.env.NRI_OPS_FIXTURE;
assert.ok(file, 'Use a private output file in the ignored acceptance folder');
const sockets = [];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function request(path, { method = 'GET', actor, data, expected = 200, headers = {}, binary = false } = {}) {
  const form = data instanceof FormData;
  const response = await fetch(new URL(path, origin), {
    method, signal: AbortSignal.timeout(12_000), redirect: 'error',
    headers: { origin: origin.origin, ...(actor ? { cookie: actor.cookie } : {}),
      ...(data !== undefined && !form ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(data === undefined ? {} : { body: form ? data : JSON.stringify(data) }),
  });
  assert.ok([expected].flat().includes(response.status), `${method} ${path.split('/').at(-1)} returned HTTP ${response.status}`);
  const cookie = response.headers.getSetCookie().find((entry) => entry.startsWith('nri_session='));
  if (cookie) for (const option of ['Secure', 'HttpOnly', 'SameSite=Lax']) assert.match(cookie, new RegExp(`(?:^|; )${option}(?:;|$)`, 'i'));
  let body = null;
  if (response.status !== 204) {
    if (binary) body = await response.arrayBuffer();
    else body = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
  }
  return { status: response.status, body, cookie: cookie?.split(';')[0] };
}

async function register(displayName) {
  const login = { email: `${randomUUID()}@ops.example.test`, password: randomUUID() };
  const registration = await request('/api/auth/register', { method: 'POST', data: { ...login, displayName }, expected: 201 });
  assert.ok(registration.cookie);
  return { id: registration.body.user.id, cookie: registration.cookie, login };
}

const command = (actor, path, data, expected = 200, headers) => request(path, { method: 'POST', actor, data, expected, headers });

async function socketFor(actor) {
  const socket = io(origin.origin, { autoConnect: false, reconnection: false, transports: ['websocket'],
    extraHeaders: { cookie: actor.cookie, origin: origin.origin }, timeout: 6000 });
  sockets.push(socket);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
    socket.connect();
  });
  assert.equal(socket.io.engine.transport.name, 'websocket');
  return socket;
}

async function join(socket, campaignId, role) {
  assert.deepEqual(await socket.timeout(6500).emitWithAck('campaign:join', campaignId), { ok: true, role });
}

async function readiness(expected) {
  const started = performance.now();
  const expires = started + 45_000;
  do {
    const status = await fetch(new URL('/api/ready', origin), { signal: AbortSignal.timeout(6000) }).then((r) => r.status, () => 0);
    if (status === expected) return Math.round(performance.now() - started);
    await delay(250);
  } while (performance.now() < expires);
  assert.fail(`Readiness did not reach HTTP ${expected}`);
}

function docker(args) {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: 65_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function isolatedContainer(service) {
  const name = process.env[`NRI_OPS_${service.toUpperCase()}_CONTAINER`];
  assert.match(name ?? '', new RegExp(`^nri-acceptance-[a-z0-9-]+-${service}-1$`));
  const label = docker(['inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}/{{index .Config.Labels "com.docker.compose.service"}}', name]);
  assert.equal(label, `${name.slice(0, -(`${service}-1`.length + 1))}/${service}`);
  return name;
}

async function verify(state) {
  const { gm, player, campaignId, sceneId, hiddenSceneId, assetId, token, hiddenToken, objectId, chat, roll, receipt } = state;
  const check = (path, actor, expected = 200) => request(path, { actor, expected }).then(({ body }) => body);
  const scenes = `/api/campaigns/${campaignId}/scenes`;
  assert.ok((await check(scenes, gm)).some(({ id }) => id === hiddenSceneId));
  assert.ok(!(await check(scenes, player)).some(({ id }) => id === hiddenSceneId));
  const tokens = `/api/scenes/${sceneId}/tokens`;
  const gmToken = (await check(tokens, gm)).find(({ id }) => id === token.id);
  const playerToken = (await check(tokens, player)).find(({ id }) => id === token.id);
  assert.equal(gmToken.gmNote, token.gmNote);
  assert.equal(playerToken.version, token.version);
  assert.ok(!JSON.stringify(playerToken).includes(token.gmNote));
  assert.ok(!(await check(tokens, player)).some(({ id }) => id === hiddenToken));
  assert.ok((await check(`/api/scenes/${sceneId}/objects`, player)).some(({ id }) => id === objectId));
  await check(`/api/scenes/${hiddenSceneId}/tokens`, player, 404);
  const assetPath = `/api/assets/${assetId}`;
  await request(assetPath, { expected: [401, 404] });
  assert.equal(digest(Buffer.from((await request(assetPath, { actor: player, binary: true })).body)), state.original);
  assert.equal(digest(Buffer.from((await request(`${assetPath}?variant=thumbnail`, { actor: player, binary: true })).body)), state.thumbnail);
  const initiative = `/api/campaigns/${campaignId}/initiative`;
  const gmInitiative = await check(initiative, gm);
  const playerInitiative = await check(initiative, player);
  assert.equal(gmInitiative.tracker.version, state.initiativeVersion);
  assert.equal(playerInitiative.tracker.active, true);
  assert.equal(playerInitiative.entries.length, 1);
  const messages = `/api/campaigns/${campaignId}/messages`;
  const gmMessages = await check(messages, gm);
  assert.ok(gmMessages.some(({ id }) => id === chat.id));
  assert.ok(!(await check(messages, player)).some(({ id }) => id === chat.id));
  const socket = await socketFor(gm);
  await join(socket, campaignId, 'OWNER');
  const recovered = await socket.timeout(6500).emitWithAck('dice:roll', state.rollCommand);
  assert.equal(recovered.roll?.id, roll.id);
  socket.disconnect();
  assert.equal((await command(gm, '/api/tokens', receipt.payload, 200, receipt.headers)).body.token.id, token.id);
}

async function exercise() {
  await readiness(200);
  const gm = await register('Acceptance Guide');
  const player = await register('Acceptance Player');
  const removed = await register('Acceptance Revoked');
  const { cookie } = await command(undefined, '/api/auth/login', gm.login);
  assert.ok(cookie && cookie !== gm.cookie);
  const separateLogin = { cookie };
  await command(separateLogin, '/api/auth/logout', undefined, 204);
  await request('/api/auth/me', { actor: separateLogin, expected: 401 });
  await request('/api/auth/me', { actor: gm, headers: { origin: 'https://wrong-origin.example.test' }, expected: 403 });
  await request('/api/metrics', { expected: 404 });

  const { body: { campaign } } = await command(gm, '/api/campaigns', { title: 'Isolated OPS acceptance', description: '' }, 201);
  const root = `/api/campaigns/${campaign.id}`;
  for (const actor of [player, removed]) {
    const { body: { invitation } } = await command(gm, '/api/invitations', { campaignId: campaign.id }, 201);
    await command(actor, `/api/invitations/${encodeURIComponent(invitation)}/accept`);
  }
  const { body: { scene } } = await command(gm, '/api/scenes', { campaignId: campaign.id, title: 'Acceptance live table' }, 201);
  const { body: { scene: draft } } = await command(gm, '/api/scenes', { campaignId: campaign.id, title: 'Acceptance GM draft' }, 201);
  const upload = new FormData();
  upload.append('files', new Blob([png], { type: 'image/png' }), 'acceptance-token.png');
  const { body: { assets: [asset] } } = await command(gm, `${root}/assets?category=TOKEN`, upload, 201);
  const receipt = { payload: { sceneId: scene.id, name: 'Visible scout', x: 4, y: 6, imageAssetId: asset.id }, headers: { 'idempotency-key': randomUUID() } };
  const { body: { token: created } } = await command(gm, '/api/tokens', receipt.payload, 201, receipt.headers);
  const { body: { token } } = await request(`/api/tokens/${created.id}`, { actor: gm, method: 'PATCH', data: { gmNote: 'Synthetic private scout note', expectedVersion: created.version } });
  const { body: { token: hidden } } = await command(gm, '/api/tokens', { sceneId: scene.id, name: 'Hidden scout', hidden: true, x: 8, y: 7 }, 201);
  const { body: layers } = await request(`/api/scenes/${scene.id}/layers`, { actor: gm });
  const { body: { object } } = await command(gm, `/api/scenes/${scene.id}/objects`, { layerId: layers.find(({ kind }) => kind === 'OBJECTS').id, kind: 'RECTANGLE', x: 150, y: 160 }, 201);
  const original = digest(png);
  const thumbnail = digest(Buffer.from((await request(`/api/assets/${asset.id}?variant=thumbnail`, { actor: gm, binary: true })).body));
  const initiated = await command(gm, `${root}/initiative/start`, { sceneId: scene.id,
    entries: [{ tokenId: token.id, label: 'Scout', score: 7 }, { tokenId: hidden.id, label: 'Hidden scout', score: 11 }] });
  const guide = await socketFor(gm);
  await join(guide, campaign.id, 'OWNER');
  const participant = await socketFor(player);
  await join(participant, campaign.id, 'PLAYER');
  assert.equal((await guide.timeout(6500).emitWithAck('chat:send', { campaignId: campaign.id, clientMessageId: randomUUID(), body: 'Public status' })).ok, true);
  const chat = await guide.timeout(6500).emitWithAck('chat:send', { campaignId: campaign.id, clientMessageId: randomUUID(), recipientId: removed.id, body: 'Private initial note' });
  const rollCommand = { campaignId: campaign.id, requestId: randomUUID(), expression: '1d20', hidden: true };
  const roll = await guide.timeout(6500).emitWithAck('dice:roll', rollCommand);
  assert.ok(chat.message?.id && roll.roll?.id);
  const state = { gm, player, campaignId: campaign.id, sceneId: scene.id, hiddenSceneId: draft.id, assetId: asset.id,
    token, hiddenToken: hidden.id, objectId: object.id, chat: chat.message, roll: roll.roll, rollCommand, receipt, original, thumbnail,
    initiativeVersion: initiated.body.tracker.version };
  await verify(state);
  console.info('PASS trusted HTTPS, session cookies and logout, origin validation, protected assets and WSS');

  const db = isolatedContainer('db');
  const api = isolatedContainer('api');
  const apiStartedAt = docker(['inspect', '--format', '{{.State.StartedAt}}', api]);
  const interrupted = { ...receipt.payload, name: 'Outage probe token' };
  const key = { 'idempotency-key': randomUUID() };
  try {
    docker(['stop', '--time', '10', db]);
    const downMs = await readiness(503);
    await request('/api/health');
    const blocked = await command(gm, '/api/tokens', interrupted, [500, 503], key);
    assert.deepEqual(blocked.body, { error: 'INTERNAL_ERROR' });
    const read = await request(`/api/scenes/${scene.id}/tokens`, { actor: player, expected: [500, 503] });
    assert.deepEqual(read.body, { error: 'INTERNAL_ERROR' });
    await assert.rejects(socketFor(player), { message: 'UNAUTHENTICATED' });
    console.info(`PASS database outage blocks protected writes/reads and reconnect, and makes readiness unavailable in ${downMs} ms`);
  } finally { docker(['start', db]); }
  const databaseRecoveryMs = await readiness(200);
  assert.equal(docker(['inspect', '--format', '{{.State.StartedAt}}', api]), apiStartedAt);
  const retried = await command(gm, '/api/tokens', interrupted, 201, key);
  assert.equal((await command(gm, '/api/tokens', interrupted, 200, key)).body.token.id, retried.body.token.id);
  assert.equal((await request(`/api/scenes/${scene.id}/tokens`, { actor: gm })).body.filter(({ name }) => name === interrupted.name).length, 1);

  const revoked = await socketFor(removed);
  await join(revoked, campaign.id, 'PLAYER');
  revoked.disconnect();
  await request(`${root}/members/${removed.id}`, { method: 'DELETE', actor: gm, expected: 204 });
  const afterRevocation = await socketFor(removed);
  const denied = await afterRevocation.timeout(6500).emitWithAck('campaign:join', campaign.id);
  assert.deepEqual(denied, { error: 'FORBIDDEN' });
  await request(`${root}/scenes`, { actor: removed, expected: 403 });
  participant.disconnect();
  await delay(800);
  await join(await socketFor(player), campaign.id, 'PLAYER');
  const started = performance.now();
  // Blocking this client process intentionally leaves its WebSockets unresponsive during stop.
  docker(['stop', '--timeout', '25', api]);
  assert.equal(docker(['inspect', '--format', '{{.State.ExitCode}}', api]), '0', 'API should exit before Docker forces termination');
  const shutdownMs = Math.round(performance.now() - started);
  docker(['start', api]);
  await readiness(200);
  const apiRecoveryMs = Math.round(performance.now() - started);
  await join(await socketFor(player), campaign.id, 'PLAYER');
  await verify(state);
  await writeFile(file, `${JSON.stringify(state)}\n`, { flag: 'wx', mode: 0o600 });
  console.info(`PASS database recovery without API restart (${databaseRecoveryMs} ms after DB start), WSS rejoin, revocation, SIGTERM with unresponsive peers (${shutdownMs} ms) and API restart (${apiRecoveryMs} ms)`);
}

try {
  if (process.argv[2] === 'verify-restore') {
    const state = JSON.parse(await readFile(file, 'utf8'));
    await readiness(200);
    await verify(state);
    console.info('PASS restored GM/Player visibility, versions, chat, initiative, hidden dice replay, token receipt and both asset hashes');
  } else {
    assert.equal(process.argv.length, 2);
    await exercise();
  }
} finally { for (const socket of sockets) socket.disconnect(); }

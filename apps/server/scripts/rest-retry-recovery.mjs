import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import sharp from 'sharp';
import { io } from 'socket.io-client';

const api = new URL(process.env.NRI_API_URL);
const database = new URL(process.env.DATABASE_URL);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.NRI_ENABLE_TEST_FAULTS, 'true');
assert.equal(database.pathname, '/nri_retry_test');
for (const url of [api, database]) assert.equal(url.hostname, '127.0.0.1');
const uploadDir = process.env.UPLOAD_DIR;
assert.ok(uploadDir, 'Provide an isolated upload directory');
const db = new pg.Pool({ connectionString: database.href, query_timeout: 10_000 });
const sockets = [];
const suffix = randomUUID().slice(0, 8);

async function request(path, { method = 'POST', actor, key, body, headers, expected = 200 } = {}) {
  const started = performance.now();
  const form = body instanceof FormData;
  const response = await fetch(new URL(path, api), {
    method, signal: AbortSignal.timeout(10_000),
    headers: {
      ...(actor ? { cookie: actor.cookie } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
      ...(body !== undefined && !form ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined || form ? body : JSON.stringify(body),
  });
  const result = response.status === 204 ? null : await response.json();
  assert.ok([expected].flat().includes(response.status), `${method} ${path}: HTTP ${response.status} ${JSON.stringify(result)}`);
  return { result, status: response.status, headers: response.headers, ms: performance.now() - started };
}

async function register(name) {
  const response = await request('/api/auth/register', { expected: 201, body: {
    email: `${name.toLowerCase()}-${suffix}@example.test`, password: randomUUID(), displayName: name,
  } });
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith('nri_session='))?.split(';')[0];
  assert.ok(cookie);
  return { id: response.result.user.id, cookie };
}

async function assertAudits(ids, action) {
  const { rows } = await db.query('SELECT target_id, count(*)::int AS n FROM audit_events WHERE target_id = ANY($1::uuid[]) AND action = $2 GROUP BY target_id', [ids, action]);
  assert.equal(rows.length, ids.length);
  assert.ok(rows.every(({ n }) => n === 1), `Exactly one ${action} audit per result`);
}

async function verifyReplay({ actor, path, payload, select, action, replayStatus = 200, makeBody = () => payload, rounds = 1 }) {
  const initial = [];
  const replay = [];
  const concurrent = [];
  let result;
  for (let index = 0; index < rounds; index++) {
    const key = randomUUID();
    const send = (expected) => request(path, { actor, key, body: makeBody(), expected });
    const first = await send(201);
    initial.push(first.ms);
    result = select((await send(replayStatus)).result);
    replay.push((await send(replayStatus)).ms);
    const collisionKey = randomUUID();
    const collision = () => request(path, { actor, key: collisionKey, body: makeBody(), expected: [201, replayStatus] });
    const started = performance.now();
    const both = await Promise.all([collision(), collision()]);
    concurrent.push(performance.now() - started);
    assert.deepEqual(result, select(first.result), action);
    assert.deepEqual(select(both[0].result), select(both[1].result), action);
    assert.notDeepEqual(result, select(both[0].result), 'Different keys represent different operations');
    if (replayStatus !== 201) assert.deepEqual(both.map((response) => response.status).sort(), [200, 201]);
    await assertAudits([...result, ...select(both[0].result)], action);
  }
  const profile = (samples) => {
    const sorted = [...samples].sort((a, b) => a - b);
    return { n: sorted.length, p50Ms: Number(sorted[Math.ceil(sorted.length * .5) - 1].toFixed(2)), p95Ms: Number(sorted[Math.ceil(sorted.length * .95) - 1].toFixed(2)) };
  };
  console.log(`PASS ${action} ${JSON.stringify({ initial: profile(initial), replay: profile(replay), sameKeyPair: profile(concurrent) })}`);
  return result;
}

function upload(bytes, filename = 'retry.png') {
  const data = new FormData();
  data.append('file', new Blob([bytes], { type: 'image/png' }), filename);
  return data;
}

try {
  const owner = await register('RetryOwner');
  const collaborator = await register('RetryCollaborator');
  const campaignBody = { title: `Scoped retry ${suffix}`, description: '' };
  const [campaignId] = await verifyReplay({ actor: owner, path: '/api/campaigns', payload: campaignBody, select: (row) => [row.campaign.id], action: 'campaign.created', rounds: 5 });
  const scenePath = '/api/scenes';
  const sceneBody = { campaignId, title: 'Retry scene' };
  const [sceneId] = await verifyReplay({ actor: owner, path: scenePath, payload: sceneBody, select: (row) => [row.scene.id], action: 'scene.created', rounds: 5 });
  const tokenBody = { sceneId, name: 'Retry token', x: 3, y: 4, color: '#c8794a' };
  const tokenPath = '/api/tokens';
  const tokensForCopy = [];
  for (const name of ['Source one', 'Source two']) {
    const { result } = await request(tokenPath, { actor: owner, body: { ...tokenBody, name }, expected: 201 });
    tokensForCopy.push(result.token);
  }
  await verifyReplay({ actor: owner, path: tokenPath, payload: tokenBody, select: (row) => [row.token.id], action: 'token.created', rounds: 5 });
  const source = tokensForCopy[0];
  const copyPath = `/api/tokens/${source.id}/duplicate`;
  const copyBody = { sceneId, expectedVersion: source.version, x: 7, y: 8 };
  await verifyReplay({ actor: owner, path: copyPath, payload: copyBody, select: (row) => [row.token.id], action: 'token.duplicated', rounds: 5 });
  await verifyReplay({ actor: owner, path: `/api/scenes/${sceneId}/tokens/duplicate`, payload: {
    sceneId, tokens: tokensForCopy.map((token) => ({ tokenId: token.id, expectedVersion: token.version, x: 8, y: 9 })),
  }, select: (row) => row.tokens.map(({ id }) => id), action: 'token.duplicated', rounds: 5 });

  const { rows: [layer] } = await db.query("SELECT id FROM scene_layers WHERE scene_id=$1 AND kind='OBJECTS'", [sceneId]);
  const objectPath = `/api/scenes/${sceneId}/objects`;
  const objectBody = { layerId: layer.id, kind: 'RECTANGLE', x: 100, y: 110, color: '#c8794a' };
  await verifyReplay({ actor: owner, path: objectPath, payload: objectBody, select: (row) => [row.object.id], action: 'scene.object_created', rounds: 5 });
  const objectSources = [];
  for (let index = 0; index < 2; index++) {
    const { result } = await request(objectPath, { actor: owner, body: { ...objectBody, x: 100 + index }, expected: 201 });
    objectSources.push({ objectId: result.object.id, expectedVersion: result.object.version, x: 130, y: 120 });
  }
  for (const objects of [objectSources.slice(0, 1), objectSources]) {
    await verifyReplay({ actor: owner, path: `${objectPath}/duplicate`, payload: { layerId: layer.id, objects },
      select: (row) => row.objects.map(({ id }) => id), action: 'scene.object_duplicated', rounds: 5 });
  }
  await verifyReplay({ actor: owner, path: `/api/scenes/${sceneId}/duplicate`, select: (row) => [row.scene.id], action: 'scene.duplicated', rounds: 5 });

  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#c8794a' } }).png().toBuffer();
  const otherPng = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#668d7b' } }).png().toBuffer();
  const assetPath = `/api/campaigns/${campaignId}/assets?category=TOKEN`;
  await verifyReplay({ actor: owner, path: assetPath, makeBody: () => upload(png), select: (row) => row.assets.map(({ id }) => id),
    action: 'asset.uploaded', replayStatus: 201, rounds: 5 });
  await verifyReplay({ actor: owner, path: `/api/campaigns/${campaignId}/duplicate`, select: (row) => [row.campaign.id], action: 'campaign.duplicated', rounds: 5 });

  const assetKey = randomUUID();
  const assetSend = (expected, bytes = png, headers) => request(assetPath, { actor: owner, key: assetKey, body: upload(bytes), expected, headers });
  const filesBefore = new Set(await readdir(uploadDir));
  const rolledBackAt = performance.now();
  await assetSend(500, png, { 'x-nri-test-asset-fault': 'after-original-rename' });
  assert.deepEqual(new Set(await readdir(uploadDir)), filesBefore);
  const asset = (await assetSend(201)).result.asset;
  const rollbackAndRetryMs = performance.now() - rolledBackAt;
  assert.equal((await assetSend(201)).result.asset.id, asset.id);
  assert.equal((await assetSend(409, otherPng)).result.error, 'CONFLICT');
  const filesAfter = (await readdir(uploadDir)).filter((file) => !filesBefore.has(file));
  assert.equal(filesAfter.length, 2, 'One original and one thumbnail, no dangling stages');
  assert.ok(filesAfter.every((file) => !file.endsWith('.pending')));
  await assertAudits([asset.id], 'asset.uploaded');
  console.log(`PASS asset file compensation/content conflict, rollback+retry ${rollbackAndRetryMs.toFixed(2)}ms (n=1), fixture ${png.byteLength} bytes`);

  const campaignKey = randomUUID();
  const scopedCampaign = (actor, body, expected) => request('/api/campaigns', { actor, key: campaignKey, body, expected });
  const ownerCampaign = (await scopedCampaign(owner, campaignBody, 201)).result.campaign.id;
  const otherCampaign = (await scopedCampaign(collaborator, campaignBody, 201)).result.campaign.id;
  assert.notEqual(ownerCampaign, otherCampaign);
  assert.equal((await scopedCampaign(owner, { ...campaignBody, description: 'changed' }, 409)).result.error, 'CONFLICT');
  const scopeKey = randomUUID();
  const firstScene = (await request(scenePath, { actor: owner, key: scopeKey, body: sceneBody, expected: 201 })).result.scene.id;
  assert.notEqual((await request(scenePath, { actor: owner, key: scopeKey, body: { ...sceneBody, campaignId: ownerCampaign }, expected: 201 })).result.scene.id, firstScene);
  const scopedToken = (actor, key, expected, body = tokenBody) => request(tokenPath, { actor, key, expected, body });
  const revokedKey = randomUUID();
  const { result: invitation } = await request('/api/invitations', { actor: owner, body: { campaignId }, expected: 201 });
  await request(`/api/invitations/${invitation.invitation}/accept`, { actor: collaborator });
  const member = `/api/campaigns/${campaignId}/members/${collaborator.id}`;
  await request(`${member}/role`, { actor: owner, body: { role: 'GM' } });
  const collaboratorToken = (await scopedToken(collaborator, revokedKey, 201)).result.token.id;
  assert.notEqual((await scopedToken(owner, revokedKey, 201)).result.token.id, collaboratorToken);
  const { result: { token: healthToken } } = await request(`/api/tokens/${source.id}`, { actor: owner, method: 'PATCH',
    body: { expectedVersion: source.version, resources: [{ label: 'HP', maximum: 20, current: 15, visible: true },
      { label: 'Focus', maximum: 0, current: 0, visible: false }] } });
  const competingAdjustment = (actor) => request(`/api/tokens/${source.id}/resources/adjust`, { actor, expected: [200, 409],
    body: { expectedVersion: healthToken.version, resourceIndex: 0, delta: -1 } });
  const adjustments = await Promise.all([competingAdjustment(owner), competingAdjustment(collaborator)]);
  assert.deepEqual(adjustments.map(({ status }) => status).sort(), [200, 409]);
  assert.equal((await db.query('SELECT resources FROM tokens WHERE id=$1', [source.id])).rows[0].resources[0].current, 14);
  await assertAudits([source.id], 'token.resource_adjusted');
  console.log('PASS competing resource adjustments from two accounts apply one version');
  await request(`${member}/role`, { actor: owner, body: { role: 'PLAYER' } });
  await scopedToken(collaborator, revokedKey, 403);
  await request(member, { method: 'DELETE', actor: owner, expected: 204 });
  await scopedToken(collaborator, revokedKey, 403);

  const activeScene = (await db.query('SELECT id FROM scenes WHERE campaign_id=$1 AND is_active', [campaignId])).rows[0].id;
  const socket = io(api.origin, { autoConnect: false, reconnection: false, transports: ['websocket'], extraHeaders: { cookie: owner.cookie } });
  sockets.push(socket);
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
  assert.equal((await socket.timeout(5000).emitWithAck('campaign:join', campaignId)).ok, true);
  const publications = [];
  socket.on('token:created', (token) => publications.push(token.id));
  const tokenKey = randomUUID();
  const activeTokenBody = { ...tokenBody, sceneId: activeScene };
  const created = (await scopedToken(owner, tokenKey, 201, activeTokenBody)).result.token;
  assert.equal((await scopedToken(owner, tokenKey, 200, activeTokenBody)).result.token.id, created.id);
  const until = Date.now() + 3000;
  while (!publications.includes(created.id) && Date.now() < until) await delay(10);
  await delay(150);
  assert.equal(publications.filter((id) => id === created.id).length, 1);
  await request(`/api/tokens/${created.id}`, { method: 'DELETE', actor: owner, body: { expectedVersion: created.version }, expected: [200, 204] });
  assert.equal((await scopedToken(owner, tokenKey, 409, activeTokenBody)).result.error, 'RESULT_UNAVAILABLE');
  await db.query("UPDATE rest_operation_receipts SET created_at=now()-interval '91 days', expires_at=now() WHERE actor_id=$1 AND request_id=$2", [owner.id, tokenKey]);
  assert.notEqual((await scopedToken(owner, tokenKey, 201, activeTokenBody)).result.token.id, created.id);
  console.log('PASS actor and campaign scopes, payload conflict, demotion and revocation, single publish, deleted result, expiration');
} finally {
  for (const socket of sockets) socket.disconnect();
  await db.end();
}

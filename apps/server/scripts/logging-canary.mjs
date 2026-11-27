import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rename, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { io } from 'socket.io-client';

const database = new URL(process.env.DATABASE_URL);
assert.equal(database.pathname, '/nri_sec_ops_test');
assert.equal(database.hostname, '127.0.0.1');
const port = Number(process.env.NRI_CANARY_PORT ?? 3007);
assert.ok(Number.isInteger(port) && port > 1024 && port < 65536);
const api = new URL(`http://127.0.0.1:${port}`);
const values = new Map();
function canary(label, value = `canary-${label}-${randomUUID()}`) { values.set(label, value); return value; }
const dir = await mkdtemp(join(tmpdir(), 'nri-log-check-'));
const media = join(dir, canary('filesystem-path'));
const password = canary('password');
const db = new pg.Pool({ connectionString: database.href });
const child = spawn(process.execPath, ['dist/index.js'], {
  env: { ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), LOG_LEVEL: 'debug',
    WEB_ORIGIN: api.origin, SESSION_SECRET: canary('environment'), UPLOAD_DIR: media },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const exited = new Promise((resolve) => child.once('close', resolve));
let spawnFailed = false;
child.once('error', () => { spawnFailed = true; });
let log = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { log += chunk.toString(); });
const sockets = [];
const startingCookieCanary = canary('cookie-header');
const authorization = canary('authorization-header');
const correlation = canary('request-id-header');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

async function request(path, method, expected, body, cookie, extra = {}) {
  const form = body instanceof FormData;
  const response = await fetch(new URL(path, api), { method, signal: AbortSignal.timeout(5000), headers: {
    cookie: cookie ?? `canary=${startingCookieCanary}`, authorization: `Bearer ${authorization}`, 'request-id': correlation,
    ...(body && !form ? { 'content-type': 'application/json' } : {}), ...extra,
  }, body: body === undefined || form ? body : JSON.stringify(body) });
  assert.equal(response.status, expected, `${method} expected ${expected}, HTTP ${response.status}`);
  return { data: response.status === 204 ? null : await response.json(), cookie: response.headers.getSetCookie()[0]?.split(';')[0] };
}

async function register(label) {
  const credentials = { email: canary(`${label}-email`, `${randomUUID()}@example.invalid`), password };
  const { data, cookie } = await request('/api/auth/register', 'POST', 201, { ...credentials, displayName: label });
  canary(`${label}-session`, cookie.split('=')[1]);
  return { ...credentials, cookie, id: data.user.id };
}

async function connect(cookie, campaignId) {
  const socket = io(api.origin, { autoConnect: false, reconnection: false, transports: ['websocket'], extraHeaders: { cookie } });
  sockets.push(socket);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', () => reject(new Error('Canary Socket.IO handshake failed')));
    socket.connect();
  });
  assert.equal((await socket.timeout(5000).emitWithAck('campaign:join', campaignId)).ok, true);
  return socket;
}

try {
  let ready = false;
  for (let i = 0; i < 50 && !spawnFailed && child.exitCode === null; i++) {
    try { ready = (await fetch(new URL('/api/ready', api), { signal: AbortSignal.timeout(500) })).ok; } catch {}
    if (ready) break;
    await delay(100);
  }
  assert.ok(ready, 'The isolated log-canary API must start');
  const owner = await register('CanaryOwner');
  const player = await register('CanaryPlayer');
  await request('/api/auth/login', 'POST', 401, { email: owner.email, password: canary('wrong-password') });
  const login = await request('/api/auth/login', 'POST', 200, { email: owner.email, password });
  canary('login-session', login.cookie.split('=')[1]);
  await request('/api/auth/logout', 'POST', 204, undefined, login.cookie);
  const { data: { campaign } } = await request('/api/campaigns', 'POST', 201, { title: 'Log canary', description: '' }, owner.cookie);
  const databaseDetail = canary('database-detail');
  await db.query(`CREATE FUNCTION nri_canary_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action = 'campaign.created' THEN RAISE unique_violation USING MESSAGE = '${databaseDetail}'; END IF; RETURN NEW; END $$`);
  try {
    await db.query('CREATE TRIGGER nri_canary_audit_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION nri_canary_audit_failure()');
    await request('/api/campaigns', 'POST', 500, { title: canary('database-payload'), description: '' }, owner.cookie);
  } finally {
    await db.query('DROP TRIGGER IF EXISTS nri_canary_audit_failure ON audit_events');
    await db.query('DROP FUNCTION nri_canary_audit_failure()');
  }
  const { data } = await request('/api/invitations', 'POST', 201, { campaignId: campaign.id }, owner.cookie);
  await request(`/api/invitations/${encodeURIComponent(canary('invitation', data.invitation))}/accept`, 'POST', 200, undefined, player.cookie);
  const { data: { scene } } = await request('/api/scenes', 'POST', 201, { campaignId: campaign.id, title: 'Active scene' }, owner.cookie);
  const { data: { scene: privateScene } } = await request('/api/scenes', 'POST', 201, { campaignId: campaign.id, title: canary('private-scene') }, owner.cookie);
  await request(`/api/scenes/${canary('private-scene-id', privateScene.id)}/tokens`, 'GET', 404, undefined, player.cookie);
  const a = await connect(owner.cookie, campaign.id);
  const b = await connect(player.cookie, campaign.id);
  for (const recipientId of [null, player.id]) {
    const body = canary(recipientId ? 'private-chat' : 'public-chat') + ' "é"';
    const command = { campaignId: campaign.id, clientMessageId: randomUUID(), recipientId, body };
    const first = await a.timeout(5000).emitWithAck('chat:send', command);
    assert.equal(first.ok, true);
    assert.equal((await a.timeout(5000).emitWithAck('chat:send', command)).message.id, first.message.id);
    assert.equal((await a.timeout(5000).emitWithAck('chat:send', { ...command, body: canary('conflicting-message') })).error, 'CONFLICT');
  }
  for (const hidden of [false, true]) {
    const roll = await a.timeout(5000).emitWithAck('dice:roll', { campaignId: campaign.id, requestId: randomUUID(), expression: '1d20', hidden });
    assert.equal(roll.ok, true);
    if (hidden) canary('hidden-roll-id', roll.roll.id);
  }
  const { data: { token } } = await request('/api/tokens', 'POST', 201, { sceneId: scene.id, name: 'Canary token', x: 2, y: 3 }, owner.cookie);
  await request(`/api/tokens/${token.id}`, 'PATCH', 200, { expectedVersion: token.version, gmNote: canary('gm-note'), ownerNote: canary('owner-note') }, owner.cookie);
  await request(`/api/tokens/${token.id}/owner`, 'POST', 200, { ownerUserId: player.id }, owner.cookie);
  await request(`/api/tokens?private=${encodeURIComponent(canary('invalid-query') + '+"é')}`, 'POST', 400, { gmNote: canary('invalid-payload') }, owner.cookie);
  const assetPath = `/api/campaigns/${campaign.id}/assets`;
  const form = (bytes) => {
    const body = new FormData();
    body.append('file', new Blob([bytes], { type: 'image/png' }), `${canary('filename')}.png`);
    return body;
  };
  await request(assetPath, 'POST', 415, form(Buffer.from(canary('invalid-image'))), owner.cookie);
  await request(assetPath, 'POST', 500, form(png), owner.cookie, { 'x-nri-test-asset-fault': 'after-original-rename' });
  const { data: { asset } } = await request(assetPath, 'POST', 201, form(png), owner.cookie);
  canary('asset-id', asset.id);
  const { rows: [assetRow] } = await db.query('SELECT storage_key FROM assets WHERE id=$1', [asset.id]);
  canary('storage-key', assetRow.storage_key);
  const filename = join(media, assetRow.storage_key);
  assert.equal(resolve(filename), filename);
  await rename(filename, filename + '.probe');
  await mkdir(filename);
  await request(`/api/assets/${asset.id}`, 'DELETE', 204, undefined, owner.cookie);
  const member = `/api/campaigns/${campaign.id}/members/${player.id}/role`;
  await request(member, 'POST', 200, { role: 'GM' }, owner.cookie);
  await request(member, 'POST', 200, { role: 'PLAYER' }, owner.cookie);
  assert.equal((await b.timeout(5000).emitWithAck('dice:roll', { campaignId: campaign.id, requestId: randomUUID(), expression: '1d20', hidden: true })).error, 'FORBIDDEN');
  await delay(100);
} finally {
  for (const socket of sockets) socket.disconnect();
  child.kill('SIGTERM');
  await exited;
  await db.end();
  const root = resolve(tmpdir());
  assert.ok(resolve(dir).startsWith(join(root, 'nri-log-check-')));
  await rm(dir, { recursive: true, force: true });
}

for (const [label, plain] of values) {
  for (const encoded of new Set([plain, encodeURIComponent(plain), JSON.stringify(plain).slice(1, -1)])) {
    assert.ok(!log.includes(encoded), `Sensitive value reached application logs: ${label}`);
  }
}
for (const marker of ['reqId', '/api/invitations/:token/accept', 'statusCode', 'elapsedMs', 'Request failed', 'DATABASE_CONSTRAINT', 'Deleted asset file cleanup failed']) {
  assert.ok(log.includes(marker), `Expected safe log diagnostic: ${marker}`);
}
console.log(`PASS checked ${values.size} synthetic values against stdout/stderr; retained request and failure diagnostics`);

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { io } from 'socket.io-client';

const base = new URL(process.env.NRI_API_URL ?? 'http://127.0.0.1:3000');
const database = new URL(process.env.DATABASE_URL);
assert.equal(process.env.NODE_ENV, 'test');
for (const url of [base, database]) assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
assert.match(database.pathname, /^\/nri_(?:test|geometry_test)$/);
const db = new pg.Pool({ connectionString: database.href, query_timeout: 7000 });
const sockets = [];
const marker = randomUUID();
const password = randomUUID();
const wall = { kind: 'WALL', doorState: null, visibility: 'STANDARD', blocksMovement: true, blocksVision: true,
  start: { x: 130.12345, y: 120 }, end: { x: 550, y: 120 } };
const secret = { ...wall, kind: 'DOOR', visibility: 'SECRET', doorState: 'LOCKED' };
let passed = 0;

async function scenario(name, run) {
  await run();
  console.log(`PASS ${++passed} ${name}`);
}

async function request(actor, path, method = 'GET', data, allowed = 200, key) {
  const response = await fetch(new URL(path, base), { method, signal: AbortSignal.timeout(9000),
    headers: { ...(actor ? { cookie: actor.cookie } : {}), ...(data ? { 'content-type': 'application/json' } : {}),
      ...(key ? { 'idempotency-key': key } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  assert.ok([allowed].flat().includes(response.status), `${method} ${path} returned ${response.status}`);
  return { status: response.status, result: response.status === 204 ? null : await response.json(),
    cookie: response.headers.getSetCookie().find((value) => value.startsWith('nri_session='))?.split(';')[0],
    cacheControl: response.headers.get('cache-control') };
}

async function register(name) {
  const { result, cookie } = await request(null, '/api/auth/register', 'POST',
    { email: `${randomUUID()}@example.test`, displayName: name, password }, 201);
  assert.ok(cookie);
  return { id: result.user.id, cookie };
}

async function connect(actor, campaignId, role) {
  const socket = io(base.origin, { autoConnect: false, timeout: 5000, reconnection: false, transports: ['websocket'],
    extraHeaders: { cookie: actor.cookie } });
  const packets = [];
  sockets.push(socket);
  socket.on('geometry:changed', (packet) => packets.push(packet));
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
  assert.deepEqual(await socket.timeout(5000).emitWithAck('campaign:join', campaignId), { ok: true, role });
  return { socket, packets };
}

async function until(condition) {
  const deadline = Date.now() + 5000;
  while (!condition() && Date.now() < deadline) await delay(15);
  assert.ok(condition(), 'Expected committed geometry invalidation');
}

try {
  const owner = await register('Geometry Owner');
  const gm = await register('Geometry GM');
  const player = await register('Geometry Player');
  const stranger = await register('Geometry Stranger');
  const { result: { campaign } } = await request(owner, '/api/campaigns', 'POST', { title: `Geometry ${marker}`, description: '' }, 201);
  const { result: { campaign: otherCampaign } } = await request(stranger, '/api/campaigns', 'POST', { title: `Other ${marker}`, description: '' }, 201);
  await db.query('INSERT INTO campaign_memberships (campaign_id, user_id, role) VALUES ($1, $2, $3), ($1, $4, $5)',
    [campaign.id, gm.id, 'GM', player.id, 'PLAYER']);
  const createScene = async (actor, campaignId, title) =>
    (await request(actor, '/api/scenes', 'POST', { campaignId, title }, 201)).result.scene;
  const scene = await createScene(owner, campaign.id, 'Geometry source');
  const second = await createScene(owner, campaign.id, 'Empty scene');
  const other = await createScene(stranger, otherCampaign.id, 'Other campaign scene');
  const path = `/api/scenes/${scene.id}/geometry`;
  const view = async (actor = owner, id = scene.id) => (await request(actor, `/api/scenes/${id}/geometry`)).result;
  const ownerWire = await connect(owner, campaign.id, 'OWNER');
  const gmWire = await connect(gm, campaign.id, 'GM');
  const playerWire = await connect(player, campaign.id, 'PLAYER');
  let door;
  await scenario('legacy empty snapshot and GM create use stable coordinates; Player receives no geometry invalidation', async () => {
    assert.deepEqual(await view(), { campaignId: campaign.id, sceneId: scene.id, revision: 0, obstacleMovementEnabled: false, obstacles: [] });
    const { result, cacheControl } = await request(gm, path, 'POST', secret, 201);
    door = result.obstacle;
    assert.equal(cacheControl, 'no-store');
    assert.deepEqual([door.start.x, door.doorState, door.visibility, door.version], [130.123, 'LOCKED', 'SECRET', 1]);
    await until(() => ownerWire.packets.length === 1 && gmWire.packets.length === 1);
    assert.deepEqual(ownerWire.packets, [{ campaignId: campaign.id, sceneId: scene.id }]);
    assert.deepEqual(playerWire.packets, []);
  });
  await scenario('membership, role and scene scope deny Player and cross-campaign requests consistently', async () => {
    const actual = `${path}/${door.id}`;
    const missing = `${path}/${randomUUID()}`;
    const edit = { ...secret, expectedVersion: 1 };
    await request(null, path, 'GET', undefined, 401);
    await request(player, path, 'GET', undefined, 403);
    await request(stranger, path, 'GET', undefined, 403);
    await request(player, path, 'POST', wall, 403);
    assert.deepEqual((await request(player, actual, 'PATCH', edit, 403)).result, (await request(player, missing, 'PATCH', edit, 403)).result);
    await request(player, actual, 'DELETE', { expectedVersion: 1 }, 403);
    await request(stranger, `/api/scenes/${other.id}/geometry/${door.id}`, 'PATCH', edit, 404);
    await request(owner, `/api/scenes/${second.id}/geometry/${door.id}`, 'PATCH', edit, 404);
    const { result } = await request(player, `/api/campaigns/${campaign.id}/scenes`);
    assert.ok(!JSON.stringify(result).includes(door.id) && !JSON.stringify(result).includes('geometryRevision'));
  });
  await scenario('validation and scene resize preserve bounds', async () => {
    await request(owner, path, 'POST', { ...wall, end: { x: scene.width + 1, y: 20 } }, 400);
    await request(owner, path, 'POST', { ...wall, end: wall.start }, 400);
    await request(owner, path, 'POST', { ...wall, doorState: 'CLOSED' }, 400);
    await request(owner, `/api/scenes/${scene.id}`, 'PATCH', { width: 400, expectedVersion: scene.version }, 409);
    assert.equal((await view()).revision, 1);
  });
  await scenario('concurrent updates permit one version and commit one audit and revision', async () => {
    const url = `${path}/${door.id}`;
    const result = await Promise.all(['OPEN', 'CLOSED'].map((doorState) =>
      request(gm, url, 'PATCH', { ...secret, doorState, expectedVersion: 1 }, [200, 409])));
    assert.deepEqual(result.map((item) => item.status).sort(), [200, 409]);
    const current = await view();
    assert.equal(current.revision, 2);
    door = current.obstacles[0];
    assert.equal(door.version, 2);
    const { rows } = await db.query('SELECT action FROM audit_events WHERE target_id = $1 ORDER BY created_at', [door.id]);
    assert.deepEqual(rows.map(({ action }) => action), ['geometry.create', 'geometry.update']);
  });
  await scenario('audit failure rolls back geometry, revision, receipt and publication', async () => {
    const original = await view();
    await until(() => ownerWire.packets.length === 2);
    await db.query(`CREATE FUNCTION nri_geometry_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action = 'geometry.create' THEN RAISE EXCEPTION 'geometry fixture rollback'; END IF; RETURN NEW; END $$`);
    await db.query('CREATE TRIGGER nri_geometry_fail_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION nri_geometry_fail_audit()');
    const key = randomUUID();
    try {
      await request(owner, path, 'POST', wall, 500, key);
      assert.deepEqual(await view(), original);
      assert.equal(ownerWire.packets.length, 2);
      assert.equal((await db.query('SELECT 1 FROM rest_operation_receipts WHERE request_id = $1', [key])).rowCount, 0);
    } finally {
      await db.query('DROP TRIGGER nri_geometry_fail_audit ON audit_events');
      await db.query('DROP FUNCTION nri_geometry_fail_audit()');
    }
  });
  await scenario('unknown command outcome replays with the same result and does not emit twice', async () => {
    const key = randomUUID();
    const { result: { obstacle } } = await request(owner, path, 'POST', wall, 201, key);
    assert.deepEqual((await request(owner, path, 'POST', wall, 200, key)).result.obstacle, obstacle);
    await request(owner, path, 'POST', { ...wall, blocksVision: false }, 409, key);
    await until(() => ownerWire.packets.length === 3);
    const deleteKey = randomUUID();
    await request(owner, `${path}/${obstacle.id}`, 'DELETE', { expectedVersion: 1 }, 204, deleteKey);
    await request(owner, `${path}/${obstacle.id}`, 'DELETE', { expectedVersion: 1 }, 204, deleteKey);
    await request(owner, path, 'POST', wall, 409, key);
    assert.equal((await view()).revision, 4);
    await until(() => ownerWire.packets.length === 4);
  });
  await scenario('scene and campaign copies preserve geometry with fresh IDs and idempotent replay', async () => {
    const sceneKey = randomUUID();
    const source = `/api/scenes/${scene.id}/duplicate`;
    const { result: { scene: copied } } = await request(owner, source, 'POST', undefined, 201, sceneKey);
    assert.equal((await request(owner, source, 'POST', undefined, 200, sceneKey)).result.scene.id, copied.id);
    const copiedGeometry = await view(owner, copied.id);
    assert.equal(copiedGeometry.obstacles.length, 1);
    assert.notEqual(copiedGeometry.obstacles[0].id, door.id);
    assert.deepEqual({ ...copiedGeometry.obstacles[0], id: door.id, sceneId: door.sceneId, version: door.version }, door);
    const campaignKey = randomUUID();
    const copyRoute = `/api/campaigns/${campaign.id}/duplicate`;
    const { result: { campaign: cloned } } = await request(owner, copyRoute, 'POST', undefined, 201, campaignKey);
    assert.equal((await request(owner, copyRoute, 'POST', undefined, 200, campaignKey)).result.campaign.id, cloned.id);
    const { result: sceneList } = await request(owner, `/api/campaigns/${cloned.id}/scenes`);
    const clone = sceneList.find(({ title }) => title === scene.title);
    const geometry = await view(owner, clone.id);
    assert.equal(geometry.campaignId, cloned.id);
    assert.equal(geometry.obstacles.length, 1);
    assert.notEqual(geometry.obstacles[0].id, door.id);
    assert.equal(geometry.obstacles[0].doorState, door.doorState);
  });
  await scenario('active switch, archive, restore and reconnect preserve an authorized snapshot', async () => {
    await request(owner, `/api/scenes/${second.id}/activate`, 'PUT', { expectedVersion: second.version });
    const { result: sceneList } = await request(owner, `/api/campaigns/${campaign.id}/scenes`);
    const version = sceneList.find(({ id }) => id === scene.id).version;
    const { result: { scene: archived } } = await request(owner, `/api/scenes/${scene.id}/archive`, 'PUT', { expectedVersion: version });
    await request(owner, path, 'GET', undefined, 404);
    await request(owner, `/api/scenes/${scene.id}/restore`, 'PUT', { expectedVersion: archived.version });
    assert.deepEqual((await view()).obstacles, [door]);
    ownerWire.socket.disconnect();
    await connect(owner, campaign.id, 'OWNER');
    assert.deepEqual((await view()).obstacles, [door]);
  });
  await scenario('role demotion and membership removal stop invalidations to already-open sockets', async () => {
    const gmCount = gmWire.packets.length;
    const memberPath = `/api/campaigns/${campaign.id}/members/${gm.id}`;
    await request(owner, `${memberPath}/role`, 'POST', { role: 'PLAYER' });
    await request(gm, path, 'GET', undefined, 403);
    const currentOwner = sockets.at(-1);
    const signals = [];
    currentOwner.on('geometry:changed', (data) => signals.push(data));
    await request(owner, path, 'POST', wall, 201);
    await until(() => signals.length === 1);
    await request(owner, memberPath, 'DELETE', undefined, 204);
    await request(gm, path, 'GET', undefined, 403);
    await request(owner, path, 'POST', wall, 201);
    await until(() => signals.length === 2);
    assert.equal(gmWire.packets.length, gmCount);
    assert.equal(playerWire.packets.length, 0);
  });
} finally {
  for (const socket of sockets) socket.disconnect();
  await db.end();
}

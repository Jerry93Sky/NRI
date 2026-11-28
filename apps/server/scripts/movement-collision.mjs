import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { io } from 'socket.io-client';

const api = new URL(process.env.NRI_API_URL ?? 'http://127.0.0.1:3010');
const database = new URL(process.env.DATABASE_URL);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(database.pathname, '/nri_collision_test');
for (const url of [api, database]) assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
const pgPool = new pg.Pool({ connectionString: database.href, query_timeout: 8000 });
const sockets = [];
const suffix = randomUUID().slice(0, 8);
const password = randomUUID();
const from = 144;
const to = 480;
const grid = 48;
const tokenCoordinate = (position) => position / grid;
const wall = (x, low, high) => ({ kind: 'WALL', doorState: null, visibility: 'STANDARD', blocksMovement: true,
  blocksVision: true, start: { x, y: low }, end: { x, y: high } });
const denial = { error: 'MOVE_BLOCKED' };
let count = 0;
async function check(name, fn) { await fn(); console.log(`PASS ${++count} ${name}`); }

async function request(actor, path, method = 'GET', data, status = 200, key) {
  const response = await fetch(new URL(path, api), { method, signal: AbortSignal.timeout(11000),
    headers: { ...(actor ? { cookie: actor.cookie } : {}), ...(data ? { 'content-type': 'application/json' } : {}),
      ...(key ? { 'idempotency-key': key } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  assert.equal(response.status, status, `${method} ${path}`);
  return { body: status === 204 ? null : await response.json(),
    cookie: response.headers.getSetCookie().find((part) => part.startsWith('nri_session='))?.split(';')[0] };
}

async function register(label) {
  const { body, cookie } = await request(null, '/api/auth/register', 'POST',
    { email: `${label}-${suffix}@example.test`, displayName: label, password }, 201);
  assert.ok(cookie);
  return { id: body.user.id, cookie };
}

async function connect(actor, campaign, role) {
  const socket = io(api.origin, { autoConnect: false, reconnection: false, timeout: 5000, transports: ['websocket'],
    extraHeaders: { cookie: actor.cookie } });
  const packets = [];
  socket.onAny((event, data) => packets.push({ event, data }));
  sockets.push(socket);
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
  assert.deepEqual(await socket.timeout(6000).emitWithAck('campaign:join', campaign.id), { ok: true, role });
  return { socket, packets };
}

async function until(test, message) {
  const deadline = Date.now() + 6500;
  do {
    const result = await test();
    if (result) return result;
    await delay(20);
  } while (Date.now() < deadline);
  assert.fail(message);
}

async function expectWait(table, strength) {
  const match = new RegExp(`from "${table}".*for ${strength}`, 'i');
  await until(async () => {
    const { rows } = await pgPool.query(`SELECT query FROM pg_stat_activity WHERE datname = current_database()
      AND state = 'active' AND cardinality(pg_blocking_pids(pid)) > 0`);
    return rows.some(({ query }) => match.test(query));
  }, `Expected ${table} ${strength} lock wait`);
}

async function withGate(table, id, effect) {
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE`, [id]);
    await effect(() => client.query('COMMIT'));
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

try {
  const owner = await register('motion-owner');
  const gm = await register('motion-gm');
  const player = await register('motion-player');
  const { body: { campaign } } = await request(owner, '/api/campaigns', 'POST', { title: `Movement ${suffix}`, description: '' }, 201);
  await pgPool.query("INSERT INTO campaign_memberships (campaign_id,user_id,role) VALUES ($1,$2,'GM'),($1,$3,'PLAYER')", [campaign.id, gm.id, player.id]);
  const makeScene = async (title) => (await request(owner, '/api/scenes', 'POST', { title, campaignId: campaign.id, gridSize: grid }, 201)).body.scene;
  const scene = await makeScene('Live collision map');
  const second = await makeScene('Legacy scene');
  const createToken = async (target, name, y) => (await request(owner, '/api/tokens', 'POST',
    { name, sceneId: target.id, x: tokenCoordinate(from), y: tokenCoordinate(y) }, 201)).body.token;
  const moving = await createToken(scene, 'Player anchor', 200);
  const partner = await createToken(scene, 'Other anchor', 640);
  const legacy = await createToken(second, 'Legacy anchor', 200);
  await pgPool.query('UPDATE tokens SET owner_user_id = $1 WHERE id = $2', [player.id, moving.id]);
  const setPosition = async (token, x, y) => (await pgPool.query(
    'UPDATE tokens SET x=$2,y=$3,version=version+1 WHERE id=$1 RETURNING id,x,y,version', [token.id, tokenCoordinate(x), tokenCoordinate(y)])).rows[0];
  const get = async (token) => (await pgPool.query('SELECT id,x,y,version FROM tokens WHERE id=$1', [token.id])).rows[0];
  const geometry = `/api/scenes/${scene.id}/geometry`;
  const settings = async () => (await request(gm, geometry)).body;
  const policy = async (enabled, expectedRevision, status = 200, actor = gm, key) =>
    (await request(actor, geometry + '/movement-policy', 'PATCH', { enabled, expectedRevision }, status, key)).body;
  const obstacle = async (fields) => (await request(gm, geometry, 'POST', fields, 201)).body.obstacle;
  const solid = await obstacle(wall(300, 120, 264));
  const visibleDoor = { ...wall(300, 372, 444), kind: 'DOOR', doorState: 'OPEN' };
  const door = await obstacle(visibleDoor);
  const secret = await obstacle({ ...wall(300, 480, 570), kind: 'DOOR', doorState: 'LOCKED', visibility: 'SECRET' });
  const editDoor = async (expectedVersion, doorState) => (await request(gm, `${geometry}/${door.id}`, 'PATCH',
    { ...visibleDoor, doorState, expectedVersion })).body.obstacle;
  let playerWire = await connect(player, campaign, 'PLAYER');
  const gmWire = await connect(gm, campaign, 'GM');
  const movePayload = (token, x, y, extras) =>
    ({ tokenId: token.id, expectedVersion: token.version, x: tokenCoordinate(x), y: tokenCoordinate(y), ...extras });
  const move = (wire, token, x, y, extras) => wire.socket.timeout(9000).emitWithAck('token:move', movePayload(token, x, y, extras));
  const groupRoute = `/api/scenes/${scene.id}/tokens/group`;
  const groupBody = (a, b, x, extras) => ({ ...extras, updates: [a, b].map((token) =>
    ({ tokenId: token.id, expectedVersion: token.version, patch: { x: tokenCoordinate(x) } })) });

  await check('legacy scene and disabled movement preserve old position semantics', async () => {
    assert.equal((await settings()).obstacleMovementEnabled, false);
    assert.equal((await move(playerWire, await get(moving), to, 200)).ok, true);
    assert.equal((await move(gmWire, await get(legacy), -48, 200)).ok, true);
  });
  await check('versioned GM setting, actor-only replay and Player denial', async () => {
    const { revision } = await settings();
    const key = randomUUID();
    assert.deepEqual(await policy(true, revision, 403, player), { error: 'FORBIDDEN' });
    const enabled = await policy(true, revision, 200, gm, key);
    assert.deepEqual(enabled, { revision: revision + 1, obstacleMovementEnabled: true });
    assert.deepEqual(await policy(true, revision, 200, gm, key), enabled);
    assert.deepEqual(await policy(false, revision, 409), { error: 'CONFLICT' });
    assert.equal((await pgPool.query("SELECT 1 FROM audit_events WHERE target_id=$1 AND action='geometry.movement_policy'", [scene.id])).rowCount, 1);
    assert.deepEqual(await move(playerWire, await get(moving), from, 200, { expectedGeometryRevision: enabled.revision }), { error: 'FORBIDDEN' });
  });
  await check('Player, GM and direct REST cannot cross a wall with the policy enabled', async () => {
    const a = await setPosition(moving, from, 200);
    const b = await get(partner);
    assert.deepEqual(await move(playerWire, a, to, 200, { start: { x: 900, y: 200 }, bypass: true }), denial);
    assert.deepEqual(await move(gmWire, a, to, 200), denial);
    assert.deepEqual((await request(player, groupRoute, 'PATCH', groupBody(a, b, to), 403)).body, { error: 'FORBIDDEN' });
    assert.deepEqual((await request(gm, groupRoute, 'PATCH', groupBody(a, b, to), 409)).body, denial);
    assert.deepEqual(await get(moving), a);
    assert.deepEqual(await get(partner), b);
  });
  await check('door open, closed, locked and open again apply the current state', async () => {
    let a = await setPosition(moving, from, 408);
    assert.equal((await move(playerWire, a, to, 408)).ok, true);
    const closed = await editDoor(door.version, 'CLOSED');
    a = await get(moving);
    assert.deepEqual(await move(playerWire, a, from, 408), denial);
    const locked = await editDoor(closed.version, 'LOCKED');
    assert.deepEqual(await move(playerWire, a, from, 408), denial);
    const open = await editDoor(locked.version, 'OPEN');
    assert.equal((await move(playerWire, a, from, 408)).ok, true);
    door.version = open.version;
  });
  await check('secret geometry stays absent from errors, snapshots and realtime', async () => {
    const a = await setPosition(moving, from, 528);
    assert.deepEqual(await move(playerWire, a, to, 528), denial);
    assert.deepEqual((await request(player, geometry, 'GET', undefined, 403)).body, { error: 'FORBIDDEN' });
    const { body } = await request(player, `/api/campaigns/${campaign.id}/scenes`);
    for (const data of [body, playerWire.packets]) {
      assert.ok(!JSON.stringify(data).match(new RegExp(`${secret.id}|geometry:changed|obstacleMovementEnabled|geometryRevision`)));
    }
    assert.deepEqual(await get(moving), a);
  });
  await check('stale geometry precondition and stale token version return safe conflicts', async () => {
    const a = await setPosition(moving, from, 640);
    const { revision } = await settings();
    assert.deepEqual(await move(gmWire, a, to, 640, { expectedGeometryRevision: revision - 1 }), { error: 'CONFLICT' });
    const moveResult = await move(gmWire, a, to, 640, { expectedGeometryRevision: revision });
    assert.equal(moveResult.ok, true);
    const repeated = await move(playerWire, a, from, 640);
    assert.equal(repeated.error, 'CONFLICT');
    assert.equal(repeated.token.x, tokenCoordinate(to));
  });
  await check('door close queued first wins before movement can read geometry', async () => {
    const a = await setPosition(moving, from, 408);
    await withGate('scenes', scene.id, async (release) => {
      const edit = editDoor(door.version, 'CLOSED');
      await expectWait('scenes', 'update');
      const motion = move(playerWire, a, to, 408);
      await expectWait('scenes', 'share');
      await release();
      door.version = (await edit).version;
      assert.deepEqual(await motion, denial);
    });
    assert.deepEqual(await get(moving), a);
  });
  await check('movement holding the scene lock commits before concurrent obstacle creation', async () => {
    const a = await setPosition(moving, from, 710);
    await withGate('tokens', moving.id, async (release) => {
      const motion = move(playerWire, a, to, 710);
      await expectWait('tokens', 'no key update');
      const create = obstacle(wall(312, 682, 742));
      await expectWait('scenes', 'update');
      await release();
      assert.equal((await motion).ok, true);
      await create;
    });
    assert.deepEqual(await move(playerWire, await get(moving), from, 710), denial);
  });
  await check('group on clear paths commits atomically and old versions cannot repeat the update', async () => {
    const a = await setPosition(moving, from, 615);
    const b = await setPosition(partner, from, 640);
    const payload = groupBody(a, b, to);
    const { body } = await request(gm, groupRoute, 'PATCH', payload);
    assert.deepEqual(body.tokens.map((token) => token.x), [tokenCoordinate(to), tokenCoordinate(to)]);
    assert.deepEqual((await request(gm, groupRoute, 'PATCH', payload, 409)).body, { error: 'CONFLICT' });
    assert.deepEqual([(await get(a)).version, (await get(b)).version], [a.version + 1, b.version + 1]);
  });
  await check('database failure rolls back positions and versions for the whole validated group', async () => {
    const a = await setPosition(moving, from, 615);
    const b = await setPosition(partner, from, 640);
    await pgPool.query(`CREATE FUNCTION nri_movement_fail_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.id = '${b.id}'::uuid THEN RAISE EXCEPTION 'movement test rollback'; END IF; RETURN NEW; END $$`);
    await pgPool.query('CREATE TRIGGER nri_movement_fail_update BEFORE UPDATE ON tokens FOR EACH ROW EXECUTE FUNCTION nri_movement_fail_update()');
    try {
      await request(gm, groupRoute, 'PATCH', groupBody(a, b, to), 500);
      assert.deepEqual(await get(a), a);
      assert.deepEqual(await get(b), b);
    } finally {
      await pgPool.query('DROP TRIGGER nri_movement_fail_update ON tokens');
      await pgPool.query('DROP FUNCTION nri_movement_fail_update()');
    }
  });
  await check('no ACK, replay and reconnect retain the committed movement exactly once', async () => {
    const a = await setPosition(moving, from, 615);
    playerWire.socket.emit('token:move', movePayload(a, to, 615));
    const saved = await until(async () => {
      const current = await get(a);
      return current.version === a.version + 1 && current;
    }, 'Expected movement whose ACK was not observed');
    assert.equal((await move(playerWire, a, to, 615)).error, 'CONFLICT');
    assert.deepEqual(await get(a), saved);
    const blocked = await setPosition(moving, from, 200);
    assert.deepEqual(await move(playerWire, blocked, to, 200), denial);
    playerWire.socket.disconnect();
    playerWire = await connect(player, campaign, 'PLAYER');
    const { body } = await request(player, `/api/scenes/${scene.id}/tokens`);
    assert.deepEqual(body.filter(({ id }) => id === moving.id).map(({ x, y, version }) => ({ x, y, version })),
      [{ x: blocked.x, y: blocked.y, version: blocked.version }]);
  });
  await check('scene activation queued ahead of a Player move revokes access to the old scene', async () => {
    const a = await setPosition(moving, from, 615);
    await withGate('campaigns', campaign.id, async (release) => {
      const activate = request(owner, `/api/scenes/${second.id}/activate`, 'PUT', { expectedVersion: second.version });
      await expectWait('campaigns', 'no key update');
      const motion = move(playerWire, a, to, 615);
      await expectWait('campaigns', 'share');
      await release();
      await activate;
      assert.deepEqual(await motion, { error: 'FORBIDDEN' });
    });
    const { body } = await request(owner, `/api/campaigns/${campaign.id}/scenes`);
    const old = body.find(({ id }) => id === scene.id);
    await request(owner, `/api/scenes/${scene.id}/activate`, 'PUT', { expectedVersion: old.version });
    assert.deepEqual(await get(moving), a);
  });
  await check('membership removal queued ahead of a Player move prevents writes', async () => {
    const a = await get(moving);
    await withGate('campaigns', campaign.id, async (release) => {
      const remove = request(owner, `/api/campaigns/${campaign.id}/members/${player.id}`, 'DELETE', undefined, 204);
      await expectWait('campaigns', 'update');
      const motion = move(playerWire, a, to, 615);
      await expectWait('campaigns', 'share');
      await release();
      await remove;
      assert.deepEqual(await motion, { error: 'FORBIDDEN' });
    });
    assert.deepEqual(await get(moving), a);
  });
  await check('scene and campaign copy preserve the policy with independent geometry IDs', async () => {
    const { body: { scene: copied } } = await request(owner, `/api/scenes/${scene.id}/duplicate`, 'POST', undefined, 201, randomUUID());
    const { body: sceneGeometry } = await request(owner, `/api/scenes/${copied.id}/geometry`);
    assert.equal(sceneGeometry.obstacleMovementEnabled, true);
    assert.ok(sceneGeometry.obstacles.every(({ id }) => id !== solid.id));
    const { body: { campaign: cloned } } = await request(owner, `/api/campaigns/${campaign.id}/duplicate`, 'POST', undefined, 201, randomUUID());
    const { body } = await request(owner, `/api/campaigns/${cloned.id}/scenes`);
    const match = body.find(({ title }) => title === scene.title);
    assert.equal((await request(owner, `/api/scenes/${match.id}/geometry`)).body.obstacleMovementEnabled, true);
  });
  await check('GM override via the audited policy toggle keeps ownership checks intact', async () => {
    const a = await setPosition(moving, from, 200);
    await policy(false, (await settings()).revision);
    assert.equal((await move(gmWire, a, to, 200)).ok, true);
    assert.deepEqual(await move(playerWire, await get(moving), from, 200), { error: 'FORBIDDEN' });
  });
} finally {
  for (const socket of sockets) socket.disconnect();
  await pgPool.end();
}

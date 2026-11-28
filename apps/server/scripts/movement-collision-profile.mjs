import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { io } from 'socket.io-client';
import { movementBlockers, movementIsBlocked } from '../dist/domain/movementCollision.js';

const api = new URL(process.env.NRI_API_URL ?? 'http://127.0.0.1:3010');
const database = new URL(process.env.DATABASE_URL);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(database.pathname, '/nri_collision_test');
for (const url of [api, database]) assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));

const pool = new pg.Pool({ connectionString: database.href });
const runId = randomUUID();
const grid = 48;
const start = 144;
const end = 480;
const restSamples = 12;
const cpuSamples = 200;
const concurrentSamples = 8;
let cookie;
let socket;
const publishedVersions = new Map();

async function request(path, method, data, status) {
  const response = await fetch(new URL(path, api), { method, signal: AbortSignal.timeout(10000), headers: {
    'content-type': 'application/json', ...(cookie ? { cookie } : {}),
  }, body: JSON.stringify(data) });
  assert.equal(response.status, status, method + ' ' + path);
  return response;
}

function percentile(values, fraction) {
  const ordered = [...values].sort((a, b) => a - b);
  return Number(ordered[Math.ceil(ordered.length * fraction) - 1].toFixed(3));
}

const describe = (values) => ({ n: values.length, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95) });

const wall = (x, minY, maxY) => ({
  kind: 'WALL', doorState: null, visibility: 'STANDARD', blocksMovement: true, blocksVision: false,
  start: { x, y: minY }, end: { x, y: maxY },
});

function profileCollision(obstacles, scene, count, blocked) {
  const paths = Array.from({ length: count }, (_, index) => {
    const y = (blocked && index === count - 1 ? 720 : 240) + index;
    return { start: { x: start, y }, end: { x: end, y } };
  });
  const samples = [];
  for (let sample = 0; sample < cpuSamples + 20; sample += 1) {
    const before = performance.now();
    const blockers = movementBlockers(obstacles);
    const denied = paths.some((path) => movementIsBlocked(path, scene, blockers));
    const elapsed = performance.now() - before;
    assert.equal(denied, blocked);
    if (sample >= 20) samples.push(elapsed);
  }
  return describe(samples);
}

console.log(JSON.stringify({ runId, node: process.version, restSamples, cpuSamples, concurrentSamples }));
try {
  const registration = await request('/api/auth/register', 'POST', {
    email: `profile-${runId}@example.test`, displayName: 'Movement profile', password: randomUUID(),
  }, 201);
  cookie = registration.headers.getSetCookie().find((value) => value.startsWith('nri_session='))?.split(';')[0];
  assert.ok(cookie);
  const { campaign } = await (await request('/api/campaigns', 'POST', { title: `Collision profile ${runId}`, description: '' }, 201)).json();
  socket = io(api.origin, { transports: ['websocket'], extraHeaders: { cookie }, autoConnect: false, reconnection: false, timeout: 5000 });
  for (const event of ['token:moved', 'token:updated']) {
    socket.on(event, ({ id, version }) => publishedVersions.set(id, version));
  }
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
  assert.deepEqual(await socket.timeout(5000).emitWithAck('campaign:join', campaign.id), { ok: true, role: 'OWNER' });

  for (const obstacleCount of [100, 500, 2000]) {
    const { scene } = await (await request('/api/scenes', 'POST', { campaignId: campaign.id, title: `Profile ${obstacleCount}`, gridSize: grid }, 201)).json();
    const geometryPath = `/api/scenes/${scene.id}/geometry`;
    const stand = wall(1000, 1600, 1640);
    const { obstacle } = await (await request(geometryPath, 'POST', stand, 201)).json();
    await (await request(geometryPath + '/movement-policy', 'PATCH', { enabled: true, expectedRevision: 1 }, 200)).json();
    const obstacles = Array.from({ length: obstacleCount - 2 }, (_, index) => wall(20 + index, 1000, 1500));
    obstacles.push(wall(300, 700, 780));
    await pool.query(`INSERT INTO scene_obstacles (scene_id, start_x, start_y, end_x, end_y, kind, visibility, blocks_movement, blocks_vision)
      SELECT $1, x * 1000, low_y * 1000, x * 1000, high_y * 1000, 'WALL', 'STANDARD', true, false
      FROM unnest($2::int[], $3::int[], $4::int[]) AS fixture(x,low_y,high_y)`,
    [scene.id, obstacles.map((item) => item.start.x), obstacles.map((item) => item.start.y), obstacles.map((item) => item.end.y)]);
    obstacles.push(stand);
    const tokens = (await pool.query(`INSERT INTO tokens (scene_id, name, x, y, color)
      SELECT $1, 'Profile token ' || item, $2, 5, '#7766aa' FROM generate_series(1,20) AS item RETURNING id`,
    [scene.id, start / grid])).rows.map(({ id }) => id);

    const prepare = async (size, blocked) => {
      const ids = tokens.slice(0, size);
      const { rows } = await pool.query(`UPDATE tokens AS token SET x=$2, y=fixture.y, version=token.version+1
        FROM unnest($1::uuid[], $3::float8[]) AS fixture(id,y) WHERE token.id=fixture.id RETURNING token.id, token.version, token.y`,
      [ids, start / grid, ids.map((_, index) => ((blocked && index === size - 1 ? 720 : 240) + index) / grid)]);
      return rows;
    };
    const move = async (rows, blocked) => {
      const size = rows.length;
      const before = performance.now();
      let elapsed;
      if (size === 1) {
        const { id, version, y } = rows[0];
        const result = await socket.timeout(5000).emitWithAck('token:move', { tokenId: id, expectedVersion: version, x: end / grid, y });
        elapsed = performance.now() - before;
        if (blocked) assert.deepEqual(result, { error: 'MOVE_BLOCKED' });
        else assert.equal(result.token.x, end / grid);
      } else {
        const result = await (await request(`/api/scenes/${scene.id}/tokens/group`, 'PATCH', {
          updates: rows.map(({ id, version }) => ({ tokenId: id, expectedVersion: version, patch: { x: end / grid } })),
        }, blocked ? 409 : 200)).json();
        elapsed = performance.now() - before;
        if (blocked) assert.deepEqual(result, { error: 'MOVE_BLOCKED' });
        else assert.equal(result.tokens.length, size);
      }
      if (!blocked) {
        // Let after-commit publication finish before directly resetting fixture rows for the next sample.
        const { id, version } = rows[0];
        const deadline = performance.now() + 5000;
        while (publishedVersions.get(id) !== version + 1) {
          assert.ok(performance.now() < deadline, 'Expected a committed movement event before resetting the fixture');
          await delay(5);
        }
      }
      return elapsed;
    };

    for (const tokenCount of [1, 4, 8, 20]) {
      for (const blocked of [false, true]) {
        await move(await prepare(tokenCount, blocked), blocked);
        const samples = [];
        for (let sample = 0; sample < restSamples; sample += 1) samples.push(await move(await prepare(tokenCount, blocked), blocked));
        console.log(JSON.stringify({ obstacles: obstacleCount, tokens: tokenCount, blocked, collision: profileCollision(obstacles, scene, tokenCount, blocked),
          transport: tokenCount === 1 ? 'websocket' : 'rest', request: describe(samples) }));
      }
    }

    let version = obstacle.version;
    const edit = async (offset) => {
      const before = performance.now();
      const { obstacle: changed } = await (await request(`${geometryPath}/${obstacle.id}`, 'PATCH',
        { ...stand, start: { x: 1000 + offset, y: stand.start.y }, end: { x: 1000 + offset, y: stand.end.y }, expectedVersion: version }, 200)).json();
      version = changed.version;
      return performance.now() - before;
    };
    const edits = [];
    const parallelEdits = [];
    const parallelMoves = [];
    for (let sample = 0; sample < concurrentSamples; sample += 1) edits.push(await edit(1 + sample % 2));
    for (let sample = 0; sample < concurrentSamples; sample += 1) {
      const rows = await prepare(20, false);
      const [motion, geometry] = await Promise.all([move(rows, false), edit(3 + sample % 2)]);
      parallelMoves.push(motion);
      parallelEdits.push(geometry);
    }
    console.log(JSON.stringify({ obstacles: obstacleCount, tokens: 20, isolatedGeometryEdit: describe(edits),
      overlappingGeometryEdit: describe(parallelEdits), overlappingGroupMove: describe(parallelMoves) }));
  }
} finally {
  socket?.disconnect();
  await pool.end();
}

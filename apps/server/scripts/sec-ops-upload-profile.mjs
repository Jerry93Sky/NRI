import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { io } from 'socket.io-client';

const docker = promisify(execFile);
const api = new URL('http://127.0.0.1:35595');
const container = process.env.NRI_PROFILE_CONTAINER;
assert.match(container ?? '', /^[0-9a-f]{12,64}$/);
const state = async () => JSON.parse((await docker('docker', ['inspect', '--format',
  '{"project":{{json (index .Config.Labels "com.docker.compose.project")}},"status":{{json .State.Status}},"oom":{{.State.OOMKilled}},"restarts":{{.RestartCount}},"limit":{{.HostConfig.Memory}}}', container])).stdout);
const initial = await state();
assert.equal(initial.project, 'nri-sec-ops-profile');
assert.equal(initial.status, 'running');
assert.equal(initial.limit, 768 * 1024 * 1024);
let ready = false;
for (let attempt = 0; attempt < 30; attempt++) {
  try { ready = (await fetch(new URL('/api/ready', api), { signal: AbortSignal.timeout(500) })).ok; } catch {}
  if (ready) break;
  await delay(250);
}
assert.ok(ready, 'Expect isolated profile API readiness');

const collector = spawn('docker', ['exec', '-i', container, 'node', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
collector.stdin.end(`
  const fs = require('node:fs');
  if (!fs.readFileSync('/proc/1/cmdline','utf8').split(String.fromCharCode(0))[0].endsWith('node')) process.exit(2);
  let metrics = {};
  const tick = () => {
    try {
      const rss = /VmRSS:\\s+(\\d+)/.exec(fs.readFileSync('/proc/1/status', 'utf8'));
      const used = Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8'));
      console.log(JSON.stringify({rss:Number(rss[1])*1024, cgroup:used, active:metrics.assetProcessing?.active, loopP95Ms:metrics.assetProcessing?.loopP95Ms}));
    } catch {}
  };
  setInterval(tick, 50);
  setInterval(async () => {
    metrics = await fetch('http://127.0.0.1:3000/api/metrics', {signal:AbortSignal.timeout(200)}).then(r=>r.json()).catch(()=>({}));
  }, 250);
  setTimeout(() => process.exit(0), 160000).unref();
`);
const samples = [];
let remainder = '';
collector.stdout.on('data', (buffer) => {
  const lines = (remainder + buffer.toString()).split('\n');
  remainder = lines.pop();
  for (const line of lines) if (line) samples.push(JSON.parse(line));
});
collector.stderr.resume();
const stopped = new Promise((resolve) => collector.once('close', resolve));
const settle = () => delay(450);
const mib = (bytes) => +(bytes / 1048576).toFixed(1);
let cookie;
const socket = io(api.origin, { autoConnect: false, reconnection: false, transports: ['websocket'] });

async function request(path, expected, { method = 'POST', key, body, allowUnavailable = false } = {}) {
  const form = body instanceof FormData;
  const t = performance.now();
  const response = await fetch(new URL(path, api), { method, signal: AbortSignal.timeout(30_000), headers: {
    ...(cookie ? { cookie } : {}), ...(key ? { 'idempotency-key': key } : {}), ...(body && !form ? { 'content-type': 'application/json' } : {}),
  }, body: form || body === undefined ? body : JSON.stringify(body) });
  assert.ok(response.status === expected || (allowUnavailable && response.status === 503), `${method}: expected ${expected}, got ${response.status}`);
  const result = response.headers.get('content-type')?.includes('application/json') ? await response.json() : (await response.arrayBuffer(), null);
  return { result, status: response.status, ms: performance.now() - t, cookie: response.headers.getSetCookie()[0]?.split(';')[0] };
}

function uploadForm(items) {
  const form = new FormData();
  for (const { bytes, name } of items) form.append('file', new Blob([bytes], { type: 'image/png' }), name + '.png');
  return form;
}

const profiles = [
  ['portrait', 512, 512], ['token', 768, 768], ['map', 2400, 1600], ['large-map', 3500, 3500], ['pixel-limit-map', 4096, 4096],
];
try {
  const fixtures = [];
  for (const [name, width, height] of profiles) {
    const raw = Buffer.allocUnsafe(width * height * 3);
    for (let y = 0, i = 0; y < height; y++) for (let x = 0; x < width; x++, i += 3) {
      const tiles = ((x >> 5) ^ (y >> 5)) & 1;
      raw[i] = 60 + tiles * 75 + ((13 * x + 11 * y) & 31);
      raw[i + 1] = 100 + tiles * 45 + ((x ^ y) & 31);
      raw[i + 2] = 45 + ((x * 5 + y * 7) & 63);
    }
    const bytes = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
    assert.ok(bytes.byteLength > 5000 && bytes.byteLength < 12 * 1048576);
    fixtures.push({ name, width, height, bytes });
  }
  console.log('fixtures', JSON.stringify(fixtures.map(({ name, width, height, bytes }) => ({ name, width, height, pixels: width * height, bytes: bytes.length }))));
  cookie = (await request('/api/auth/register', 201, { body: { email: `${randomUUID()}@example.test`, displayName: 'Profile GM', password: randomUUID() } })).cookie;
  const { result: { campaign } } = await request('/api/campaigns', 201, { body: { title: 'Upload resource profile', description: '' } });
  const { result: { scene } } = await request('/api/scenes', 201, { body: { campaignId: campaign.id, title: 'Profile table' } });
  const { result: { token } } = await request('/api/tokens', 201, { body: { sceneId: scene.id, name: 'Profile token', x: 2, y: 2 } });
  Object.assign(socket.io.opts, { extraHeaders: { cookie } });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
  const ack = (event, body) => socket.timeout(5000).emitWithAck(event, body);
  assert.equal((await ack('campaign:join', campaign.id)).ok, true);
  const assetPath = `/api/campaigns/${campaign.id}/assets?category=MAP`;
  const upload = (items, key = randomUUID(), expected = 201, allowUnavailable = false) => request(assetPath, expected, {
    body: uploadForm(items), key, allowUnavailable,
  });
  await settle();
  assert.ok(samples.length > 0, 'Expected process RSS samples from the isolated container');
  let highestCgroup = samples.at(-1).cgroup;
  let acceptedAsset;
  for (const width of [1, 2, 4, 8]) {
    if (width === 8 && highestCgroup > initial.limit * 0.62 && process.env.NRI_PROFILE_BOUNDED !== '1') {
      console.log('8 concurrent uploads skipped at baseline because 4 crossed the memory headroom threshold');
      break;
    }
    const start = samples.length;
    const baseline = samples.at(-1).rss;
    const timings = [];
    let busy = 0;
    for (let round = 0; round < 3; round++) {
      const requests = Array.from({ length: width }, (_, index) => upload([fixtures[(round === 2 ? fixtures.length - 1 : index + round) % fixtures.length]], randomUUID(), 201, true));
      const results = await Promise.all(requests);
      timings.push(...results.map(({ ms }) => ms));
      busy += results.filter(({ status }) => status === 503).length;
      acceptedAsset ??= results.find(({ status }) => status === 201)?.result.asset;
    }
    await settle();
    const observed = samples.slice(start);
    assert.ok(observed.length > 0);
    const peakCgroup = Math.max(...observed.map(({ cgroup }) => cgroup));
    const peakActive = Math.max(...observed.map(({ active }) => active ?? 0));
    highestCgroup = Math.max(highestCgroup, peakCgroup);
    if (process.env.NRI_PROFILE_BOUNDED === '1') {
      assert.equal(busy, 0, 'The 1/2/4/8 reference waves fit the queue');
      assert.ok(peakCgroup < initial.limit * .8, 'Reserve at least 20% container memory during the profile');
      assert.ok(peakActive <= 2, 'At most two concurrent asset-processing jobs');
    }
    const ordered = timings.sort((a, b) => a - b);
    const pct = (p) => +ordered[Math.ceil(p * ordered.length) - 1].toFixed(2);
    console.log('wave', JSON.stringify({ parallel: width, n: timings.length, baselineMiB: mib(baseline),
      peakRssMiB: mib(Math.max(...observed.map(({ rss }) => rss))), finalRssMiB: mib(observed.at(-1).rss),
      peakCgroupMiB: mib(peakCgroup), p50Ms: pct(.5), p95Ms: pct(.95), busy,
      peakActive: peakActive || null,
      loopP95Ms: observed.at(-1).loopP95Ms ?? null }));
  }
  const replayKey = randomUUID();
  const ops = [upload([fixtures[2]], replayKey), upload([fixtures[2]], replayKey),
    ack('token:move', { tokenId: token.id, x: 4, y: 5, expectedVersion: token.version }),
    ack('chat:send', { campaignId: campaign.id, clientMessageId: randomUUID(), body: 'Concurrent upload smoke', recipientId: null }),
    ack('dice:roll', { campaignId: campaign.id, requestId: randomUUID(), expression: '1d20', hidden: false }),
    request(`/api/campaigns/${campaign.id}/initiative/start`, 200, { body: { sceneId: scene.id, entries: [{ tokenId: token.id, label: token.name, score: 10 }] } }),
    request(`/api/assets/${acceptedAsset.id}?variant=thumbnail`, 200, { method: 'GET' })];
  const [assetA, assetB, move, chat, dice] = await Promise.all(ops);
  assert.equal(assetA.result.asset.id, assetB.result.asset.id);
  for (const cmd of [move, chat, dice]) assert.equal(cmd.ok, true);
  await request(`/api/scenes/${scene.id}`, 200, { method: 'PATCH', body: { title: 'Profile tabletop checked', expectedVersion: scene.version } });
  await upload([fixtures[0], { name: 'invalid', bytes: Buffer.from('invalid image') }], randomUUID(), 207);
  if (process.env.NRI_PROFILE_BOUNDED === '1') {
    const wrongType = new FormData();
    wrongType.append('file', new Blob([fixtures[0].bytes], { type: 'image/jpeg' }), 'wrong.jpg');
    assert.equal((await request(assetPath, 415, { body: wrongType })).result.error, 'IMAGE_TYPE_MISMATCH');
    const oversized = Buffer.from(fixtures[0].bytes.subarray(0, 24));
    oversized.writeUInt32BE(8193, 16);
    assert.equal((await upload([{ name: 'oversized-header', bytes: oversized }], randomUUID(), 415)).result.error, 'IMAGE_DIMENSIONS_UNSUPPORTED');
    await upload([{ name: 'too-many-bytes', bytes: Buffer.alloc(12 * 1048576 + 1) }], randomUUID(), 413);
  }
  const after = await state();
  assert.equal(after.oom, false);
  assert.equal(after.restarts, initial.restarts);
  assert.equal(after.status, 'running');
  console.log('PASS partial upload, same-key requests and multiplayer activity; no OOM or container restart observed');
} finally {
  socket.disconnect();
  collector.kill();
  await stopped;
}

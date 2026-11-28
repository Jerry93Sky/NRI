import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { percentiles, settle, snapshot } from './secure-realtime-profile.mjs';

const repetitions = 20;
const clock = () => performance.now();

function receive(socket, event) {
  return new Promise((resolve, reject) => {
    const listener = (payload) => {
      clearTimeout(timer);
      resolve({ id: payload.id, time: clock(), bytes: Buffer.byteLength(JSON.stringify([event, payload])) });
    };
    const timer = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error('Missing ' + event + ' in profile'));
    }, 6500);
    socket.once(event, listener);
  });
}

async function sample(db, sockets, event, command) {
  await settle(db);
  const before = new Map((await snapshot(db)).map(({ query, calls }) => [query, Number(calls)]));
  const ack = [];
  const wire = [];
  const afterAck = [];
  const bytes = [];
  for (let index = 0; index < repetitions; index++) {
    const started = clock();
    const delivery = Promise.all(sockets.map((socket) => receive(socket, event)));
    delivery.catch(() => {});
    const reply = await command(index);
    const acknowledged = clock();
    assert.equal(reply.ok, true);
    const expected = (reply.message ?? reply.roll).id;
    const receipts = await delivery;
    for (const receipt of receipts) assert.equal(receipt.id, expected);
    const latest = Math.max(...receipts.map(({ time }) => time));
    ack.push(acknowledged - started);
    wire.push(latest - started);
    afterAck.push(latest - acknowledged);
    bytes.push(receipts.reduce((sum, { bytes }) => sum + bytes, 0));
  }
  await settle(db);
  let sql = 0;
  let boundary = 0;
  for (const row of await snapshot(db)) {
    const count = Number(row.calls) - (before.get(row.query) ?? 0);
    if (/^(begin|commit)\b/iu.test(row.query)) boundary += count;
    else sql += count;
  }
  console.log('PRIVATE_DELIVERY_PROFILE', JSON.stringify({
    event, sockets: sockets.length, repetitions, sql: sql / repetitions, transactionBoundaries: boundary / repetitions,
    ackMs: percentiles(ack), lastWireMs: percentiles(wire), ackToLastWireMs: percentiles(afterAck),
    fanoutJsonBytes: percentiles(bytes),
  }));
}

async function pointerProfile(db, { owner, own, playerWire, scene, cid, connect, send, roll }) {
  const durationMs = 3000;
  for (const count of [1, 4, 8]) {
    const senders = [own];
    for (let index = 1; index < count; index++) senders.push(await connect(owner, cid, 'OWNER'));
    const received = new Map(senders.map((socket) => [socket.id, 0]));
    const latencies = [];
    let bytes = 0;
    const onPointer = (payload) => {
      if (!received.has(payload.pointerId)) return;
      received.set(payload.pointerId, received.get(payload.pointerId) + 1);
      bytes += Buffer.byteLength(JSON.stringify(['scene:pointer', payload]));
      const started = pending.get(payload.pointerId + ':' + payload.x);
      if (started !== undefined) latencies.push(performance.now() - started);
    };
    const pending = new Map();
    playerWire.on('scene:pointer', onPointer);
    await settle(db);
    const before = new Map((await snapshot(db)).map(({ query, calls }) => [query, Number(calls)]));
    const wallStarted = performance.now();
    const cpuStarted = process.cpuUsage();
    const samples = [];
    const apiBefore = readApiProcess();
    const pointerWorkers = Promise.all(senders.map(async (socket, senderIndex) => {
      let sequence = 0;
      while (performance.now() - wallStarted < durationMs) {
        const x = 16 + ((senderIndex * 120 + sequence++) % 192);
        const started = performance.now();
        pending.set(socket.id + ':' + x, started);
        const reply = await socket.timeout(5000).emitWithAck('scene:pointer', { campaignId: cid, sceneId: scene.id, x, y: 128 });
        const ackMs = performance.now() - started;
        samples.push({ ok: reply.ok === true, rateLimited: reply.error === 'RATE_LIMITED', ackMs });
        if (!reply.ok && reply.error !== 'RATE_LIMITED') throw new Error('Pointer profiling command failed: ' + JSON.stringify(reply));
        await delay(55);
      }
    }));
    const chatAck = [];
    const diceAck = [];
    const mixedCommands = count === 8 ? (async () => {
      let step = 0;
      while (performance.now() - wallStarted < durationMs) {
        const chatStarted = performance.now();
        await send(own, 'Pointer mixed profile ' + String(step));
        chatAck.push(performance.now() - chatStarted);
        const diceStarted = performance.now();
        await roll(own, '1d6+8');
        diceAck.push(performance.now() - diceStarted);
        step++;
        await delay(350);
      }
    })() : Promise.resolve();
    await Promise.all([pointerWorkers, mixedCommands]);
    await delay(150);
    playerWire.off('scene:pointer', onPointer);
    await settle(db);
    let sql = 0;
    let boundaries = 0;
    for (const row of await snapshot(db)) {
      const calls = Number(row.calls) - (before.get(row.query) ?? 0);
      if (/^(begin|commit)\b/iu.test(row.query)) boundaries += calls;
      else sql += calls;
    }
    const cpu = process.cpuUsage(cpuStarted);
    const wallSeconds = (performance.now() - wallStarted) / 1000;
    const apiAfter = readApiProcess();
    const accepted = samples.filter(({ ok }) => ok).length;
    const published = [...received.values()].reduce((sum, value) => sum + value, 0);
    console.log('POINTER_PROFILE', JSON.stringify({
      senders: count, durationSeconds: Number(wallSeconds.toFixed(3)), attemptedPerSecond: Number((samples.length / wallSeconds).toFixed(2)),
      acceptedPerSecond: Number((accepted / wallSeconds).toFixed(2)), publishedPerSecond: Number((published / wallSeconds).toFixed(2)),
      droppedRateLimit: samples.filter(({ rateLimited }) => rateLimited).length, sqlPerAccepted: Number((sql / Math.max(accepted, 1)).toFixed(2)),
      transactionBoundariesPerAccepted: Number((boundaries / Math.max(accepted, 1)).toFixed(2)),
      ackMs: percentiles(samples.filter(({ ok }) => ok).map(({ ackMs }) => ackMs)), receiveMs: percentiles(latencies),
      bytesPerPublished: published ? Number((bytes / published).toFixed(1)) : null,
      generatorCpuPercent: Number((((cpu.user + cpu.system) / 1000) / (wallSeconds * 1000) * 100).toFixed(2)),
      generatorRssMiB: Number((process.memoryUsage().rss / 1048576).toFixed(1)), postgresPoolQueue: 'not exposed by the current application',
      apiCpuPercent: apiBefore && apiAfter ? Number(((apiAfter.cpu - apiBefore.cpu) / wallSeconds * 100).toFixed(2)) : null,
      apiRssMiBBefore: apiBefore?.rssMiB ?? null, apiRssMiBAfter: apiAfter?.rssMiB ?? null,
      mixedChatAckMs: percentiles(chatAck), mixedDiceAckMs: percentiles(diceAck),
    }));
    for (const socket of senders.slice(1)) socket.disconnect();
  }
}

function readApiProcess() {
  const pid = process.env.NRI_PROFILE_API_PID;
  if (!pid || !/^\d+$/u.test(pid)) return null;
  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `$p = Get-Process -Id ${pid} -ErrorAction Stop; [ordered]@{ cpu = $p.CPU; rss = $p.WorkingSet64 } | ConvertTo-Json -Compress`], { encoding: 'utf8' });
    const result = JSON.parse(output);
    return { cpu: Number(result.cpu), rssMiB: Number((result.rss / 1048576).toFixed(1)) };
  } catch { return null; }
}

export async function runProfile({ query, owner, player, own, playerWire, scene, cid, connect, send, roll }) {
  const db = { query };
  const shortText = (index) => 'Profile fixture ' + String(index).padStart(2, '0');
  // Only these sockets are eligible for the measured events in this separate campaign.
  for (const count of [1, 4, 8]) {
    const playerTabs = [];
    const gmTabs = [];
    try {
      for (let i = 1; i < count; i++) playerTabs.push(await connect(player, cid, 'PLAYER'));
      await sample(db, [own, ...playerTabs], 'chat:private', (index) => send(own, shortText(index), player.id));
    } finally {
      for (const socket of playerTabs) socket.disconnect();
    }
    try {
      for (let i = 1; i < count; i++) gmTabs.push(await connect(owner, cid, 'OWNER'));
      await sample(db, [own, ...gmTabs], 'dice:result', () => roll(own, '1d6+8'));
    } finally {
      for (const socket of gmTabs) socket.disconnect();
    }
  }
  await pointerProfile(db, { owner, own, playerWire, scene, cid, connect, send, roll });
}

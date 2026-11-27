import assert from 'node:assert/strict';
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

export async function runProfile({ query, owner, player, own, cid, connect, send, roll }) {
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
}

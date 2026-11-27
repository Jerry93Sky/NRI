import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { io } from 'socket.io-client';

const api = new URL(process.env.NRI_API_URL ?? 'http://127.0.0.1:3005');
const database = new URL(process.env.DATABASE_URL);
assert.equal(process.env.NODE_ENV, 'test');
assert.match(database.pathname, /^\/nri_retry_test$/u, 'Use the isolated RT-RETRY database');
const db = new pg.Pool({ connectionString: database.href });
const sockets = [];
const password = randomUUID();

async function request(path, { method = 'GET', cookie, body, expected = 200 } = {}) {
  const response = await fetch(new URL(path, api), {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = response.status === 204 ? null : await response.json();
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(result)}`);
  const session = response.headers.getSetCookie().find((item) => item.startsWith('nri_session='))?.split(';')[0];
  return { result, cookie: session ?? cookie };
}
async function register(displayName) {
  const { result, cookie } = await request('/api/auth/register', { method: 'POST', expected: 201,
    body: { email: `${randomUUID()}@nri.local`, password, displayName } });
  return { user: result.user, cookie };
}
async function connect(actor, campaignId) {
  const socket = io(api.origin, { autoConnect: false, reconnection: false, transports: ['websocket'], extraHeaders: { cookie: actor.cookie } });
  sockets.push(socket);
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
  assert.equal((await socket.timeout(5000).emitWithAck('campaign:join', campaignId)).ok, true);
  return socket;
}
const send = (socket, event, data, timeout = 5000) => socket.timeout(timeout).emitWithAck(event, data);
async function measure(operation, iterations = 20) {
  const samples = [];
  for (let index = 0; index < iterations; index++) {
    const start = performance.now();
    const elapsed = await operation(index);
    samples.push(typeof elapsed === 'number' ? elapsed : performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return { p50Ms: Number(samples[Math.floor(samples.length * 0.5)].toFixed(2)), p95Ms: Number(samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)].toFixed(2)), samples: samples.length };
}

try {
  const owner = await register('Retry owner');
  const gm = await register('Retry GM');
  const { result: { campaign } } = await request('/api/campaigns', { method: 'POST', cookie: owner.cookie, expected: 201,
    body: { title: `Retry ${randomUUID()}`, description: '' } });
  const invite = (await request('/api/invitations', { method: 'POST', cookie: owner.cookie, expected: 201,
    body: { campaignId: campaign.id, expiresInHours: 1 } })).result;
  await request(`/api/invitations/${invite.invitation}/accept`, { method: 'POST', cookie: gm.cookie, expected: 200 });
  await request(`/api/campaigns/${campaign.id}/members/${gm.user.id}/role`, { method: 'POST', cookie: owner.cookie, expected: 200,
    body: { role: 'GM' } });
  const ownerSocket = await connect(owner, campaign.id);
  const gmSocket = await connect(gm, campaign.id);

  const rolledBackChatId = randomUUID();
  const rolledBackChat = { campaignId: campaign.id, clientMessageId: rolledBackChatId, body: 'Retry after rollback', recipientId: null, testRollbackBeforeCommit: true };
  assert.equal((await send(ownerSocket, 'chat:send', rolledBackChat)).error, 'INTERNAL_ERROR');
  assert.equal((await db.query('SELECT count(*)::int AS count FROM chat_messages WHERE campaign_id=$1 AND client_message_id=$2', [campaign.id, rolledBackChatId])).rows[0].count, 0);
  assert.equal((await send(ownerSocket, 'chat:send', { ...rolledBackChat, testRollbackBeforeCommit: false })).ok, true,
    'a rolled-back chat intent can retry with the original ID');

  const chatId = randomUUID();
  const chatEventIds = [];
  ownerSocket.on('chat:message', (event) => { chatEventIds.push(event.id); });
  const chat = { campaignId: campaign.id, clientMessageId: chatId, body: 'Lost acknowledgment message', recipientId: null, testDropAckAfterCommit: true };
  await assert.rejects(() => send(ownerSocket, 'chat:send', chat, 350), /timed out/i, 'test fault drops first ACK after commit');
  assert.equal((await db.query('SELECT count(*)::int AS count FROM chat_messages WHERE campaign_id=$1 AND client_message_id=$2', [campaign.id, chatId])).rows[0].count, 1);
  const replayChats = await Promise.all(Array.from({ length: 4 }, () => send(ownerSocket, 'chat:send', chat)));
  assert.ok(replayChats.every((ack) => ack.message.id === replayChats[0].message.id));
  assert.equal(replayChats[0].message.body, chat.body);
  assert.equal('requestDigest' in replayChats[0].message, false, 'internal payload digests are not part of the wire result');
  assert.equal((await db.query('SELECT count(*)::int AS count FROM chat_messages WHERE campaign_id=$1 AND client_message_id=$2', [campaign.id, chatId])).rows[0].count, 1);
  const committedChat = (await db.query('SELECT id FROM chat_messages WHERE campaign_id=$1 AND client_message_id=$2', [campaign.id, chatId])).rows[0];
  assert.equal(chatEventIds.includes(committedChat.id), false, 'replay ACK does not rebroadcast the committed chat message');
  assert.equal((await send(ownerSocket, 'chat:send', { ...chat, body: 'Changed payload' })).error, 'CONFLICT');
  await send(ownerSocket, 'chat:send', { campaignId: campaign.id, clientMessageId: randomUUID(), body: chat.body, recipientId: null });
  assert.equal((await db.query('SELECT count(*)::int AS count FROM chat_messages WHERE campaign_id=$1 AND body=$2', [campaign.id, chat.body])).rows[0].count, 2,
    'the same text with a new intention ID is a distinct message');

  const privateId = randomUUID();
  const privateChat = { campaignId: campaign.id, clientMessageId: privateId, body: 'Private retry', recipientId: gm.user.id };
  const privateInitial = await send(ownerSocket, 'chat:send', privateChat);
  assert.equal(privateInitial.ok, true);
  assert.equal((await send(ownerSocket, 'chat:send', privateChat)).message.id, privateInitial.message.id);
  assert.equal((await send(ownerSocket, 'chat:send', { ...privateChat, recipientId: null })).error, 'CONFLICT');

  const diceId = randomUUID();
  const diceEventIds = [];
  ownerSocket.on('dice:result', (event) => { diceEventIds.push(event.id); });
  const dice = { campaignId: campaign.id, requestId: diceId, expression: '3d20+2', hidden: false, testDropAckAfterCommit: true };
  const rolledBackDiceId = randomUUID();
  const rolledBackDice = { campaignId: campaign.id, requestId: rolledBackDiceId, expression: '1d20', hidden: false, testRollbackBeforeCommit: true };
  assert.equal((await send(ownerSocket, 'dice:roll', rolledBackDice)).error, 'INTERNAL_ERROR');
  assert.equal((await db.query('SELECT count(*)::int AS count FROM dice_rolls WHERE campaign_id=$1 AND request_id=$2', [campaign.id, rolledBackDiceId])).rows[0].count, 0);
  assert.equal((await send(ownerSocket, 'dice:roll', { ...rolledBackDice, testRollbackBeforeCommit: false })).ok, true,
    'a rolled-back dice intent can retry with the original ID');
  await assert.rejects(() => send(ownerSocket, 'dice:roll', dice, 350), /timed out/i, 'test fault drops first roll ACK after commit');
  const concurrent = await Promise.all(Array.from({ length: 4 }, () => send(ownerSocket, 'dice:roll', { ...dice, testDropAckAfterCommit: false })));
  assert.ok(concurrent.every((ack) => ack.roll?.id === concurrent[0].roll.id));
  assert.ok(concurrent.every((ack) => JSON.stringify(ack.roll.rolls) === JSON.stringify(concurrent[0].roll.rolls)));
  assert.equal((await db.query('SELECT count(*)::int AS count FROM dice_rolls WHERE campaign_id=$1 AND request_id=$2', [campaign.id, diceId])).rows[0].count, 1);
  assert.equal(diceEventIds.includes(concurrent[0].roll.id), false, 'replay ACK does not broadcast another dice result');
  assert.equal((await send(ownerSocket, 'dice:roll', { ...dice, expression: '1d20', testDropAckAfterCommit: false })).error, 'CONFLICT');

  const chatInitial = await measure(async (index) => {
    await send(ownerSocket, 'chat:send', { campaignId: campaign.id, clientMessageId: randomUUID(), body: `profile chat ${index}`, recipientId: null });
  });
  const chatReplay = await measure(async (index) => {
    const clientMessageId = randomUUID();
    const payload = { campaignId: campaign.id, clientMessageId, body: `profile replay ${index}`, recipientId: null };
    const initial = await send(ownerSocket, 'chat:send', payload);
    const replayStart = performance.now();
    const replay = await send(ownerSocket, 'chat:send', payload);
    assert.equal(replay.message.id, initial.message.id);
    return performance.now() - replayStart;
  });
  const diceInitial = await measure(async () => {
    await send(ownerSocket, 'dice:roll', { campaignId: campaign.id, requestId: randomUUID(), expression: '1d20', hidden: false });
  });
  const diceReplay = await measure(async (index) => {
    const requestId = randomUUID();
    const payload = { campaignId: campaign.id, requestId, expression: '1d20', hidden: false };
    const initial = await send(ownerSocket, 'dice:roll', payload);
    const replayStart = performance.now();
    const replay = await send(ownerSocket, 'dice:roll', payload);
    assert.equal(replay.roll.id, initial.roll.id);
    return performance.now() - replayStart;
  });
  const storage = await db.query(`SELECT
    (SELECT round(avg(pg_column_size(m)))::int FROM chat_messages m WHERE campaign_id=$1) AS chat_avg_row_bytes,
    (SELECT round(avg(pg_column_size(d)))::int FROM dice_rolls d WHERE campaign_id=$1) AS dice_avg_row_bytes`, [campaign.id]);
  console.info(`RT-RETRY loopback profile (${process.platform}, ${process.version}, ${api.origin}): ${JSON.stringify({ chatInitial, chatReplay, diceInitial, diceReplay, averageStoredRowBytes: storage.rows[0] })}`);

  const hiddenId = randomUUID();
  const hidden = await send(gmSocket, 'dice:roll', { campaignId: campaign.id, requestId: hiddenId, expression: '1d20', hidden: true });
  assert.equal(hidden.ok, true);
  const memberMessageId = randomUUID();
  await send(gmSocket, 'chat:send', { campaignId: campaign.id, clientMessageId: memberMessageId, body: 'Member recovery check', recipientId: null });
  await request(`/api/campaigns/${campaign.id}/members/${gm.user.id}/role`, { method: 'POST', cookie: owner.cookie, expected: 200,
    body: { role: 'PLAYER' } });
  assert.equal((await send(gmSocket, 'dice:roll', { campaignId: campaign.id, requestId: hiddenId, expression: '1d20', hidden: true })).error, 'FORBIDDEN',
    'a demoted GM cannot recover a previously hidden result');

  await request(`/api/campaigns/${campaign.id}/members/${gm.user.id}`, { method: 'DELETE', cookie: owner.cookie, expected: 204 });
  assert.equal((await send(gmSocket, 'chat:send', { campaignId: campaign.id, clientMessageId: memberMessageId, body: 'Member recovery check', recipientId: null })).error, 'FORBIDDEN');
  console.info('PASS: RT-RETRY chat/dice loss-after-commit, replay, concurrency, payload conflict, private scope, and role revocation (10 assertions groups).');
} finally {
  for (const socket of sockets) socket.disconnect();
  await db.end();
}

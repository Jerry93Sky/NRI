import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';

const base = process.env.NRI_API_URL ?? 'http://127.0.0.1:3001';
const password = `local-${randomUUID()}-test`;
const openedSockets = [];
async function request(path, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(result)}`);
  return { result, cookie: response.headers.getSetCookie().find((item) => item.startsWith('nri_session='))?.split(';')[0] ?? cookie };
}
async function register(label) {
  const { result, cookie } = await request('/api/auth/register', { method: 'POST', body: { email: `${label}-${randomUUID()}@nri.local`, password, displayName: label } });
  assert.ok(cookie, 'registration must issue an HTTP-only session cookie');
  return { user: result.user, cookie };
}
function connect(cookie) {
  const socket = io(base, { autoConnect: false, transports: ['websocket'], extraHeaders: { cookie } });
  openedSockets.push(socket);
  const connected = new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
    socket.connect();
  });
  return { socket, connected };
}
function join(socket, campaignId) {
  return new Promise((resolve) => socket.emit('campaign:join', campaignId, resolve));
}
function ack(socket, event, value) {
  return new Promise((resolve) => socket.emit(event, value, resolve));
}
function expectEvent(socket, event, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, listener); reject(new Error(`Timed out waiting for ${event}`)); }, timeoutMs);
    const listener = (value) => { clearTimeout(timer); resolve(value); };
    socket.once(event, listener);
  });
}
async function noEvent(socket, event, durationMs = 250) {
  return new Promise((resolve) => {
    let received = false;
    const listener = () => { received = true; };
    socket.once(event, listener);
    setTimeout(() => { socket.off(event, listener); resolve(!received); }, durationMs);
  });
}

const owner = await register('Owner');
const player = await register('Player');
const observer = await register('Observer');
const { result: { campaign } } = await request('/api/campaigns', { method: 'POST', cookie: owner.cookie, body: { title: 'Realtime smoke', description: 'Ephemeral integration test' } });
const { result: invite } = await request('/api/invitations', { method: 'POST', cookie: owner.cookie, body: { campaignId: campaign.id, expiresInHours: 1 } });
for (const participant of [player, observer]) await request(`/api/invitations/${invite.invitation}/accept`, { method: 'POST', cookie: participant.cookie });
const revokedInvite = await request('/api/invitations', { method: 'POST', cookie: owner.cookie, body: { campaignId: campaign.id, expiresInHours: 1 } });
const outsider = await register('Outsider');
await request(`/api/invitations/${revokedInvite.result.id}`, { method: 'DELETE', cookie: owner.cookie });
const revokedAcceptance = await fetch(`${base}/api/invitations/${revokedInvite.result.invitation}/accept`, { method: 'POST', headers: { cookie: outsider.cookie } });
assert.equal(revokedAcceptance.status, 404, 'revoked invitation cannot grant campaign membership');
const roleUpdate = await request(`/api/campaigns/${campaign.id}/members/${observer.user.id}/role`, { method: 'POST', cookie: owner.cookie, body: { role: 'GM' } });
assert.equal(roleUpdate.result.membership.role, 'GM', 'owner can grant a campaign-scoped GM role');
await request(`/api/campaigns/${campaign.id}/members/${observer.user.id}/role`, { method: 'POST', cookie: owner.cookie, body: { role: 'PLAYER' } });
const { result: { scene } } = await request('/api/scenes', { method: 'POST', cookie: owner.cookie, body: { campaignId: campaign.id, title: 'Test scene' } });
assert.equal(scene.isActive, true, 'first scene becomes active for players');
const mapBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lT8AAAAASUVORK5CYII=', 'base64');
const mapForm = new FormData(); mapForm.set('file', new Blob([mapBytes], { type: 'image/png' }), 'original-map.png');
const mapUpload = await fetch(`${base}/api/campaigns/${campaign.id}/assets`, { method: 'POST', headers: { cookie: owner.cookie }, body: mapForm });
assert.equal(mapUpload.status, 201, 'GM can upload a supported map image');
const { asset } = (await mapUpload.json());
const { result: { scene: sceneWithMap } } = await request(`/api/scenes/${scene.id}/background`, { method: 'PUT', cookie: owner.cookie, body: { assetId: asset.id, expectedVersion: scene.version } });
assert.equal(sceneWithMap.backgroundAssetId, asset.id, 'scene persists the map asset reference');
const mapRead = await fetch(`${base}/api/assets/${asset.id}`, { headers: { cookie: player.cookie } });
assert.equal(mapRead.status, 200, 'campaign members can read the scene map');
assert.equal(mapRead.headers.get('content-type'), 'image/png');
assert.deepEqual(Buffer.from(await mapRead.arrayBuffer()), mapBytes, 'the authorized map download matches the uploaded bytes');
const { result: { token: playerToken } } = await request('/api/tokens', { method: 'POST', cookie: owner.cookie, body: { sceneId: scene.id, name: 'Player token', x: 2, y: 3, color: '#c8794a' } });
const { result: assignment } = await request(`/api/tokens/${playerToken.id}/owner`, { method: 'POST', cookie: owner.cookie, body: { ownerUserId: player.user.id } });
const { result: { token: hiddenToken } } = await request('/api/tokens', { method: 'POST', cookie: owner.cookie, body: { sceneId: scene.id, name: 'Hidden GM note', x: 6, y: 2, color: '#886644', hidden: true } });
const { result: playerTokens } = await request(`/api/scenes/${scene.id}/tokens`, { cookie: player.cookie });
const { result: ownerTokens } = await request(`/api/scenes/${scene.id}/tokens`, { cookie: owner.cookie });
assert.equal(playerTokens.some((item) => item.id === hiddenToken.id), false, 'hidden token must not appear in player snapshot');
assert.equal(ownerTokens.some((item) => item.id === hiddenToken.id), true, 'GM snapshot must include hidden token');
const { result: initiative } = await request(`/api/campaigns/${campaign.id}/initiative/start`, { method: 'POST', cookie: owner.cookie, body: { sceneId: scene.id, entries: [{ tokenId: playerToken.id, label: 'Player token', score: 15 }, { tokenId: hiddenToken.id, label: 'Hidden GM note', score: 10 }] } });
assert.equal(initiative.entries.length, 2, 'GM can see all initiative entries');
const { result: playerInitiative } = await request(`/api/campaigns/${campaign.id}/initiative`, { cookie: player.cookie });
assert.equal(playerInitiative.entries.length, 1, 'player receives only visible initiative entries');
let nextInitiative = await request(`/api/campaigns/${campaign.id}/initiative/advance`, { method: 'POST', cookie: owner.cookie, body: { expectedVersion: initiative.tracker.version } });
assert.equal(nextInitiative.result.tracker.round, 1);
const { result: hiddenTurn } = await request(`/api/campaigns/${campaign.id}/initiative`, { cookie: player.cookie });
assert.equal(hiddenTurn.tracker.currentEntryId, null, 'hidden active turns do not reveal their identity');
assert.equal(Object.hasOwn(hiddenTurn.tracker, 'activeIndex'), false, 'player projection does not leak hidden turn index');
nextInitiative = await request(`/api/campaigns/${campaign.id}/initiative/advance`, { method: 'POST', cookie: owner.cookie, body: { expectedVersion: nextInitiative.result.tracker.version } });
assert.equal(nextInitiative.result.tracker.round, 2, 'initiative wraps into the next round');
await request(`/api/campaigns/${campaign.id}/initiative/stop`, { method: 'POST', cookie: owner.cookie, body: { expectedVersion: nextInitiative.result.tracker.version } });

const ownerClient = connect(owner.cookie); const playerClient = connect(player.cookie); const observerClient = connect(observer.cookie);
try {
await Promise.all([ownerClient.connected, playerClient.connected, observerClient.connected]);
for (const client of [ownerClient.socket, playerClient.socket, observerClient.socket]) assert.equal((await join(client, campaign.id)).ok, true);
const ownerMove = expectEvent(ownerClient.socket, 'token:moved');
const observerMove = expectEvent(observerClient.socket, 'token:moved');
const moved = await ack(playerClient.socket, 'token:move', { tokenId: playerToken.id, x: 5, y: 4, expectedVersion: assignment.token.version });
assert.equal(moved.ok, true, 'token owner can move their token');
assert.equal((await ownerMove).x, 5, 'GM receives committed movement');
assert.equal((await observerMove).y, 4, 'other player receives committed movement');
const forgedMove = await ack(observerClient.socket, 'token:move', { tokenId: playerToken.id, x: 9, y: 9, expectedVersion: moved.token.version });
assert.equal(forgedMove.error, 'FORBIDDEN', 'other player cannot move a token they do not own');
const { result: { token: conflictToken } } = await request('/api/tokens', { method: 'POST', cookie: owner.cookie, body: { sceneId: scene.id, name: 'Concurrent token', x: 1, y: 1, color: '#669977' } });
const { result: conflictAssignment } = await request(`/api/tokens/${conflictToken.id}/owner`, { method: 'POST', cookie: owner.cookie, body: { ownerUserId: player.user.id } });
const concurrentMoves = await Promise.all([
  ack(playerClient.socket, 'token:move', { tokenId: conflictToken.id, x: 2, y: 2, expectedVersion: conflictAssignment.token.version }),
  ack(ownerClient.socket, 'token:move', { tokenId: conflictToken.id, x: 8, y: 8, expectedVersion: conflictAssignment.token.version }),
]);
assert.equal(concurrentMoves.filter((result) => result.ok).length, 1, 'exactly one concurrent move commits');
assert.equal(concurrentMoves.filter((result) => result.error === 'CONFLICT').length, 1, 'the stale concurrent move receives a conflict');

const privateToPlayer = expectEvent(playerClient.socket, 'chat:private');
const privateNotToObserver = noEvent(observerClient.socket, 'chat:private');
const privateAck = await ack(ownerClient.socket, 'chat:send', { campaignId: campaign.id, body: 'GM only test note', recipientId: player.user.id });
assert.equal(privateAck.ok, true);
assert.equal((await privateToPlayer).private, true, 'recipient receives the private message');
assert.equal(await privateNotToObserver, true, 'unrelated player does not receive the private message');
const { result: observerHistory } = await request(`/api/campaigns/${campaign.id}/messages`, { cookie: observer.cookie });
assert.equal(observerHistory.some((message) => message.id === privateAck.message.id), false, 'unrelated player history omits the private message');

const rollAck = await ack(playerClient.socket, 'dice:roll', { campaignId: campaign.id, expression: '2d20+1' });
assert.equal(rollAck.ok, true);
assert.equal(rollAck.roll.rolls.length, 2);
assert.ok(rollAck.roll.rolls.every((value) => value >= 1 && value <= 20));

playerClient.socket.disconnect();
const reconnect = new Promise((resolve, reject) => { playerClient.socket.once('connect', resolve); playerClient.socket.once('connect_error', reject); playerClient.socket.connect(); });
await reconnect;
assert.equal((await join(playerClient.socket, campaign.id)).ok, true, 'reconnected client must reauthorize the campaign');
const { result: reconnectTokens } = await request(`/api/scenes/${scene.id}/tokens`, { cookie: player.cookie });
assert.equal(reconnectTokens.find((item) => item.id === playerToken.id).x, 5, 'committed state is present after reconnect');

const { result: { scene: draft } } = await request(`/api/scenes/${scene.id}/duplicate`, { method: 'POST', cookie: owner.cookie });
assert.equal(draft.isActive, false, 'a duplicate scene is created as an inactive draft');
assert.equal(draft.published, false, 'a duplicate scene starts unpublished');
const { result: playerSceneList } = await request(`/api/campaigns/${campaign.id}/scenes`, { cookie: player.cookie });
assert.deepEqual(playerSceneList.map((item) => item.id), [scene.id], 'players only receive the active scene');
const { result: gmSceneList } = await request(`/api/campaigns/${campaign.id}/scenes`, { cookie: owner.cookie });
assert.equal(gmSceneList.some((item) => item.id === draft.id), true, 'GM can prepare draft scenes');
const hiddenDraftTokens = await fetch(`${base}/api/scenes/${draft.id}/tokens`, { headers: { cookie: player.cookie } });
assert.equal(hiddenDraftTokens.status, 404, 'players cannot read tokens from a draft scene');
const { result: { scene: configuredDraft } } = await request(`/api/scenes/${draft.id}`, { method: 'PATCH', cookie: owner.cookie, body: { expectedVersion: draft.version, gridColor: '#aabbcc', gridOpacity: 0.6, gridOffsetX: 2, gridOffsetY: -3, snapToGrid: false, unitsPerCell: 10, unitLabel: 'ft', cameraX: 40, cameraY: 50, cameraZoom: 1.25 } });
assert.equal(configuredDraft.gridColor, '#aabbcc', 'grid settings persist');
assert.equal(configuredDraft.cameraZoom, 1.25, 'camera settings persist');
const staleSettings = await fetch(`${base}/api/scenes/${draft.id}`, { method: 'PATCH', headers: { cookie: owner.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ expectedVersion: draft.version, gridSize: 64 }) });
assert.equal(staleSettings.status, 409, 'stale scene edits are rejected');
const ordered = await request(`/api/campaigns/${campaign.id}/scenes/reorder`, { method: 'PUT', cookie: owner.cookie, body: { scenes: [{ id: draft.id, expectedVersion: configuredDraft.version }, { id: scene.id, expectedVersion: sceneWithMap.version }] } });
assert.deepEqual(ordered.result.map((item) => item.id), [draft.id, scene.id], 'scene ordering is persisted in the submitted order');

const activatedEvent = expectEvent(playerClient.socket, 'scene:activated');
const { result: { scene: activatedDraft } } = await request(`/api/scenes/${draft.id}/activate`, { method: 'PUT', cookie: owner.cookie, body: { expectedVersion: ordered.result[0].version } });
assert.equal((await activatedEvent).sceneId, draft.id, 'players receive the new active scene notification');
const { result: activePlayerScenes } = await request(`/api/campaigns/${campaign.id}/scenes`, { cookie: player.cookie });
assert.deepEqual(activePlayerScenes.map((item) => item.id), [draft.id], 'players only see the newly active scene');
const oldSceneTokens = await fetch(`${base}/api/scenes/${scene.id}/tokens`, { headers: { cookie: player.cookie } });
assert.equal(oldSceneTokens.status, 404, 'players cannot read tokens from the previous active scene');
const oldSceneMove = await ack(playerClient.socket, 'token:move', { tokenId: playerToken.id, x: 7, y: 7, expectedVersion: moved.token.version });
assert.equal(oldSceneMove.error, 'FORBIDDEN', 'players cannot move tokens on inactive scenes');
const archivedDraft = await request(`/api/scenes/${draft.id}/archive`, { method: 'PUT', cookie: owner.cookie, body: { expectedVersion: activatedDraft.version } });
assert.equal(archivedDraft.result.scene.isActive, false, 'archiving an active scene deactivates it');
const archivedTokenCreate = await fetch(`${base}/api/tokens`, { method: 'POST', headers: { cookie: owner.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ sceneId: draft.id, name: 'No archived edits', x: 0, y: 0, color: '#aabbcc' }) });
assert.equal(archivedTokenCreate.status, 404, 'managers cannot add tokens to archived scenes');
const fallbackScenes = await request(`/api/campaigns/${campaign.id}/scenes`, { cookie: player.cookie });
assert.deepEqual(fallbackScenes.result.map((item) => item.id), [scene.id], 'archiving active scene returns players to the previous published scene');
const archivedList = await request(`/api/campaigns/${campaign.id}/scenes?archived=true`, { cookie: owner.cookie });
assert.equal(archivedList.result.some((item) => item.id === draft.id), true, 'GM can recover archived scenes');
const restoredDraft = await request(`/api/scenes/${draft.id}/restore`, { method: 'PUT', cookie: owner.cookie, body: { expectedVersion: archivedDraft.result.scene.version } });
assert.equal(restoredDraft.result.scene.isActive, false, 'restored scenes remain drafts until explicitly activated');

await request(`/api/campaigns/${campaign.id}/archive`, { method: 'PUT', cookie: owner.cookie });
const activeCampaigns = await request('/api/campaigns', { cookie: owner.cookie });
const archivedCampaigns = await request('/api/campaigns?archived=true', { cookie: owner.cookie });
assert.equal(activeCampaigns.result.some((item) => item.campaign.id === campaign.id), false, 'archived campaign leaves the active list');
assert.equal(archivedCampaigns.result.some((item) => item.campaign.id === campaign.id), true, 'owner can list archived campaigns for recovery');
await request(`/api/campaigns/${campaign.id}/restore`, { method: 'PUT', cookie: owner.cookie });
const removedEvent = expectEvent(observerClient.socket, 'membership:removed');
await request(`/api/campaigns/${campaign.id}/members/${observer.user.id}`, { method: 'DELETE', cookie: owner.cookie });
assert.equal((await removedEvent).campaignId, campaign.id, 'removed member receives a revocation notice on their personal room');
const noRevokedDice = noEvent(observerClient.socket, 'dice:result', 350);
assert.equal((await ack(ownerClient.socket, 'dice:roll', { campaignId: campaign.id, expression: '1d20' })).ok, true);
assert.equal(await noRevokedDice, true, 'removed member no longer receives campaign events');

} finally { for (const socket of openedSockets) socket.disconnect(); }
console.info('PASS: auth sessions, invitations, scoped roles, archive recovery, map ACL, hidden snapshots, token ownership, concurrent move conflicts, private messages, server dice, reconnect recovery, scene draft privacy, settings/version conflicts, reordering, activation, fallback, restore, and socket revocation.');

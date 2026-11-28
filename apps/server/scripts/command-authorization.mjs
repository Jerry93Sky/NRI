import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { io } from 'socket.io-client';

const api = new URL(process.env.NRI_API_URL ?? 'http://127.0.0.1:3000');
const database = new URL(process.env.DATABASE_URL);
assert.equal(process.env.NODE_ENV, 'test');
for (const url of [api, database]) assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Use isolated local services');
assert.match(database.pathname, /^\/nri_(?:test|command_test)$/u, 'Use a dedicated CMD-ACL test database');
const uploadDir = resolve(process.env.UPLOAD_DIR ?? 'apps/server/uploads');
assert.ok(uploadDir.includes('.data') || process.env.CI === 'true', 'Use isolated upload storage');
const db = new pg.Pool({ connectionString: database.href, query_timeout: 7000 });
const sockets = [];
const packets = [];
const timeout = 7000;
const password = randomUUID();
let passed = 0;

async function scenario(name, run) { await run(); console.log(`PASS ${++passed} ${name}`); }
async function request(path, method, actor, body, expected = 200, extraHeaders = {}) {
  const response = await fetch(new URL(path, api), {
    method, signal: AbortSignal.timeout(timeout + 2500),
    headers: { ...(actor ? { cookie: actor.cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...extraHeaders },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = response.status === 204 ? null : await response.json().catch(() => null);
  const allowed = Array.isArray(expected) ? expected : [expected];
  assert.ok(allowed.includes(response.status), `${method} ${path} returned ${response.status}: ${JSON.stringify(result)}`);
  const cookie = response.headers.getSetCookie().find((entry) => entry.startsWith('nri_session='))?.split(';')[0];
  return { result, cookie, response };
}
async function register(displayName) {
  const { result, cookie } = await request('/api/auth/register', 'POST', null,
    { email: `${randomUUID()}@nri.local`, displayName, password }, 201);
  assert.ok(cookie);
  return { id: result.user.id, cookie };
}
async function waitForBlockedQuery(fragment) {
  const end = Date.now() + timeout - 500;
  while (Date.now() < end) {
    const { rows } = await db.query(`SELECT pid, query, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
      WHERE datname = current_database() AND state = 'active' AND cardinality(pg_blocking_pids(pid)) > 0`);
    if (rows.length) return rows[0];
    await delay(15);
  }
  assert.fail(`No PostgreSQL lock wait observed for ${fragment}`);
}
async function connect(actor, campaignId) {
  const socket = io(api.origin, { autoConnect: false, reconnection: false, transports: ['websocket'], extraHeaders: { cookie: actor.cookie } });
  sockets.push(socket);
  socket.onAny((name, data) => { if (name.startsWith('token:') || name.startsWith('scene:')) packets.push({ name, data, at: performance.now() }); });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
  const joined = await socket.timeout(timeout).emitWithAck('campaign:join', campaignId);
  assert.equal(joined.ok, true);
  return socket;
}
const auditCount = async (action, targetId) => (await db.query('SELECT count(*)::int AS n FROM audit_events WHERE action = $1 AND target_id = $2', [action, targetId])).rows[0].n;
const tokenRow = async (id) => (await db.query('SELECT id, name, version, resources, owner_user_id, hidden FROM tokens WHERE id = $1', [id])).rows[0];

try {
  const owner = await register('CMD Owner');
  const player = await register('CMD Player');
  const secondPlayer = await register('CMD Second Player');
  const { result: { campaign } } = await request('/api/campaigns', 'POST', owner, { title: `CMD-${randomUUID().slice(0, 8)}`, description: '' }, 201);
  const { result: { scene } } = await request('/api/scenes', 'POST', owner, { campaignId: campaign.id, title: 'CMD scene' }, 201);
  const { result: { token } } = await request('/api/tokens', 'POST', owner, { sceneId: scene.id, name: 'CMD token', x: 2, y: 3, color: '#c8794a' }, 201);
  const ownerSocket = await connect(owner, campaign.id);

  await scenario('campaign creation records Owner membership and audit in the same committed state', async () => {
    const { rows } = await db.query(`SELECT c.id, m.role, count(a.id)::int AS audits FROM campaigns c
      JOIN campaign_memberships m ON m.campaign_id = c.id AND m.user_id = c.owner_id
      LEFT JOIN audit_events a ON a.campaign_id = c.id AND a.action = 'campaign.created'
      WHERE c.id = $1 GROUP BY c.id, m.role`, [campaign.id]);
    assert.equal(rows[0].role, 'OWNER'); assert.equal(rows[0].audits, 1);
  });

  await scenario('campaign audit failure rolls back both campaign and Owner membership', async () => {
    const title = `CMD audit rollback ${randomUUID().slice(0, 8)}`;
    await db.query(`CREATE OR REPLACE FUNCTION nri_cmd_acl_fail_campaign_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action = 'campaign.created' THEN RAISE EXCEPTION 'cmd acl campaign audit fault'; END IF; RETURN NEW; END $$`);
    await db.query('CREATE TRIGGER nri_cmd_acl_fail_campaign_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION nri_cmd_acl_fail_campaign_audit()');
    try {
      await request('/api/campaigns', 'POST', owner, { title, description: '' }, 500);
      const { rows } = await db.query('SELECT count(*)::int AS n FROM campaigns WHERE title = $1', [title]);
      assert.equal(rows[0].n, 0);
    } finally {
      await db.query('DROP TRIGGER IF EXISTS nri_cmd_acl_fail_campaign_audit ON audit_events');
      await db.query('DROP FUNCTION IF EXISTS nri_cmd_acl_fail_campaign_audit()');
    }
  });

  await scenario('concurrent resource adjustments serialize on the expected token version', async () => {
    await db.query('UPDATE tokens SET resources = $2, version = 1 WHERE id = $1', [token.id, JSON.stringify([{ label: 'HP', current: 2, maximum: 5, visible: true }, { label: 'MP', current: 0, maximum: 0, visible: false }])]);
    const body = { resourceIndex: 0, delta: 1, expectedVersion: 1 };
    const responses = await Promise.all([
      request(`/api/tokens/${token.id}/resources/adjust`, 'POST', owner, body, [200, 409]),
      request(`/api/tokens/${token.id}/resources/adjust`, 'POST', owner, body, [200, 409]),
    ]);
    assert.equal(responses.filter((item) => item?.response?.status === 200).length, 1);
    assert.equal(responses.filter((item) => item?.response?.status === 409).length, 1);
    const current = await tokenRow(token.id);
    assert.equal(current.version, 2); assert.equal(current.resources[0].current, 3);
    assert.equal(await auditCount('token.resource_adjusted', token.id), 1);
  });

  await scenario('stale token version rejects without a second write or audit', async () => {
    const before = await tokenRow(token.id); const audits = await auditCount('token.updated', token.id);
    await request(`/api/tokens/${token.id}`, 'PATCH', owner, { expectedVersion: 1, name: 'stale edit' }, 409);
    assert.equal((await tokenRow(token.id)).version, before.version);
    assert.equal(await auditCount('token.updated', token.id), audits);
  });

  await scenario('single and group token copies use fresh IDs and reject a partial group atomically', async () => {
    const baseline = await db.query('SELECT count(*)::int AS n FROM tokens WHERE scene_id = $1', [scene.id]);
    const duplicateBody = { sceneId: scene.id, expectedVersion: (await tokenRow(token.id)).version, x: 7, y: 8 };
    const copies = await Promise.all([
      request(`/api/tokens/${token.id}/duplicate`, 'POST', owner, duplicateBody, 201),
      request(`/api/tokens/${token.id}/duplicate`, 'POST', owner, duplicateBody, 201),
    ]);
    assert.notEqual(copies[0].result.token.id, copies[1].result.token.id);
    const groupInput = { sceneId: scene.id, tokens: [{ tokenId: token.id, expectedVersion: duplicateBody.expectedVersion, x: 9, y: 10 }] };
    const partial = await request(`/api/scenes/${scene.id}/tokens/duplicate`, 'POST', owner,
      { ...groupInput, tokens: [...groupInput.tokens, { tokenId: randomUUID(), expectedVersion: 1, x: 4, y: 4 }] }, 404);
    assert.equal(partial.result.error, 'NOT_FOUND');
    const after = await db.query('SELECT count(*)::int AS n FROM tokens WHERE scene_id = $1', [scene.id]);
    assert.equal(after.rows[0].n, baseline.rows[0].n + 2);
  });

  await scenario('duplicate invitation acceptance is idempotent under concurrent requests', async () => {
    const { result: invite } = await request('/api/invitations', 'POST', owner, { campaignId: campaign.id, expiresInHours: 1 }, 201);
    const responses = await Promise.all([
      request(`/api/invitations/${invite.invitation}/accept`, 'POST', player, {}),
      request(`/api/invitations/${invite.invitation}/accept`, 'POST', player, {}),
    ]);
    assert.deepEqual(responses.map(({ result }) => result.campaignId), [campaign.id, campaign.id]);
    const { rows } = await db.query(`SELECT i.uses, count(m.user_id)::int AS members FROM campaign_invitations i
      LEFT JOIN campaign_memberships m ON m.campaign_id = i.campaign_id AND m.user_id = $2
      WHERE i.id = $1 GROUP BY i.uses`, [invite.id, player.id]);
    assert.equal(rows[0].uses, 1); assert.equal(rows[0].members, 1);
    assert.equal(await auditCount('invitation.accepted', invite.id), 1);
  });

  await scenario('invitation revoke wins before accept and leaves membership unchanged', async () => {
    const { result: invite } = await request('/api/invitations', 'POST', owner, { campaignId: campaign.id, expiresInHours: 1 }, 201);
    await request(`/api/invitations/${invite.id}`, 'DELETE', owner, undefined, 204);
    await request(`/api/invitations/${invite.invitation}/accept`, 'POST', secondPlayer, {}, 404);
    const { rows } = await db.query('SELECT count(*)::int AS n FROM campaign_memberships WHERE campaign_id = $1 AND user_id = $2', [campaign.id, secondPlayer.id]);
    assert.equal(rows[0].n, 0);
  });

  await scenario('expired invitations cannot be consumed or create membership', async () => {
    const invitee = await register('CMD expired invitee');
    const { result: invite } = await request('/api/invitations', 'POST', owner, { campaignId: campaign.id, expiresInHours: 1 }, 201);
    await db.query("UPDATE campaign_invitations SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [invite.id]);
    const response = await request(`/api/invitations/${invite.invitation}/accept`, 'POST', invitee, {}, 404);
    assert.equal(response.result.error, 'INVITATION_INVALID');
    const { rows } = await db.query('SELECT uses, accepted_at FROM campaign_invitations WHERE id = $1', [invite.id]);
    assert.equal(rows[0].uses, 0); assert.equal(rows[0].accepted_at, null);
    const { rows: memberRows } = await db.query('SELECT count(*)::int AS n FROM campaign_memberships WHERE campaign_id = $1 AND user_id = $2', [campaign.id, invitee.id]);
    assert.equal(memberRows[0].n, 0);
  });

  await scenario('invitation creator demotion before acceptance invalidates the invitation', async () => {
    const { result: membershipInvite } = await request('/api/invitations', 'POST', owner, { campaignId: campaign.id, expiresInHours: 1 }, 201);
    await request(`/api/invitations/${membershipInvite.invitation}/accept`, 'POST', secondPlayer, {});
    await request(`/api/campaigns/${campaign.id}/members/${secondPlayer.id}/role`, 'POST', owner, { role: 'GM' });
    const { result: invite } = await request('/api/invitations', 'POST', secondPlayer, { campaignId: campaign.id, expiresInHours: 1 }, 201);
    await request(`/api/campaigns/${campaign.id}/members/${secondPlayer.id}/role`, 'POST', owner, { role: 'PLAYER' });
    const invitee = await register('CMD demoted creator invitee');
    const response = await request(`/api/invitations/${invite.invitation}/accept`, 'POST', invitee, {}, 404);
    assert.equal(response.result.error, 'INVITATION_INVALID');
    const { rows } = await db.query('SELECT uses FROM campaign_invitations WHERE id = $1', [invite.id]);
    assert.equal(rows[0].uses, 0);
  });

  await scenario('member demotion that commits before a blocked campaign command is rechecked', async () => {
    const { result: invite } = await request('/api/invitations', 'POST', owner, { campaignId: campaign.id, expiresInHours: 1 }, 201);
    await request(`/api/invitations/${invite.invitation}/accept`, 'POST', secondPlayer, {});
    await request(`/api/campaigns/${campaign.id}/members/${secondPlayer.id}/role`, 'POST', owner, { role: 'GM' });
    const blocker = await db.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT user_id FROM campaign_memberships WHERE campaign_id = $1 AND user_id = $2 FOR UPDATE', [campaign.id, secondPlayer.id]);
      const pending = request(`/api/campaigns/${campaign.id}/player-drawing`, 'PUT', secondPlayer, { enabled: true }, [200, 403]);
      await waitForBlockedQuery('campaign_memberships');
      await blocker.query("UPDATE campaign_memberships SET role = 'PLAYER' WHERE campaign_id = $1 AND user_id = $2", [campaign.id, secondPlayer.id]);
      await blocker.query('COMMIT');
      const outcome = await pending;
      assert.equal(outcome.response?.status, 403);
    } finally { await blocker.query('ROLLBACK').catch(() => {}); blocker.release(); }
  });

  await scenario('owner reassignment accepts only current campaign members', async () => {
    const { result: assignment } = await request(`/api/tokens/${token.id}/owner`, 'POST', owner, { ownerUserId: secondPlayer.id });
    assert.equal(assignment.token.ownerUserId, secondPlayer.id);
    assert.equal(await auditCount('token.owner_changed', token.id), 1);
    const outsider = await register('CMD outsider');
    const invalid = await request(`/api/tokens/${token.id}/owner`, 'POST', owner, { ownerUserId: outsider.id }, 400);
    assert.equal(invalid.result.error, 'INVALID_OWNER');
    assert.equal((await tokenRow(token.id)).owner_user_id, secondPlayer.id);
  });

  await scenario('expired session and archived campaign are rejected before writes', async () => {
    const tokenHash = createHash('sha256').update(secondPlayer.cookie.split('=')[1]).digest('hex');
    await db.query('UPDATE user_sessions SET expires_at = clock_timestamp() - interval \'1 second\' WHERE token_hash = $1', [tokenHash]);
    await request(`/api/campaigns/${campaign.id}/token-trash`, 'GET', secondPlayer, undefined, 401);
    await request('/api/campaigns', 'GET', secondPlayer, undefined, 401);
    const { result: { campaign: archived } } = await request('/api/campaigns', 'POST', owner, { title: `CMD archive ${randomUUID().slice(0, 8)}`, description: '' }, 201);
    await db.query('UPDATE campaigns SET archived_at = clock_timestamp() WHERE id = $1', [archived.id]);
    const { rows: [before] } = await db.query('SELECT players_can_draw FROM campaigns WHERE id = $1', [archived.id]);
    await request(`/api/campaigns/${archived.id}/player-drawing`, 'PUT', owner, { enabled: true }, 403);
    const { rows: [after] } = await db.query('SELECT players_can_draw FROM campaigns WHERE id = $1', [archived.id]);
    assert.equal(after.players_can_draw, before.players_can_draw);
  });

  await scenario('logout that commits before a blocked token write invalidates the command session', async () => {
    const cookieValue = player.cookie.split('=')[1];
    const tokenHash = createHash('sha256').update(cookieValue).digest('hex');
    const blocker = await db.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT token_hash FROM user_sessions WHERE token_hash = $1 FOR UPDATE', [tokenHash]);
      const pending = request(`/api/tokens/${token.id}`, 'PATCH', player, { expectedVersion: (await tokenRow(token.id)).version, name: 'after logout' }, [200, 401]);
      await waitForBlockedQuery('user_sessions');
      await blocker.query('DELETE FROM user_sessions WHERE token_hash = $1', [tokenHash]);
      await blocker.query('COMMIT');
      const outcome = await pending;
      assert.equal(outcome.response?.status, 401);
      assert.notEqual((await tokenRow(token.id)).name, 'after logout');
    } finally { await blocker.query('ROLLBACK').catch(() => {}); blocker.release(); }
  });

  await scenario('audit failure rolls token creation back and emits no token packet', async () => {
    const beforePackets = packets.length;
    await db.query(`CREATE OR REPLACE FUNCTION nri_cmd_acl_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action = 'token.created' THEN RAISE EXCEPTION 'cmd acl audit fault'; END IF; RETURN NEW; END $$`);
    await db.query('CREATE TRIGGER nri_cmd_acl_fail_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION nri_cmd_acl_fail_audit()');
    try {
      await request('/api/tokens', 'POST', owner, { sceneId: scene.id, name: 'must rollback', x: 8, y: 9, color: '#c8794a' }, 500);
      const { rows } = await db.query("SELECT count(*)::int AS n FROM tokens WHERE scene_id = $1 AND name = 'must rollback'", [scene.id]);
      assert.equal(rows[0].n, 0);
      assert.equal(packets.slice(beforePackets).some(({ name }) => name === 'token:created'), false);
    } finally {
      await db.query('DROP TRIGGER IF EXISTS nri_cmd_acl_fail_audit ON audit_events');
      await db.query('DROP FUNCTION IF EXISTS nri_cmd_acl_fail_audit()');
    }
  });

  await scenario('asset failures at each staged/SQL/rename boundary compensate files and metadata', async () => {
    const before = await db.query('SELECT count(*)::int AS n FROM assets WHERE campaign_id = $1', [campaign.id]);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const filesBefore = new Set(await readdir(uploadDir).catch(() => []));
    for (const stage of ['after-thumbnail-generation', 'after-original-stage', 'after-thumbnail-stage', 'after-db-insert', 'before-file-rename', 'after-original-rename', 'after-thumbnail-rename']) {
      const form = new FormData(); form.append('file', new Blob([png], { type: 'image/png' }), `cmd-acl-${stage}.png`);
      const response = await fetch(new URL(`/api/campaigns/${campaign.id}/assets?category=MAP`, api), {
        method: 'POST', headers: { cookie: owner.cookie, 'x-nri-test-asset-fault': stage }, body: form,
      });
      assert.equal(response.status, 500, `Expected injected failure at ${stage}`);
    }
    const after = await db.query('SELECT count(*)::int AS n FROM assets WHERE campaign_id = $1', [campaign.id]);
    assert.equal(after.rows[0].n, before.rows[0].n);
    const filesAfter = await readdir(uploadDir).catch(() => []);
    assert.deepEqual(filesAfter.filter((name) => !filesBefore.has(name)), []);
  });

  await scenario('asset upload rechecks manager role after staging when demotion wins the lock race', async () => {
    const uploader = await register('CMD upload demotion');
    const { result: invite } = await request('/api/invitations', 'POST', owner, { campaignId: campaign.id, expiresInHours: 1 }, 201);
    await request(`/api/invitations/${invite.invitation}/accept`, 'POST', uploader, {});
    await request(`/api/campaigns/${campaign.id}/members/${uploader.id}/role`, 'POST', owner, { role: 'GM' });
    const countBefore = (await db.query('SELECT count(*)::int AS n FROM assets WHERE campaign_id = $1', [campaign.id])).rows[0].n;
    const filesBefore = new Set(await readdir(uploadDir).catch(() => []));
    const blocker = await db.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT user_id FROM campaign_memberships WHERE campaign_id = $1 AND user_id = $2 FOR UPDATE', [campaign.id, uploader.id]);
      const form = new FormData();
      form.append('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), 'role-race.png');
      const pending = fetch(new URL(`/api/campaigns/${campaign.id}/assets?category=MAP`, api), { method: 'POST', headers: { cookie: uploader.cookie }, body: form });
      await waitForBlockedQuery('campaign_memberships');
      await blocker.query("UPDATE campaign_memberships SET role = 'PLAYER' WHERE campaign_id = $1 AND user_id = $2", [campaign.id, uploader.id]);
      await blocker.query('COMMIT');
      const response = await pending;
      assert.equal(response.status, 403);
      const afterCount = (await db.query('SELECT count(*)::int AS n FROM assets WHERE campaign_id = $1', [campaign.id])).rows[0].n;
      assert.equal(afterCount, countBefore);
      const filesAfter = await readdir(uploadDir).catch(() => []);
      assert.deepEqual(filesAfter.filter((name) => !filesBefore.has(name)), []);
    } finally { await blocker.query('ROLLBACK').catch(() => {}); blocker.release(); }
  });

  await scenario('asset upload rechecks campaign state after staging when archive wins the lock race', async () => {
    const { result: { campaign: uploadCampaign } } = await request('/api/campaigns', 'POST', owner, { title: `CMD upload archive ${randomUUID().slice(0, 8)}`, description: '' }, 201);
    const filesBefore = new Set(await readdir(uploadDir).catch(() => []));
    const blocker = await db.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM campaigns WHERE id = $1 FOR UPDATE', [uploadCampaign.id]);
      const form = new FormData();
      form.append('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), 'archive-race.png');
      const pending = fetch(new URL(`/api/campaigns/${uploadCampaign.id}/assets?category=MAP`, api), { method: 'POST', headers: { cookie: owner.cookie }, body: form });
      await waitForBlockedQuery('campaigns');
      await blocker.query('UPDATE campaigns SET archived_at = clock_timestamp() WHERE id = $1', [uploadCampaign.id]);
      await blocker.query('COMMIT');
      const response = await pending;
      assert.equal(response.status, 403);
      const { rows } = await db.query('SELECT count(*)::int AS n FROM assets WHERE campaign_id = $1', [uploadCampaign.id]);
      assert.equal(rows[0].n, 0);
      const filesAfter = await readdir(uploadDir).catch(() => []);
      assert.deepEqual(filesAfter.filter((name) => !filesBefore.has(name)), []);
    } finally { await blocker.query('ROLLBACK').catch(() => {}); blocker.release(); }
  });

  await scenario('committed token creation publishes only after its audit row is visible', async () => {
    const { result: { token: created } } = await request('/api/tokens', 'POST', owner, { sceneId: scene.id, name: 'published after commit', x: 11, y: 12, color: '#c8794a' }, 201);
    const end = Date.now() + timeout;
    while (Date.now() < end && !packets.some(({ name, data }) => name === 'token:created' && data.id === created.id)) await delay(15);
    assert.equal(packets.some(({ name, data }) => name === 'token:created' && data.id === created.id), true);
    assert.equal(await auditCount('token.created', created.id), 1);
  });

  await scenario('hidden asset original and thumbnail are denied to a Player', async () => {
    const form = new FormData();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    form.append('file', new Blob([png], { type: 'image/png' }), 'hidden.png');
    const upload = await fetch(new URL(`/api/campaigns/${campaign.id}/assets?category=TOKEN`, api), { method: 'POST', headers: { cookie: owner.cookie }, body: form });
    assert.equal(upload.status, 201);
    const { asset } = await upload.json();
    const { result: { token: hidden } } = await request('/api/tokens', 'POST', owner,
      { sceneId: scene.id, name: 'hidden asset token', x: 1, y: 1, color: '#c8794a', imageAssetId: asset.id, hidden: true }, 201);
    const reader = await register('CMD media reader');
    const { result: invite } = await request('/api/invitations', 'POST', owner, { campaignId: campaign.id, expiresInHours: 1 }, 201);
    await request(`/api/invitations/${invite.invitation}/accept`, 'POST', reader, {});
    for (const path of [`/api/assets/${asset.id}`, `/api/assets/${asset.id}?variant=thumbnail`]) {
      const response = await fetch(new URL(path, api), { headers: { cookie: reader.cookie } });
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: 'NOT_FOUND' });
    }
    const foreignReader = await register('CMD foreign media reader');
    await request('/api/campaigns', 'POST', foreignReader, { title: 'Foreign media campaign', description: '' }, 201);
    for (const path of [`/api/assets/${asset.id}`, `/api/assets/${asset.id}?variant=thumbnail`]) {
      const response = await fetch(new URL(path, api), { headers: { cookie: foreignReader.cookie } });
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: 'NOT_FOUND' });
    }
    await db.query('DELETE FROM tokens WHERE id = $1', [hidden.id]);
  });

  await scenario('representative local HTTP and event profile captures five samples per operation', async () => {
    const samples = new Map();
    const measure = async (name, operation) => {
      const values = [];
      for (let index = 0; index < 5; index++) {
        const start = performance.now();
        await operation(index, start);
        values.push(performance.now() - start);
      }
      samples.set(name, values);
    };
    const readToken = async () => tokenRow(token.id);
    await db.query('UPDATE tokens SET resources = $2 WHERE id = $1', [token.id, JSON.stringify([{ label: 'HP', current: 50, maximum: 100, visible: true }, { label: 'MP', current: 0, maximum: 0, visible: false }])]);
    await measure('token.create', async (index, started) => {
      const { result: { token: created } } = await request('/api/tokens', 'POST', owner,
        { sceneId: scene.id, name: `profile token ${index}`, x: index, y: index, color: '#c8794a' }, 201);
      const end = Date.now() + timeout;
      while (Date.now() < end && !packets.some(({ name, data }) => name === 'token:created' && data.id === created.id)) await delay(5);
      const packet = packets.find(({ name, data }) => name === 'token:created' && data.id === created.id);
      assert.ok(packet);
      samples.set('token.create.event_delivery', [...(samples.get('token.create.event_delivery') ?? []), packet.at - started]);
    });
    await measure('token.group_duplicate', async () => {
      const { rows: sources } = await db.query(`SELECT id,version FROM tokens WHERE scene_id = $1 AND id <> $2 ORDER BY id LIMIT 3`, [scene.id, token.id]);
      const ids = [{ id: token.id, version: (await readToken()).version }, ...sources.map((row) => ({ id: row.id, version: row.version }))].slice(0, 3);
      const response = await request(`/api/scenes/${scene.id}/tokens/duplicate`, 'POST', owner,
        { sceneId: scene.id, tokens: ids.map((item, i) => ({ tokenId: item.id, expectedVersion: item.version, x: i + 20, y: i + 21 })) }, 201);
      assert.equal(response.result.tokens.length, ids.length);
    });
    await measure('token.resource_adjust', async (index) => {
      const current = await readToken();
      const response = await request(`/api/tokens/${token.id}/resources/adjust`, 'POST', owner,
        { resourceIndex: 0, delta: index % 2 ? -1 : 1, expectedVersion: current.version }, 200);
      assert.equal(response.result.token.version, current.version + 1);
    });
    await measure('scene.duplicate', async () => {
      const response = await request(`/api/scenes/${scene.id}/duplicate`, 'POST', owner, undefined, 201);
      assert.ok(response.result.scene.id);
    });
    await measure('campaign.duplicate', async () => {
      const response = await request(`/api/campaigns/${campaign.id}/duplicate`, 'POST', owner, undefined, 201);
      assert.ok(response.result.campaign.id);
    });
    const formForImage = () => {
      const form = new FormData();
      form.append('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), 'profile.png');
      return form;
    };
    const upload = await fetch(new URL(`/api/campaigns/${campaign.id}/assets?category=MAP`, api), { method: 'POST', headers: { cookie: owner.cookie }, body: formForImage() });
    assert.equal(upload.status, 201);
    const { asset } = await upload.json();
    await measure('asset.protected_read', async () => {
      const response = await fetch(new URL(`/api/assets/${asset.id}`, api), { headers: { cookie: owner.cookie } });
      assert.equal(response.status, 200); await response.arrayBuffer();
    });
    await measure('asset.upload', async (index) => {
      const response = await fetch(new URL(`/api/campaigns/${campaign.id}/assets?category=MAP`, api), { method: 'POST', headers: { cookie: owner.cookie }, body: formForImage() });
      assert.equal(response.status, 201, `upload sample ${index}`);
    });
    const sorted = (values) => [...values].sort((a, b) => a - b);
    for (const [name, values] of samples) {
      const ordered = sorted(values);
      const p = (fraction) => ordered[Math.ceil(fraction * ordered.length) - 1];
      console.log(`PROFILE ${JSON.stringify({ operation: name, samples: values.length, p50Ms: Number(p(0.5).toFixed(2)), p95Ms: Number(p(0.95).toFixed(2)) })}`);
    }
    const [{ version }] = (await db.query('SELECT version FROM scenes WHERE id = $1', [scene.id])).rows;
    assert.ok(version >= scene.version);
  });

  console.log(`CMD-ACL PostgreSQL regressions passed: ${passed}`);
} finally {
  for (const socket of sockets) socket.disconnect();
  await db.end();
}

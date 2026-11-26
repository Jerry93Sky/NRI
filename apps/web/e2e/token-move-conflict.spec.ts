import { expect, test } from '@playwright/test';
import { io, type Socket } from 'socket.io-client';

async function requestJson(page: import('@playwright/test').Page, path: string, method = 'GET', body?: unknown) {
  return page.evaluate(async ({ path, method, body }) => {
    const response = await fetch(path, {
      method,
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  }, { path, method, body });
}

async function register(page: import('@playwright/test').Page, name: string, email: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Display name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('e2e-test-password-24');
  await page.getByRole('button', { name: 'Create account', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Your campaigns' })).toBeVisible();
}

async function connectedSocket(page: import('@playwright/test').Page, webBase: string): Promise<Socket> {
  const cookies = await page.context().cookies(webBase);
  const cookie = cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
  const socket = io(webBase, { transports: ['websocket'], reconnection: false, extraHeaders: { cookie, origin: webBase } });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return socket;
}

function joinCampaign(socket: Socket, campaignId: string) {
  return new Promise<void>((resolve, reject) => socket.emit('campaign:join', campaignId, (result: { ok?: boolean; error?: string }) => {
    if (result.ok) resolve(); else reject(new Error(result.error ?? 'CAMPAIGN_JOIN_FAILED'));
  }));
}

function move(socket: Socket, payload: { tokenId: string; x: number; y: number; expectedVersion: number }) {
  return new Promise<{ ok?: boolean; error?: string; token?: { id: string; x: number; y: number; version: number } }>((resolve) => {
    socket.emit('token:move', payload, resolve);
  });
}

test('simultaneous GM and owner moves resolve one stale version in two browser sessions', async ({ browser }) => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const webBase = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4175';
  const gmContext = await browser.newContext({ locale: 'en-US' });
  const playerContext = await browser.newContext({ locale: 'en-US' });
  const gmPage = await gmContext.newPage();
  const playerPage = await playerContext.newPage();
  let gmSocket: Socket | undefined;
  let playerSocket: Socket | undefined;
  try {
    await register(gmPage, 'Conflict Guide', `move-conflict-gm-${suffix}@example.test`);
    const campaignResponse = await requestJson(gmPage, '/api/campaigns', 'POST', { title: `Move conflict ${suffix}`, description: '' });
    expect(campaignResponse.status).toBe(201);
    const campaignId = (campaignResponse.body as { campaign: { id: string } }).campaign.id;
    const sceneResponse = await requestJson(gmPage, '/api/scenes', 'POST', { campaignId, title: 'Shared table' });
    expect(sceneResponse.status).toBe(201);
    const sceneId = (sceneResponse.body as { scene: { id: string } }).scene.id;
    const invitationResponse = await requestJson(gmPage, '/api/invitations', 'POST', { campaignId });
    expect(invitationResponse.status).toBe(201);
    const invitation = (invitationResponse.body as { invitation: string }).invitation;

    await playerPage.goto(`${webBase}/?invite=${encodeURIComponent(invitation)}`);
    await playerPage.getByRole('button', { name: 'Create account' }).click();
    await playerPage.getByLabel('Display name').fill('Move Tester');
    await playerPage.getByLabel('Email').fill(`move-conflict-player-${suffix}@example.test`);
    await playerPage.getByLabel('Password').fill('e2e-test-password-24');
    await playerPage.getByRole('button', { name: 'Create account', exact: true }).first().click();
    await expect(playerPage.getByRole('heading', { name: `Move conflict ${suffix}` })).toBeVisible();

    await gmPage.reload();
    await gmPage.getByRole('button', { name: new RegExp(`Move conflict ${suffix}`) }).click();
    await expect(gmPage.getByRole('heading', { name: `Move conflict ${suffix}` })).toBeVisible();
    const player = (await requestJson(playerPage, '/api/auth/me')).body as { user: { id: string } };
    const tokenResponse = await requestJson(gmPage, '/api/tokens', 'POST', { sceneId, name: 'Shared hero', x: 4, y: 5, color: '#c8794a' });
    expect(tokenResponse.status).toBe(201);
    const tokenId = (tokenResponse.body as { token: { id: string } }).token.id;
    expect((await requestJson(gmPage, `/api/tokens/${tokenId}/owner`, 'POST', { ownerUserId: player.user.id })).status).toBe(200);
    await expect(playerPage.locator('.table-canvas canvas')).toBeVisible();

    gmSocket = await connectedSocket(gmPage, webBase);
    playerSocket = await connectedSocket(playerPage, webBase);
    await Promise.all([joinCampaign(gmSocket, campaignId), joinCampaign(playerSocket, campaignId)]);
    const snapshotResponse = await requestJson(gmPage, `/api/scenes/${sceneId}/tokens`);
    const token = (snapshotResponse.body as Array<{ id: string; version: number }>).find((item) => item.id === tokenId)!;
    const playerEvents: Array<{ id: string; x: number; y: number; version: number }> = [];
    playerSocket.on('token:moved', (event: { id: string; x: number; y: number; version: number }) => playerEvents.push(event));

    const results = await Promise.all([
      move(gmSocket, { tokenId, x: 8, y: 5, expectedVersion: token.version }),
      move(playerSocket, { tokenId, x: 4, y: 9, expectedVersion: token.version }),
    ]);
    const winners = results.filter((result) => result.ok && result.token);
    const conflicts = results.filter((result) => result.error === 'CONFLICT' && result.token);
    expect(winners).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.token).toMatchObject({ id: tokenId, x: winners[0]!.token!.x, y: winners[0]!.token!.y, version: winners[0]!.token!.version });
    await expect.poll(() => playerEvents.some((event) => event.id === tokenId && event.version === winners[0]!.token!.version)).toBe(true);

    const playerSnapshot = await requestJson(playerPage, `/api/scenes/${sceneId}/tokens`);
    const latest = (playerSnapshot.body as Array<{ id: string; x: number; y: number; version: number }>).find((item) => item.id === tokenId);
    expect(latest).toMatchObject({ id: tokenId, x: winners[0]!.token!.x, y: winners[0]!.token!.y, version: winners[0]!.token!.version });
  } finally {
    gmSocket?.disconnect();
    playerSocket?.disconnect();
    await Promise.all([gmContext.close(), playerContext.close()]);
  }
});

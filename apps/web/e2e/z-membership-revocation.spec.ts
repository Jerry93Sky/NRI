import { expect, test, type Page } from '@playwright/test';
import { io, type Socket } from 'socket.io-client';

async function requestJson(page: Page, path: string, method = 'GET', body?: unknown) {
  return page.evaluate(async ({ path, method, body }) => {
    const response = await fetch(path, {
      method,
      credentials: 'include',
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' } }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  }, { path, method, body });
}

async function register(page: Page, name: string, email: string, invite?: string) {
  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4175';
  await page.goto(invite ? `${baseURL}/?invite=${encodeURIComponent(invite)}` : baseURL);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Display name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('e2e-test-password-24');
  await page.getByRole('button', { name: 'Create account', exact: true }).first().click();
}

async function connectSocket(page: Page, webBase: string): Promise<Socket> {
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

function sendChat(socket: Socket, campaignId: string, body: string) {
  return new Promise<{ ok?: boolean; error?: string }>((resolve) => socket.emit('chat:send', { campaignId, body }, resolve));
}

test('membership removal revokes every open Player socket and stops campaign events', async ({ browser, baseURL }) => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const webBase = process.env.PLAYWRIGHT_BASE_URL ?? String(baseURL);
  const gmContext = await browser.newContext({ locale: 'en-US' });
  const playerContext = await browser.newContext({ locale: 'en-US' });
  const secondPlayerContext = await browser.newContext({ locale: 'en-US' });
  const gmPage = await gmContext.newPage();
  const playerPage = await playerContext.newPage();
  const secondPlayerPage = await secondPlayerContext.newPage();
  let gmSocket: Socket | undefined;
  let playerSocket: Socket | undefined;
  let secondPlayerSocket: Socket | undefined;
  try {
    await register(gmPage, 'Revocation Guide', `revoke-gm-${suffix}@example.test`);
    await expect(gmPage.getByRole('heading', { name: 'Your campaigns' })).toBeVisible();
    const campaignResponse = await requestJson(gmPage, '/api/campaigns', 'POST', { title: `Revocation ${suffix}`, description: '' });
    expect(campaignResponse.status).toBe(201);
    const campaignId = (campaignResponse.body as { campaign: { id: string } }).campaign.id;
    const invitationResponse = await requestJson(gmPage, '/api/invitations', 'POST', { campaignId });
    expect(invitationResponse.status).toBe(201);
    const invitation = (invitationResponse.body as { invitation: string }).invitation;
    const playerEmail = `revoke-player-${suffix}@example.test`;
    const password = 'e2e-test-password-24';
    await register(playerPage, 'Revoked Player', playerEmail, invitation);
    await expect(playerPage.getByRole('heading', { name: `Revocation ${suffix}` })).toBeVisible();
    const player = (await requestJson(playerPage, '/api/auth/me')).body as { user: { id: string } };

    await secondPlayerPage.goto(webBase);
    const login = await requestJson(secondPlayerPage, '/api/auth/login', 'POST', { email: playerEmail, password });
    expect(login.status).toBe(200);
    await secondPlayerPage.reload();
    await expect(secondPlayerPage.getByRole('heading', { name: 'Your campaigns' })).toBeVisible();
    await secondPlayerPage.getByRole('button', { name: new RegExp(`Revocation ${suffix}`) }).click();
    await expect(secondPlayerPage.getByRole('heading', { name: `Revocation ${suffix}` })).toBeVisible();

    gmSocket = await connectSocket(gmPage, webBase);
    playerSocket = await connectSocket(playerPage, webBase);
    secondPlayerSocket = await connectSocket(secondPlayerPage, webBase);
    await Promise.all([joinCampaign(gmSocket, campaignId), joinCampaign(playerSocket, campaignId), joinCampaign(secondPlayerSocket, campaignId)]);
    const playerEvents: Array<{ body: string }> = [];
    const secondPlayerEvents: Array<{ body: string }> = [];
    const removals: Array<{ campaignId: string; userId: string }> = [];
    const secondRemovals: Array<{ campaignId: string; userId: string }> = [];
    playerSocket.on('chat:message', (event: { body: string }) => playerEvents.push(event));
    secondPlayerSocket.on('chat:message', (event: { body: string }) => secondPlayerEvents.push(event));
    playerSocket.on('membership:removed', (event: { campaignId: string; userId: string }) => removals.push(event));
    secondPlayerSocket.on('membership:removed', (event: { campaignId: string; userId: string }) => secondRemovals.push(event));

    const beforeRemoval = `Before removal ${suffix}`;
    expect((await sendChat(gmSocket, campaignId, beforeRemoval)).ok).toBe(true);
    await expect.poll(() => playerEvents.some((event) => event.body === beforeRemoval)).toBe(true);
    await expect.poll(() => secondPlayerEvents.some((event) => event.body === beforeRemoval)).toBe(true);

    expect((await requestJson(gmPage, `/api/campaigns/${campaignId}/members/${player.user.id}`, 'DELETE')).status).toBe(204);
    await expect.poll(() => removals.length).toBe(1);
    await expect.poll(() => secondRemovals.length).toBe(1);
    expect(removals[0]).toEqual({ campaignId, userId: player.user.id });
    expect(secondRemovals[0]).toEqual({ campaignId, userId: player.user.id });

    const afterRemoval = `After removal ${suffix}`;
    expect((await sendChat(gmSocket, campaignId, afterRemoval)).ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(playerEvents.some((event) => event.body === afterRemoval)).toBe(false);
    expect(secondPlayerEvents.some((event) => event.body === afterRemoval)).toBe(false);
    expect(await sendChat(playerSocket, campaignId, 'This message must be denied')).toMatchObject({ error: 'FORBIDDEN' });
    expect(await sendChat(secondPlayerSocket, campaignId, 'This message must also be denied')).toMatchObject({ error: 'FORBIDDEN' });
  } finally {
    gmSocket?.disconnect();
    playerSocket?.disconnect();
    secondPlayerSocket?.disconnect();
    await Promise.all([gmContext.close(), playerContext.close(), secondPlayerContext.close()]);
  }
});

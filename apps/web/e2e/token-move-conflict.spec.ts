import { expect, test, type Page } from '@playwright/test';
import { io, type Socket } from 'socket.io-client';

async function requestJson(page: import('@playwright/test').Page, path: string, method = 'GET', body?: unknown) {
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

type TableToken = { id: string; x: number; y: number; version: number };
type TableScene = { id: string; width: number; height: number; gridSize: number };
async function canvasCoordinates(page: Page, scene: TableScene) {
  await page.getByRole('button', { name: 'Fit scene', exact: true }).click();
  const canvas = page.locator('.table-canvas canvas');
  const bounds = (await canvas.boundingBox())!;
  const scale = Math.max(0.1, Math.min(4, Math.min(bounds.width / scene.width, bounds.height / scene.height) * .9));
  const point = (x: number, y: number) => ({
    x: bounds.x + (bounds.width - scene.width * scale) / 2 + x * scale,
    y: bounds.y + (bounds.height - scene.height * scale) / 2 + y * scale,
  });
  return { canvas, bounds, scale, point };
}

async function startDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
}

test('simultaneous GM and owner moves resolve one stale version in two browser sessions', async ({ browser }) => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const webBase = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4175';
  const gmContext = await browser.newContext({ locale: 'en-US' });
  const playerContext = await browser.newContext({ locale: 'en-US' });
  const gmPage = await gmContext.newPage();
  const playerPage = await playerContext.newPage();
  let cutBrowserSocket: (() => Promise<void>) | undefined;
  await playerPage.routeWebSocket((url) => url.pathname === '/socket.io/', (wire) => {
    const upstream = wire.connectToServer();
    cutBrowserSocket = async () => {
      await wire.close({ code: 1001, reason: 'Fixture disconnect' });
      await upstream.close({ code: 1001, reason: 'Fixture disconnect' });
    };
  });
  let gmSocket: Socket | undefined;
  let playerSocket: Socket | undefined;
  try {
    await register(gmPage, 'Conflict Guide', `move-conflict-gm-${suffix}@example.test`);
    const campaignResponse = await requestJson(gmPage, '/api/campaigns', 'POST', { title: `Move conflict ${suffix}`, description: '' });
    expect(campaignResponse.status).toBe(201);
    const campaignId = (campaignResponse.body as { campaign: { id: string } }).campaign.id;
    const sceneResponse = await requestJson(gmPage, '/api/scenes', 'POST', { campaignId, title: 'Shared table' });
    expect(sceneResponse.status).toBe(201);
    const scene = (sceneResponse.body as { scene: TableScene }).scene;
    const sceneId = scene.id;
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
    const latest = (playerSnapshot.body as TableToken[]).find((item) => item.id === tokenId)!;
    expect(latest).toMatchObject({ id: tokenId, x: winners[0]!.token!.x, y: winners[0]!.token!.y, version: winners[0]!.token!.version });

    await test.step('Browser drag commits for the owner, discards cancellation and blocks locked or foreign tokens', async () => {
      const currentToken = async (id: string) => ((await requestJson(gmPage, `/api/scenes/${sceneId}/tokens`)).body as TableToken[]).find((item) => item.id === id)!;
      const where = await canvasCoordinates(playerPage, scene);
      const point = (item: TableToken, dx = 0, dy = 0) => where.point((item.x + dx) * scene.gridSize, (item.y + dy) * scene.gridSize);
      await startDrag(playerPage, point(latest), point(latest, 2));
      await playerPage.mouse.up();
      await expect.poll(async () => (await currentToken(tokenId)).x).toBeCloseTo(latest.x + 2, 1);
      const owned = await currentToken(tokenId);
      for (const interrupt of ['Escape', 'pointercancel', 'lostpointercapture', 'outside'] as const) {
        await startDrag(playerPage, point(owned), point(owned, 1));
        if (interrupt === 'Escape') await playerPage.keyboard.press('Escape');
        else if (interrupt === 'outside') await playerPage.mouse.move(where.bounds.x + 5, where.bounds.y - 3);
        else await where.canvas.dispatchEvent(interrupt, { pointerId: 1, pointerType: 'mouse' });
        await playerPage.mouse.up();
        await expect.poll(async () => (await currentToken(tokenId)).version).toBe(owned.version);
      }
      const foreignResponse = await requestJson(gmPage, '/api/tokens', 'POST', { sceneId, name: 'Foreign token', x: 11, y: 6 });
      expect(foreignResponse.status).toBe(201);
      const foreign = (foreignResponse.body as { token: TableToken }).token;
      await expect.poll(async () => ((await requestJson(playerPage, `/api/scenes/${sceneId}/tokens`)).body as TableToken[]).some(({ id }) => id === foreign.id)).toBe(true);
      await startDrag(playerPage, point(foreign), point(foreign, 2));
      await playerPage.mouse.up();
      expect(await currentToken(foreign.id)).toMatchObject(foreign);
      const locked = await requestJson(gmPage, `/api/tokens/${tokenId}`, 'PATCH', { expectedVersion: owned.version, locked: true });
      expect(locked.status).toBe(200);
      const lockedToken = (locked.body as { token: TableToken }).token;
      await startDrag(playerPage, point(lockedToken), point(lockedToken, 1));
      await playerPage.mouse.up();
      expect(await currentToken(tokenId)).toMatchObject(lockedToken);

      const unfreeze = await requestJson(gmPage, `/api/tokens/${tokenId}`, 'PATCH', { expectedVersion: lockedToken.version, locked: false });
      expect(unfreeze.status).toBe(200);
      const unlocked = (unfreeze.body as { token: TableToken }).token;
      const gmWhere = await canvasCoordinates(gmPage, scene);
      await gmPage.locator('.token-group-tools').getByRole('button', { name: 'Select all', exact: true }).click();
      await startDrag(gmPage, gmWhere.point(unlocked.x * scene.gridSize, unlocked.y * scene.gridSize),
        gmWhere.point((unlocked.x + 1) * scene.gridSize, unlocked.y * scene.gridSize));
      await gmPage.mouse.up();
      await expect.poll(async () => (await currentToken(foreign.id)).x).toBeCloseTo(foreign.x + 1, 1);
      const grouped = await currentToken(tokenId);
      expect(grouped.x).toBeCloseTo(unlocked.x + 1, 1);
      const chat = gmPage.getByPlaceholder('Write a message…');
      await chat.fill('Editing chat');
      await chat.press('Control+z');
      await chat.press('Delete');
      expect(await currentToken(tokenId)).toMatchObject(grouped);

      const layers = (await requestJson(gmPage, `/api/scenes/${sceneId}/layers`)).body as Array<{ id: string; kind: string; version: number }>;
      const objectLayer = layers.find(({ kind }) => kind === 'OBJECTS')!;
      const objectResponse = await requestJson(gmPage, `/api/scenes/${sceneId}/objects`, 'POST', {
        layerId: objectLayer.id, kind: 'RECTANGLE', x: 650, y: 420, width: 140, height: 100,
      });
      expect(objectResponse.status).toBe(201);
      type Rectangle = { id: string; x: number; y: number; width: number; height: number; version: number };
      const rectangle = (objectResponse.body as { object: Rectangle }).object;
      const readObject = async () => ((await requestJson(gmPage, `/api/scenes/${sceneId}/objects`)).body as Rectangle[]).find(({ id }) => id === rectangle.id)!;
      await gmPage.locator('details.layer-tools summary').click();
      await gmPage.locator('.layer-select').filter({ hasText: 'Objects' }).click();
      await expect(gmPage.locator(`[data-object-id="${rectangle.id}"]`)).toBeVisible();
      const objectWhere = await canvasCoordinates(gmPage, scene);
      await startDrag(gmPage, objectWhere.point(720, 470), objectWhere.point(770, 505));
      await gmPage.mouse.up();
      await expect.poll(async () => (await readObject()).x).toBeGreaterThan(rectangle.x + 30);
      const moved = await readObject();
      const end = objectWhere.point(moved.x + moved.width, moved.y + moved.height);
      await startDrag(gmPage, end, objectWhere.point(moved.x + moved.width + 28, moved.y + moved.height + 18));
      await gmPage.mouse.up();
      await expect.poll(async () => (await readObject()).width).toBeGreaterThan(moved.width + 25);
      const resized = await readObject();

      const memberPath = `/api/campaigns/${campaignId}/members/${player.user.id}`;
      await startDrag(playerPage, point(grouped), point(grouped, 1));
      expect((await requestJson(gmPage, `${memberPath}/role`, 'POST', { role: 'GM' })).status).toBe(200);
      await expect(playerPage.locator('.role-badge')).toHaveText('GM');
      await playerPage.mouse.up();
      expect(await currentToken(tokenId)).toMatchObject(grouped);
      const externalEdit = await requestJson(playerPage, `/api/objects/${rectangle.id}`, 'PATCH', { x: resized.x + 23, expectedVersion: resized.version });
      expect(externalEdit.status).toBe(200);
      const undo = gmPage.waitForResponse((response) => response.url().endsWith(`/api/objects/${rectangle.id}`) && response.request().method() === 'PATCH');
      await gmPage.locator('.table-actions').getByRole('button', { name: 'Undo', exact: true }).click();
      expect((await undo).status()).toBe(409);
      await expect(gmPage.getByRole('alert')).toContainText('Another change has already been saved');
      expect(await readObject()).toMatchObject((externalEdit.body as { object: Rectangle }).object);
      const newVersion = await readObject();
      const lockLayer = await requestJson(gmPage, `/api/layers/${objectLayer.id}`, 'PATCH', { expectedVersion: objectLayer.version, locked: true });
      expect(lockLayer.status).toBe(200);
      const lockedObjectWhere = await canvasCoordinates(gmPage, scene);
      const objectCenter = { x: newVersion.x + newVersion.width / 2, y: newVersion.y + newVersion.height / 2 };
      await startDrag(gmPage, lockedObjectWhere.point(objectCenter.x, objectCenter.y), lockedObjectWhere.point(objectCenter.x + 40, objectCenter.y + 30));
      await gmPage.mouse.up();
      expect(await readObject()).toMatchObject(newVersion);

      const addScene = gmPage.getByRole('button', { name: '＋ Add scene', exact: true });
      await addScene.click();
      const sceneName = gmPage.getByLabel('Scene name');
      await expect(sceneName).toBeFocused();
      await sceneName.press('Escape');
      await expect(sceneName).toHaveCount(0);
      await expect(addScene).toBeFocused();

      const draft = await requestJson(gmPage, '/api/scenes', 'POST', { campaignId, title: 'Gesture switch draft' });
      expect(draft.status).toBe(201);
      await gmPage.reload();
      await gmPage.getByRole('button', { name: new RegExp(`Move conflict ${suffix}`) }).click();
      await expect(gmPage.locator('.live-status')).toHaveText('Live');
      const switchWhere = await canvasCoordinates(gmPage, scene);
      await startDrag(gmPage, switchWhere.point(grouped.x * scene.gridSize, grouped.y * scene.gridSize),
        switchWhere.point((grouped.x + 1) * scene.gridSize, grouped.y * scene.gridSize));
      await gmPage.locator('.scene-tab').filter({ hasText: 'Gesture switch draft' }).evaluate((button) => (button as HTMLButtonElement).click());
      await expect(gmPage.locator('.scene-tab-wrap.selected')).toContainText('Gesture switch draft');
      await gmPage.mouse.up();
      expect(await currentToken(tokenId)).toMatchObject(grouped);

      const reconnectWhere = await canvasCoordinates(playerPage, scene);
      const startPoint = reconnectWhere.point(grouped.x * scene.gridSize, grouped.y * scene.gridSize);
      const dragPoint = reconnectWhere.point((grouped.x + 1) * scene.gridSize, grouped.y * scene.gridSize);
      await startDrag(playerPage, startPoint, dragPoint);
      expect(cutBrowserSocket).toBeDefined();
      await cutBrowserSocket!();
      await expect(playerPage.locator('.live-status')).toHaveText('Reconnecting');
      await playerPage.mouse.up();
      await expect(playerPage.locator('.live-status')).toHaveText('Live');
      expect(await currentToken(tokenId)).toMatchObject(grouped);

      await startDrag(playerPage, startPoint, dragPoint);
      expect((await requestJson(gmPage, memberPath, 'DELETE')).status).toBe(204);
      await expect(playerPage.getByRole('heading', { name: 'Your campaigns' })).toBeVisible();
      await playerPage.mouse.up();
      expect(await currentToken(tokenId)).toMatchObject(grouped);
    });
  } finally {
    gmSocket?.disconnect();
    playerSocket?.disconnect();
    await Promise.all([gmContext.close(), playerContext.close()]);
  }
});

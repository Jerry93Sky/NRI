import { expect, test } from '@playwright/test';

async function register(page: import('@playwright/test').Page, name: string, email: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Display name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('e2e-test-password-24');
  await page.getByRole('button', { name: 'Create account', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Your campaigns' })).toBeVisible();
}

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

test('separate GM and player contexts keep drafts and GM objects private', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(240_000);
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const gmContext = await browser.newContext({ locale: 'en-US' });
  const playerContext = await browser.newContext({ locale: 'en-US' });
  const observerContext = await browser.newContext({ locale: 'en-US' });
  const gmPage = await gmContext.newPage();
  const playerPage = await playerContext.newPage();
  const observerPage = await observerContext.newPage();
  const frames = new Map<string, Map<string, string>>();
  const wires = new Map<string, import('@playwright/test').WebSocketRoute>();
  for (const [key, page] of [['player', playerPage], ['observer', observerPage]] as const) {
    const latest = new Map<string, string>();
    frames.set(key, latest);
    await page.routeWebSocket((url) => url.pathname === '/socket.io/', (wire) => {
      wires.set(key, wire);
      wire.connectToServer().onMessage((packet) => {
        if (typeof packet === 'string' && packet.startsWith('42[')) {
          const [name] = JSON.parse(packet.slice(2)) as [string];
          if (['chat:private', 'dice:result', 'initiative:gm_updated', 'token:owner_note'].includes(name)) latest.set(name, packet);
        }
        wire.send(packet);
      });
    });
  }
  function replay(key: string, event: string) {
    const packet = frames.get(key)?.get(event);
    expect(packet, `Expected a real ${event} frame for ${key}`).toBeDefined();
    wires.get(key)!.send(packet!);
  }
  let releaseHistoryHydration = () => {};
  const historyHydration = new Promise<void>((resolve) => { releaseHistoryHydration = resolve; });
  for (const page of [playerPage, observerPage]) {
    await page.route('**/api/campaigns/*/messages', async (route) => {
      const response = await route.fetch();
      await historyHydration;
      await route.fulfill({ response });
    });
  }

  try {
    await register(gmPage, 'E2E Guide', `guide-${suffix}@example.test`);
    const campaignTitle = `E2E Campaign ${suffix}`;
    await gmPage.getByLabel('Campaign name').fill(campaignTitle);
    await gmPage.getByLabel('A short description').fill('Isolated browser acceptance data');
    await gmPage.getByRole('button', { name: /^Create/ }).click();
    await expect(gmPage.getByRole('heading', { name: campaignTitle })).toBeVisible();

    const activeTitle = `Active ${suffix}`;
    await gmPage.getByRole('button', { name: /Add scene/ }).first().click();
    await gmPage.getByLabel('Scene name').fill(activeTitle);
    const activeResponsePromise = gmPage.waitForResponse((response) => response.url().endsWith('/api/scenes') && response.request().method() === 'POST');
    await gmPage.getByRole('button', { name: /^Create/ }).click();
    const activeSceneResponse = await activeResponsePromise;
    const { scene: activeScene } = await activeSceneResponse.json() as { scene: { id: string; campaignId: string } };
    await expect(gmPage.getByRole('button', { name: 'Add token' })).toBeVisible();
    await expect(gmPage.locator('.table-canvas')).toBeVisible();
    for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }, { width: 2560, height: 1440 }]) {
      await gmPage.setViewportSize(viewport);
      await gmPage.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      const layout = await gmPage.evaluate(() => ({
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        canvasWidth: document.querySelector('.table-canvas')?.getBoundingClientRect().width ?? 0,
        canvasHeight: document.querySelector('.table-canvas')?.getBoundingClientRect().height ?? 0,
        mainWidth: document.querySelector('.table-main')?.getBoundingClientRect().width ?? 0,
        mainHeight: document.querySelector('.table-main')?.getBoundingClientRect().height ?? 0,
      }));
      expect(layout.documentWidth, `horizontal overflow at ${viewport.width}×${viewport.height}`).toBeLessThanOrEqual(layout.viewportWidth);
      expect(layout.canvasWidth, `table canvas too narrow at ${viewport.width}×${viewport.height}: ${JSON.stringify(layout)}`).toBeGreaterThan(600);
      expect(layout.canvasHeight, `table canvas too short at ${viewport.width}×${viewport.height}: ${JSON.stringify(layout)}`).toBeGreaterThan(400);
      await gmPage.screenshot({ path: testInfo.outputPath(`tabletop-${viewport.width}x${viewport.height}.png`) });
    }
    await gmPage.setViewportSize({ width: 1280, height: 720 });
    await gmPage.getByRole('button', { name: 'Switch to light theme' }).click();
    await expect(gmPage.locator('.app-shell')).toHaveAttribute('data-theme', 'light');
    await expect.poll(() => gmPage.evaluate(() => localStorage.getItem('nri:theme'))).toBe('light');
    await gmPage.getByRole('button', { name: 'Switch to dark theme' }).click();
    await expect(gmPage.locator('.app-shell')).toHaveAttribute('data-theme', 'dark');
    const panelWidth = gmPage.getByLabel('Panel width');
    const initialPanelWidth = Number(await panelWidth.inputValue());
    await panelWidth.press('ArrowRight');
    await expect(panelWidth).toHaveValue(String(initialPanelWidth + 10));
    await expect.poll(() => gmPage.evaluate(() => localStorage.getItem('nri:table-rail-width'))).toBe(String(initialPanelWidth + 10));
    await gmPage.getByRole('button', { name: 'Collapse panel' }).click();
    await expect(gmPage.getByRole('button', { name: 'Expand panel' })).toBeVisible();
    await gmPage.getByRole('button', { name: 'Expand panel' }).click();
    await gmPage.getByRole('button', { name: 'Fullscreen' }).click();
    await expect.poll(() => gmPage.evaluate(() => document.fullscreenElement !== null)).toBe(true);
    await gmPage.getByRole('button', { name: 'Exit fullscreen' }).click();
    await expect.poll(() => gmPage.evaluate(() => document.fullscreenElement === null)).toBe(true);

    const mapDataUrl = await gmPage.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512;
      const context = canvas.getContext('2d')!; context.fillStyle = '#d8c8a8'; context.fillRect(0, 0, 512, 512);
      context.strokeStyle = '#8b7961'; context.lineWidth = 2;
      for (let position = 0; position <= 512; position += 64) { context.beginPath(); context.moveTo(position, 0); context.lineTo(position, 512); context.stroke(); context.beginPath(); context.moveTo(0, position); context.lineTo(512, position); context.stroke(); }
      return canvas.toDataURL('image/png');
    });
    const mapBuffer = Buffer.from(mapDataUrl.split(',')[1]!, 'base64');
    await gmPage.getByRole('button', { name: /Upload map/ }).click();
    const mapUploadResponse = gmPage.waitForResponse((response) => response.url().endsWith(`/api/campaigns/${activeScene.campaignId}/assets`) && response.request().method() === 'POST');
    await gmPage.locator('input[type="file"]').first().setInputFiles({ name: 'calibration-map.png', mimeType: 'image/png', buffer: mapBuffer });
    expect((await mapUploadResponse).status()).toBe(201);
    await gmPage.getByRole('button', { name: 'Grid & size' }).click();
    await gmPage.getByRole('button', { name: 'Calibrate grid from map' }).click();
    const calibrationCanvas = gmPage.locator('.table-canvas canvas');
    const calibrationBounds = await calibrationCanvas.boundingBox();
    expect(calibrationBounds).toBeTruthy();
    await gmPage.mouse.click(calibrationBounds!.x + 150, calibrationBounds!.y + 140);
    await gmPage.mouse.click(calibrationBounds!.x + 270, calibrationBounds!.y + 140);
    await expect(gmPage.getByRole('heading', { name: 'Calibrate grid from map' })).toBeVisible();
    await gmPage.getByLabel('Grid cells between points').fill('4');
    await expect(gmPage.locator('.calibration-preview')).toContainText('Preview cell size:');
    const calibratedSettingsResponse = gmPage.waitForResponse((response) => response.url().endsWith(`/api/scenes/${activeScene.id}`) && response.request().method() === 'PATCH');
    await gmPage.getByRole('button', { name: 'Save settings', exact: true }).click();
    const calibratedSettings = await calibratedSettingsResponse;
    expect(calibratedSettings.status()).toBe(200);
    const calibratedScene = (await calibratedSettings.json() as { scene: { gridSize: number } }).scene;
    expect(calibratedScene.gridSize).toBeGreaterThanOrEqual(8);
    expect(calibratedScene.gridSize).toBeLessThanOrEqual(256);

    const layersResult = await requestJson(gmPage, `/api/scenes/${activeScene.id}/layers`);
    expect(layersResult.status).toBe(200);
    const layers = layersResult.body as Array<{ id: string; kind: string }>;
    const gmLayer = layers.find((layer) => layer.kind === 'GM');
    const objectsLayer = layers.find((layer) => layer.kind === 'OBJECTS');
    expect(gmLayer).toBeTruthy();
    expect(objectsLayer).toBeTruthy();
    const hiddenObjectResult = await requestJson(gmPage, `/api/scenes/${activeScene.id}/objects`, 'POST', {
      layerId: gmLayer!.id, kind: 'RECTANGLE', x: 100, y: 100, width: 64, height: 64,
      color: '#cc4444', strokeWidth: 2, visible: true, locked: false,
    });
    expect(hiddenObjectResult.status).toBe(201);
    const hiddenSource = (hiddenObjectResult.body as { object: { id: string; visible: boolean; version: number; kind: string; x: number; y: number; width: number; height: number; rotation: number; opacity: number; zIndex: number; assetId: string | null; color: string | null; strokeWidth: number | null; points: unknown; text: string | null } }).object;
    expect(hiddenSource.visible).toBe(false);
    const hiddenObjectId = hiddenSource.id;
    const copiedHiddenObjectResult = await requestJson(gmPage, `/api/scenes/${activeScene.id}/objects`, 'POST', {
      layerId: objectsLayer!.id, kind: hiddenSource.kind, x: hiddenSource.x + 24, y: hiddenSource.y + 24,
      width: hiddenSource.width, height: hiddenSource.height, rotation: hiddenSource.rotation, opacity: hiddenSource.opacity,
      zIndex: hiddenSource.zIndex + 1, assetId: hiddenSource.assetId, color: hiddenSource.color,
      strokeWidth: hiddenSource.strokeWidth, points: hiddenSource.points, text: hiddenSource.text,
      visible: hiddenSource.visible, locked: false,
    });
    expect(copiedHiddenObjectResult.status).toBe(201);
    const copiedHiddenObject = (copiedHiddenObjectResult.body as { object: { id: string; visible: boolean } }).object;
    expect(copiedHiddenObject.visible).toBe(false);

    const tokenResponsePromise = gmPage.waitForResponse((response) => response.url().endsWith('/api/tokens') && response.request().method() === 'POST');
    await gmPage.getByRole('button', { name: 'Add token' }).click();
    const tokenResponse = await tokenResponsePromise;
    const { token } = await tokenResponse.json() as { token: { id: string; version: number } };
    await gmPage.getByRole('checkbox', { name: 'Select Token 1', exact: true }).check();
    await gmPage.locator('body').click({ position: { x: 20, y: 20 } });
    const duplicateResponsePromise = gmPage.waitForResponse((response) => response.url().endsWith(`/api/tokens/${token.id}/duplicate`) && response.request().method() === 'POST');
    await gmPage.keyboard.press('Control+c');
    await gmPage.keyboard.press('Control+v');
    const duplicateResponse = await duplicateResponsePromise;
    expect(duplicateResponse.status()).toBe(201);
    const { token: duplicateToken } = await duplicateResponse.json() as { token: { id: string; name: string; ownerUserId: string | null } };
    expect(duplicateToken.id).not.toBe(token.id);
    expect(duplicateToken.name).toBe('Token 1 copy');
    expect(duplicateToken.ownerUserId).toBeNull();
    await gmPage.getByRole('button', { name: 'Clear selection' }).click();
    await gmPage.getByRole('checkbox', { name: 'Select Token 1', exact: true }).check();
    const secondTokenResponsePromise = gmPage.waitForResponse((response) => response.url().endsWith('/api/tokens') && response.request().method() === 'POST');
    await gmPage.getByRole('button', { name: 'Add token' }).click();
    await secondTokenResponsePromise;
    await gmPage.getByRole('checkbox', { name: 'Select Token 3' }).check();
    await gmPage.locator('body').click({ position: { x: 20, y: 20 } });
    const duplicateGroupResponsePromise = gmPage.waitForResponse((response) => response.url().endsWith(`/api/scenes/${activeScene.id}/tokens/duplicate`) && response.request().method() === 'POST');
    await gmPage.keyboard.press('Control+c');
    await gmPage.keyboard.press('Control+v');
    const duplicateGroupResponse = await duplicateGroupResponsePromise;
    expect(duplicateGroupResponse.status()).toBe(201);
    const { tokens: duplicateGroup } = await duplicateGroupResponse.json() as { tokens: Array<{ id: string; version: number }> };
    expect(duplicateGroup).toHaveLength(2);
    expect(new Set(duplicateGroup.map((item) => item.id)).size).toBe(2);
    const beforeStaleGroupCopy = await requestJson(gmPage, `/api/scenes/${activeScene.id}/tokens`);
    const staleGroupCopy = await requestJson(gmPage, `/api/scenes/${activeScene.id}/tokens/duplicate`, 'POST', {
      sceneId: activeScene.id,
      tokens: [
        { tokenId: token.id, expectedVersion: token.version + 99, x: 400, y: 400 },
        { tokenId: duplicateGroup[0]!.id, expectedVersion: duplicateGroup[0]!.version, x: 500, y: 400 },
      ],
    });
    expect(staleGroupCopy.status).toBe(409);
    const afterStaleGroupCopy = await requestJson(gmPage, `/api/scenes/${activeScene.id}/tokens`);
    expect((afterStaleGroupCopy.body as unknown[]).length).toBe((beforeStaleGroupCopy.body as unknown[]).length);

    const inviteResponsePromise = gmPage.waitForResponse((response) => response.url().endsWith('/api/invitations') && response.request().method() === 'POST');
    await gmPage.getByRole('button', { name: /Invite players/ }).click();
    const inviteResponse = await inviteResponsePromise;
    const { invitation } = await inviteResponse.json() as { invitation: string };

    await playerPage.goto(new URL(`/?invite=${encodeURIComponent(invitation)}`, baseURL).toString());
    await playerPage.getByRole('button', { name: 'Create account' }).click();
    await playerPage.getByLabel('Display name').fill('E2E Player');
    await playerPage.getByLabel('Email').fill(`player-${suffix}@example.test`);
    await playerPage.getByLabel('Password').fill('e2e-test-password-24');
    const acceptInvitationPromise = playerPage.waitForResponse((response) => /\/api\/invitations\/[^/]+\/accept$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST');
    await playerPage.getByRole('button', { name: 'Create account', exact: true }).first().click();
    const acceptInvitationResponse = await acceptInvitationPromise;
    expect(acceptInvitationResponse.status()).toBe(200);
    await expect(playerPage.getByRole('heading', { name: campaignTitle })).toBeVisible();
    await expect(playerPage.locator('.live-status')).toHaveText('Live');
    await observerPage.goto(new URL(`/?invite=${encodeURIComponent(invitation)}`, baseURL).toString());
    await observerPage.getByRole('button', { name: 'Create account' }).click();
    await observerPage.getByLabel('Display name').fill('E2E Observer');
    await observerPage.getByLabel('Email').fill(`observer-${suffix}@example.test`);
    await observerPage.getByLabel('Password').fill('e2e-test-password-24');
    const observerInvitePromise = observerPage.waitForResponse((response) => /\/api\/invitations\/[^/]+\/accept$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST');
    await observerPage.getByRole('button', { name: 'Create account', exact: true }).first().click();
    expect((await observerInvitePromise).status()).toBe(200);
    await expect(observerPage.getByRole('heading', { name: campaignTitle })).toBeVisible();
    await expect(observerPage.locator('.live-status')).toHaveText('Live');
    await gmPage.reload();
    await expect(gmPage.getByRole('heading', { name: 'Your campaigns' })).toBeVisible();
    await gmPage.getByRole('button', { name: new RegExp(campaignTitle) }).click();
    await expect(gmPage.getByRole('heading', { name: campaignTitle })).toBeVisible();
    await expect(gmPage.locator('.live-status')).toHaveText('Live');

    const playerTokenSnapshot = await requestJson(playerPage, `/api/scenes/${activeScene.id}/tokens`);
    const playerTokenIds = (playerTokenSnapshot.body as Array<{ id: string }>).map((item) => item.id);
    expect(playerTokenIds).toContain(token.id);
    const [movementScene] = (await requestJson(gmPage, `/api/campaigns/${activeScene.campaignId}/scenes`)).body as Array<{ id: string; width: number; height: number; gridSize: number }>;
    expect(movementScene?.id).toBe(activeScene.id);
    const movementToken = (await requestJson(gmPage, `/api/scenes/${activeScene.id}/tokens`)).body as Array<{ id: string; x: number; y: number }>;
    const startingToken = movementToken.find((item) => item.id === token.id);
    expect(startingToken).toBeTruthy();
    await gmPage.getByRole('button', { name: 'Clear selection' }).click();
    const playerCanvas = playerPage.locator('.table-canvas canvas');
    await expect(playerCanvas).toBeVisible();
    const playerCanvasBeforeMove = await playerCanvas.screenshot();
    const movementCanvasBounds = await gmPage.locator('.table-canvas canvas').boundingBox();
    expect(movementCanvasBounds).toBeTruthy();
    const fitScale = Math.min(movementCanvasBounds!.width / movementScene!.width, movementCanvasBounds!.height / movementScene!.height) * 0.9;
    const canvasOriginX = (movementCanvasBounds!.width - movementScene!.width * fitScale) / 2;
    const canvasOriginY = (movementCanvasBounds!.height - movementScene!.height * fitScale) / 2;
    const tokenCenter = {
      x: movementCanvasBounds!.x + canvasOriginX + startingToken!.x * movementScene!.gridSize * fitScale,
      y: movementCanvasBounds!.y + canvasOriginY + startingToken!.y * movementScene!.gridSize * fitScale,
    };
    await gmPage.mouse.move(tokenCenter.x, tokenCenter.y);
    await gmPage.mouse.down();
    await gmPage.mouse.move(tokenCenter.x + movementScene!.gridSize * fitScale, tokenCenter.y, { steps: 8 });
    await gmPage.mouse.up();
    await expect.poll(async () => {
      const currentTokens = (await requestJson(gmPage, `/api/scenes/${activeScene.id}/tokens`)).body as Array<{ id: string; x: number; y: number }>;
      return currentTokens.find((item) => item.id === token.id)?.x;
    }).not.toBe(startingToken!.x);
    const movedTokens = (await requestJson(gmPage, `/api/scenes/${activeScene.id}/tokens`)).body as Array<{ id: string; x: number; y: number }>;
    const movedToken = movedTokens.find((item) => item.id === token.id);
    expect(movedToken?.y).toBe(startingToken!.y);
    await expect.poll(async () => !(await playerCanvas.screenshot()).equals(playerCanvasBeforeMove)).toBe(true);

    for (const [label, page] of [['gm', gmPage], ['player', playerPage]] as const) {
      const originalViewport = page.viewportSize();
      for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }, { width: 2560, height: 1440 }]) {
        await page.setViewportSize(viewport);
        const canvas = page.locator('.table-canvas canvas');
        await expect(canvas).toBeVisible();
        const bounds = await canvas.boundingBox();
        expect(bounds?.width ?? 0).toBeGreaterThan(600);
        expect(bounds?.height ?? 0).toBeGreaterThan(400);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
        await page.screenshot({ path: testInfo.outputPath(`${label}-${viewport.width}x${viewport.height}.png`) });
      }
      if (originalViewport) await page.setViewportSize(originalViewport);
    }


    const publicMessage = `Shared table message ${suffix}`;
    await gmPage.getByPlaceholder('Write a message…').fill(publicMessage);
    await gmPage.getByRole('button', { name: 'Send' }).click();
    await expect(playerPage.locator('.chat-messages')).toContainText(publicMessage);
    await expect(observerPage.locator('.chat-messages')).toContainText(publicMessage);
    releaseHistoryHydration();
    await expect(playerPage.locator('.chat-messages')).toContainText(publicMessage);
    await expect(observerPage.locator('.chat-messages')).toContainText(publicMessage);

    await playerContext.setOffline(true);
    await expect(playerPage.locator('.live-status')).toHaveText('Reconnecting');
    await playerContext.setOffline(false);
    await expect(playerPage.locator('.live-status')).toHaveText('Live');
    const reconnectedMessage = `Reconnect check ${suffix}`;
    await gmPage.getByPlaceholder('Write a message…').fill(reconnectedMessage);
    await gmPage.getByRole('button', { name: 'Send' }).click();
    await expect(playerPage.locator('.chat-messages')).toContainText(reconnectedMessage);
    await expect(observerPage.locator('.chat-messages')).toContainText(reconnectedMessage);

    const privateMessage = `Private guidance ${suffix}`;
    await gmPage.getByLabel('Message recipient').selectOption({ label: 'Private · E2E Player' });
    await gmPage.getByPlaceholder('Write a message…').fill(privateMessage);
    await gmPage.getByRole('button', { name: 'Send' }).click();
    await expect(playerPage.locator('.chat-messages')).toContainText(privateMessage);
    await expect(observerPage.locator('.chat-messages')).not.toContainText(privateMessage);
    replay('player', 'chat:private');
    await gmPage.getByLabel('Message recipient').selectOption('');

    const priorPlayerRollCount = await playerPage.locator('.roll-row').count();
    const priorObserverRollCount = await observerPage.locator('.roll-row').count();
    await gmPage.getByRole('button', { name: /d20/ }).click();
    await expect(playerPage.locator('.roll-row')).toHaveCount(priorPlayerRollCount + 1);
    await expect(observerPage.locator('.roll-row')).toHaveCount(priorObserverRollCount + 1);
    const priorGmRollCount = await gmPage.locator('.roll-row').count();
    await gmPage.getByLabel('Private roll · GMs only').check();
    await gmPage.getByRole('button', { name: /d20/ }).click();
    await expect(gmPage.locator('.roll-row')).toHaveCount(priorGmRollCount + 1);
    await expect(gmPage.locator('.roll-row').first()).toContainText('Private roll · GMs only');
    await expect(playerPage.locator('.chat-message').filter({ hasText: privateMessage })).toHaveCount(1);
    await expect(playerPage.locator('.roll-row')).toHaveCount(priorPlayerRollCount + 1);
    await expect(observerPage.locator('.roll-row')).toHaveCount(priorObserverRollCount + 1);
    await gmPage.getByLabel('Private roll · GMs only').uncheck();

    const initiativeScores = gmPage.locator('.initiative-score input');
    const initiativeEntryCount = await initiativeScores.count();
    expect(initiativeEntryCount).toBeGreaterThan(0);
    for (let index = 0; index < initiativeEntryCount; index++) await initiativeScores.nth(index).fill(String(20 - index));
    await gmPage.getByRole('button', { name: 'Start initiative' }).click();
    await expect(playerPage.locator('.initiative-list .initiative-row')).toHaveCount(initiativeEntryCount);
    await gmPage.getByRole('button', { name: /Next turn/ }).click();
    await expect(playerPage.locator('.initiative-list .initiative-row')).toHaveCount(initiativeEntryCount);
    await gmPage.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(playerPage.getByText('Initiative is not active.')).toBeVisible();

    const visibleTokens = (await requestJson(gmPage, `/api/scenes/${activeScene.id}/tokens`)).body as Array<{ id: string; name: string; hidden: boolean }>;
    const visibleEntries = visibleTokens.filter((token) => !token.hidden).map((token, index) => ({ tokenId: token.id, label: token.name, score: 20 - index }));
    const hiddenInitiativeLabel = `Hidden initiative ${suffix}`;
    const hiddenInitiativeStart = await requestJson(gmPage, `/api/campaigns/${activeScene.campaignId}/initiative/start`, 'POST', {
      sceneId: activeScene.id,
      entries: [{ tokenId: null, label: hiddenInitiativeLabel, score: 999, hidden: true }, ...visibleEntries],
    });
    expect(hiddenInitiativeStart.status).toBe(200);
    await expect(gmPage.locator('.initiative-list .initiative-row')).toHaveCount(visibleEntries.length + 1);
    await expect(gmPage.locator('.initiative-list .initiative-row').filter({ hasText: hiddenInitiativeLabel })).toHaveCount(1);
    await expect(playerPage.locator('.initiative-list .initiative-row')).toHaveCount(visibleEntries.length);
    await expect(playerPage.locator('.initiative-list .initiative-row').filter({ hasText: hiddenInitiativeLabel })).toHaveCount(0);
    await expect(playerPage.locator('.initiative-list .initiative-row.active')).toHaveCount(0);
    await expect(observerPage.locator('.initiative-list .initiative-row')).toHaveCount(visibleEntries.length);
    const { user: observerUser } = (await requestJson(observerPage, '/api/auth/me')).body as { user: { id: string } };
    const { user: playerUser } = (await requestJson(playerPage, '/api/auth/me')).body as { user: { id: string } };
    const observerRole = `/api/campaigns/${activeScene.campaignId}/members/${observerUser.id}/role`;
    expect((await requestJson(gmPage, observerRole, 'POST', { role: 'GM' })).status).toBe(200);
    await expect(observerPage.locator('.role-badge')).toHaveText('GM');
    await expect(observerPage.locator('.live-status')).toHaveText('Live');
    await expect(observerPage.locator('.initiative-row').filter({ hasText: hiddenInitiativeLabel })).toHaveCount(1);
    await gmPage.getByLabel('Private roll · GMs only').check();
    await gmPage.getByRole('button', { name: /d20/ }).click();
    await expect(observerPage.locator('.roll-row').filter({ hasText: 'Private roll · GMs only' })).toHaveCount(1);
    await gmPage.getByLabel('Private roll · GMs only').uncheck();

    const initiativePath = `/api/campaigns/${activeScene.campaignId}/initiative`;
    let releaseDelayed = () => {};
    const delayResponse = new Promise<void>((resolve) => { releaseDelayed = resolve; });
    let captureResponse = (_value: unknown) => {};
    const capturedResponse = new Promise<unknown>((resolve) => { captureResponse = resolve; });
    await observerPage.route(`**${initiativePath}`, async (route) => {
      const response = await route.fetch();
      captureResponse(await response.json());
      await delayResponse;
      await route.fulfill({ response });
    }, { times: 1 });
    try {
      // A real update triggers both projections and a privileged snapshot while the socket is still GM.
      await gmPage.getByRole('button', { name: /Next turn/ }).click();
      expect(JSON.stringify(await capturedResponse)).toContain(hiddenInitiativeLabel);
      await expect.poll(() => frames.get('observer')?.get('initiative:gm_updated')).toContain(hiddenInitiativeLabel);
      expect((await requestJson(gmPage, observerRole, 'POST', { role: 'PLAYER' })).status).toBe(200);
      await expect(observerPage.locator('.role-badge')).toHaveText('PLAYER');
      await expect(observerPage.locator('.live-status')).toHaveText('Live');
      await expect(observerPage.locator('.initiative-row')).toHaveCount(visibleEntries.length);
      const delayed = observerPage.waitForResponse(async (response) =>
        response.url().endsWith(initiativePath) && response.ok() && JSON.stringify(await response.json()).includes(hiddenInitiativeLabel));
      releaseDelayed();
      await delayed;
      replay('observer', 'initiative:gm_updated');
      replay('observer', 'dice:result');
      await expect(observerPage.locator('.initiative-row').filter({ hasText: hiddenInitiativeLabel })).toHaveCount(0);
      await expect(observerPage.locator('.roll-row').filter({ hasText: 'Private roll · GMs only' })).toHaveCount(0);
    } finally { releaseDelayed(); }

    const tokenPath = `/api/tokens/${token.id}`;
    const ownerNote = `Current owner note ${suffix}`;
    const assigned = await requestJson(gmPage, `${tokenPath}/owner`, 'POST', { ownerUserId: playerUser.id });
    expect(assigned.status).toBe(200);
    const { token: assignedToken } = assigned.body as { token: { version: number } };
    const noteEdit = await requestJson(gmPage, tokenPath, 'PATCH', { expectedVersion: assignedToken.version, ownerNote });
    expect(noteEdit.status).toBe(200);
    await expect(playerPage.locator('.token-owner-notes')).toContainText(ownerNote);
    await expect(observerPage.locator('.token-owner-notes')).toHaveCount(0);
    const transferred = await requestJson(gmPage, `${tokenPath}/owner`, 'POST', { ownerUserId: observerUser.id });
    expect(transferred.status).toBe(200);
    await expect(observerPage.locator('.token-owner-notes')).toContainText(ownerNote);
    await expect(playerPage.locator('.token-owner-notes')).toHaveCount(0);
    replay('player', 'token:owner_note');
    await expect(playerPage.locator('.token-owner-notes')).toHaveCount(0);
    await expect(playerPage.locator('.initiative-list .initiative-row.active')).toHaveCount(1);
    await gmPage.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(playerPage.getByText('Initiative is not active.')).toBeVisible();

    await playerPage.evaluate(() => {
      (window as typeof window & { nriPointerEvents?: Array<{ sceneId: string; displayName: string }> }).nriPointerEvents = [];
      window.addEventListener('nri-shared-pointer', (event) => {
        const pointer = (event as CustomEvent<{ sceneId: string; displayName: string }>).detail;
        (window as typeof window & { nriPointerEvents?: Array<{ sceneId: string; displayName: string }> }).nriPointerEvents?.push(pointer);
      });
    });
    await gmPage.getByRole('button', { name: 'Pointer' }).click();
    const gmCanvas = gmPage.locator('.table-canvas canvas');
    const gmCanvasBounds = await gmCanvas.boundingBox();
    expect(gmCanvasBounds).toBeTruthy();
    await gmPage.mouse.move(gmCanvasBounds!.x + gmCanvasBounds!.width * 0.6, gmCanvasBounds!.y + gmCanvasBounds!.height * 0.45);
    await expect.poll(() => playerPage.evaluate(() => (window as typeof window & { nriPointerEvents?: unknown[] }).nriPointerEvents?.length ?? 0)).toBeGreaterThan(0);
    const receivedPointer = await playerPage.evaluate(() => (window as typeof window & { nriPointerEvents?: Array<{ sceneId: string; displayName: string }> }).nriPointerEvents?.[0]);
    expect(receivedPointer).toMatchObject({ sceneId: activeScene.id, displayName: 'E2E Guide' });
    await gmPage.getByRole('button', { name: 'Stop pointer' }).click();

    const playerScenes = await requestJson(playerPage, `/api/campaigns/${activeScene.campaignId}/scenes`);
    expect(playerScenes.status).toBe(200);
    expect((playerScenes.body as Array<{ id: string }>).map((scene) => scene.id)).toEqual([activeScene.id]);
    const playerLayers = await requestJson(playerPage, `/api/scenes/${activeScene.id}/layers`);
    expect((playerLayers.body as Array<{ kind: string }>).some((layer) => layer.kind === 'GM')).toBe(false);
    const playerObjects = await requestJson(playerPage, `/api/scenes/${activeScene.id}/objects`);
    expect((playerObjects.body as Array<{ id: string }>).some((object) => object.id === hiddenObjectId)).toBe(false);
    expect((playerObjects.body as Array<{ id: string }>).some((object) => object.id === copiedHiddenObject.id)).toBe(false);
    const deniedObjectWrite = await requestJson(playerPage, `/api/scenes/${activeScene.id}/objects`, 'POST', {
      layerId: objectsLayer!.id, kind: 'RECTANGLE', x: 10, y: 10, width: 64, height: 64,
    });
    expect(deniedObjectWrite.status).toBe(403);
    const playerDrawingCheckbox = gmPage.getByLabel('Allow Players to draw');
    if (await playerDrawingCheckbox.isChecked()) await playerDrawingCheckbox.uncheck();
    await playerDrawingCheckbox.check();
    await expect(playerPage.getByRole('button', { name: 'Draw', exact: true })).toBeVisible();
    await playerPage.getByRole('button', { name: 'Draw', exact: true }).click();
    const canvas = playerPage.locator('.table-canvas canvas');
    const canvasBounds = await canvas.boundingBox();
    expect(canvasBounds).toBeTruthy();
    const strokeCreated = playerPage.waitForResponse((response) => response.url().endsWith(`/api/scenes/${activeScene.id}/objects`) && response.request().method() === 'POST');
    const startX = canvasBounds!.x + canvasBounds!.width / 2;
    const startY = canvasBounds!.y + canvasBounds!.height / 2;
    await playerPage.mouse.move(startX, startY);
    await playerPage.mouse.down();
    await playerPage.mouse.move(startX + 48, startY + 32, { steps: 5 });
    await playerPage.mouse.up();
    expect((await strokeCreated).status()).toBe(201);
    const playerDrawingSnapshot = await requestJson(playerPage, `/api/scenes/${activeScene.id}/objects`);
    const ownStroke = (playerDrawingSnapshot.body as Array<{ kind: string; ownedByMe?: boolean; createdBy?: string }>).find((object) => object.kind === 'FREEHAND' && object.ownedByMe);
    expect(ownStroke).toBeTruthy();
    expect(ownStroke).not.toHaveProperty('createdBy');
    const ownDrawingDelete = playerPage.waitForResponse((response) => response.url().endsWith(`/api/objects/${(ownStroke as { id: string }).id}`) && response.request().method() === 'DELETE');
    await playerPage.getByRole('button', { name: 'Delete my drawing' }).click();
    expect((await ownDrawingDelete).status()).toBe(204);
    const afterOwnDrawingDelete = await requestJson(playerPage, `/api/scenes/${activeScene.id}/objects`);
    expect((afterOwnDrawingDelete.body as Array<{ id: string }>).some((object) => object.id === (ownStroke as { id: string }).id)).toBe(false);
    const remainingOwnDrawing = await requestJson(playerPage, `/api/scenes/${activeScene.id}/objects`, 'POST', {
      layerId: objectsLayer!.id, kind: 'FREEHAND', x: 16, y: 16, width: 20, height: 20, points: [{ x: 0, y: 0 }, { x: 20, y: 20 }],
    });
    expect(remainingOwnDrawing.status).toBe(201);
    const drawingRevocation = gmPage.waitForResponse((response) => response.url().endsWith(`/api/campaigns/${activeScene.campaignId}/player-drawing`) && response.request().method() === 'PUT' && response.request().postDataJSON()?.enabled === false);
    await gmPage.getByLabel('Allow Players to draw').uncheck();
    expect((await drawingRevocation).status()).toBe(200);
    const revokedDrawingWrite = await requestJson(playerPage, `/api/scenes/${activeScene.id}/objects`, 'POST', {
      layerId: objectsLayer!.id, kind: 'FREEHAND', x: 10, y: 10, width: 20, height: 20, points: [{ x: 0, y: 0 }, { x: 20, y: 20 }],
    });
    expect(revokedDrawingWrite.status).toBe(403);
    const clearMine = playerPage.getByRole('button', { name: 'Clear my drawings' });
    await expect(clearMine).toBeEnabled();
    playerPage.once('dialog', (dialog) => void dialog.accept());
    const clearMineResponse = playerPage.waitForResponse((response) => response.url().endsWith(`/api/scenes/${activeScene.id}/my-drawings`) && response.request().method() === 'DELETE');
    await clearMine.click();
    const clearMineResult = await clearMineResponse;
    expect(clearMineResult.status()).toBe(200);
    expect((await clearMineResult.json()).deletedCount).toBe(1);
    const deniedTokenEdit = await requestJson(playerPage, `/api/tokens/${token.id}`, 'PATCH', {
      expectedVersion: token.version, name: 'Unauthorized edit',
    });
    expect(deniedTokenEdit.status).toBe(403);
    const deniedTokenDuplicate = await requestJson(playerPage, `/api/tokens/${token.id}/duplicate`, 'POST', {
      sceneId: activeScene.id, expectedVersion: token.version, x: 200, y: 200,
    });
    expect(deniedTokenDuplicate.status).toBe(403);
    const deniedTokenGroupDuplicate = await requestJson(playerPage, `/api/scenes/${activeScene.id}/tokens/duplicate`, 'POST', {
      sceneId: activeScene.id, tokens: [{ tokenId: token.id, expectedVersion: token.version, x: 200, y: 200 }],
    });
    expect(deniedTokenGroupDuplicate.status).toBe(403);

    const draftTitle = `GM Draft ${suffix}`;
    await gmPage.getByRole('button', { name: /Add scene/ }).first().click();
    await gmPage.getByLabel('Scene name').fill(draftTitle);
    const draftResponsePromise = gmPage.waitForResponse((response) => response.url().endsWith('/api/scenes') && response.request().method() === 'POST');
    await gmPage.getByRole('button', { name: 'Create', exact: true }).click();
    const draftResponse = await draftResponsePromise;
    const { scene: draftScene } = await draftResponse.json() as { scene: { id: string; campaignId: string; isActive: boolean } };
    expect(draftScene.isActive).toBe(false);
    await expect(gmPage.getByText(draftTitle, { exact: true })).toBeVisible();
    await expect(playerPage.getByText(draftTitle, { exact: true })).toHaveCount(0);
    const stillPrivateScenes = await requestJson(playerPage, `/api/campaigns/${draftScene.campaignId}/scenes`);
    expect((stillPrivateScenes.body as Array<{ id: string }>).map((scene) => scene.id)).toEqual([activeScene.id]);
  } finally {
    releaseHistoryHydration();
    await Promise.all([playerPage.unrouteAll({ behavior: 'wait' }), observerPage.unrouteAll({ behavior: 'wait' })]);
    await Promise.allSettled([gmContext.close(), playerContext.close(), observerContext.close()]);
  }
});

test('campaign switches discard stale chat and dice state', async ({ browser }) => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();
  let firstCampaignHistoryId: string | null = null;
  let releaseOldHistory = () => {};
  const oldHistoryGate = new Promise<void>((resolve) => { releaseOldHistory = resolve; });
  await page.route('**/api/campaigns/*/messages', async (route) => {
    const campaignId = route.request().url().match(/\/api\/campaigns\/([^/]+)\/messages/)?.[1] ?? null;
    if (!firstCampaignHistoryId && campaignId) firstCampaignHistoryId = campaignId;
    if (campaignId === firstCampaignHistoryId) await oldHistoryGate;
    await route.continue();
  });

  try {
    await register(page, 'Switch Guide', `switch-guide-${suffix}@example.test`);
    const firstTitle = `First campaign ${suffix}`;
    await page.getByLabel('Campaign name').fill(firstTitle);
    await page.getByLabel('A short description').fill('Delayed campaign history regression');
    await page.getByRole('button', { name: /^Create/ }).click();
    await expect(page.getByRole('heading', { name: firstTitle })).toBeVisible();
    await expect.poll(() => firstCampaignHistoryId).not.toBeNull();
    await page.getByRole('button', { name: /Add scene/ }).first().click();
    await page.getByLabel('Scene name').fill(`Scene ${suffix}`);
    const sceneCreated = page.waitForResponse((response) => response.url().endsWith('/api/scenes') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    expect((await sceneCreated).status()).toBe(201);
    await expect(page.locator('.live-status')).toHaveText('Live');

    const oldChatMessage = `Old campaign message ${suffix}`;
    await page.getByPlaceholder('Write a message…').fill(oldChatMessage);
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.chat-messages')).toContainText(oldChatMessage);
    await page.getByRole('button', { name: /d20/ }).click();
    await expect(page.locator('.roll-row')).toHaveCount(1);

    await page.getByRole('button', { name: '← Campaigns' }).click();
    await expect(page.getByRole('heading', { name: 'Your campaigns' })).toBeVisible();
    const secondTitle = `Second campaign ${suffix}`;
    await page.getByLabel('Campaign name').fill(secondTitle);
    await page.getByLabel('A short description').fill('Campaign-local chat and dice state');
    await page.getByRole('button', { name: /^Create/ }).click();
    await expect(page.getByRole('heading', { name: secondTitle })).toBeVisible();
    await expect(page.locator('.chat-messages')).toBeEmpty();
    await expect(page.locator('.roll-row')).toHaveCount(0);

    const staleHistoryResponsePromise = page.waitForResponse((response) => response.url().includes(`/api/campaigns/${firstCampaignHistoryId}/messages`) && response.request().method() === 'GET');
    releaseOldHistory();
    const staleHistoryResponse = await staleHistoryResponsePromise;
    expect((await staleHistoryResponse.json() as Array<{ body: string }>).some((message) => message.body === oldChatMessage)).toBe(true);
    await expect(page.locator('.chat-messages')).toBeEmpty();
    await expect(page.locator('.roll-row')).toHaveCount(0);
  } finally {
    releaseOldHistory();
    await context.close();
  }
});

test('GM can select, copy, and paste scene objects atomically', async ({ browser, baseURL }) => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const gmContext = await browser.newContext({ locale: 'en-US' });
  const playerContext = await browser.newContext({ locale: 'en-US' });
  const gmPage = await gmContext.newPage();
  const playerPage = await playerContext.newPage();
  const objectFrames = new Map<string, string>();
  let playerWire: import('@playwright/test').WebSocketRoute | undefined;
  await playerPage.routeWebSocket((url) => url.pathname === '/socket.io/', (wire) => {
    playerWire = wire;
    wire.connectToServer().onMessage((packet) => {
      if (typeof packet === 'string' && packet.startsWith('42[')) {
        const [event, payload] = JSON.parse(packet.slice(2)) as [string, { object?: { id: string; version: number } }];
        if ((event === 'scene:object_created' || event === 'scene:object_updated') && payload.object) {
          objectFrames.set(`${payload.object.id}:${payload.object.version}`, packet);
        }
      }
      wire.send(packet);
    });
  });

  try {
    await register(gmPage, 'Clipboard Guide', `clipboard-guide-${suffix}@example.test`);
    const campaignTitle = `Clipboard Campaign ${suffix}`;
    await gmPage.getByLabel('Campaign name').fill(campaignTitle);
    await gmPage.getByLabel('A short description').fill('Atomic scene object clipboard');
    await gmPage.getByRole('button', { name: /^Create/ }).click();
    await expect(gmPage.getByRole('heading', { name: campaignTitle })).toBeVisible();

    const activeTitle = `Clipboard Scene ${suffix}`;
    await gmPage.getByRole('button', { name: /Add scene/ }).first().click();
    await gmPage.getByLabel('Scene name').fill(activeTitle);
    const sceneResponsePromise = gmPage.waitForResponse((response) => response.url().endsWith('/api/scenes') && response.request().method() === 'POST');
    await gmPage.getByRole('button', { name: /^Create/ }).click();
    const { scene } = await (await sceneResponsePromise).json() as { scene: { id: string; campaignId: string } };
    const layers = (await requestJson(gmPage, `/api/scenes/${scene.id}/layers`)).body as Array<{ id: string; kind: string; version: number }>;
    const objectsLayer = layers.find((layer) => layer.kind === 'OBJECTS')!;
    const sourceObjects: Array<{ id: string; version: number }> = [];
    for (const x of [220, 320]) {
      const created = await requestJson(gmPage, `/api/scenes/${scene.id}/objects`, 'POST', {
        layerId: objectsLayer.id, kind: 'RECTANGLE', x, y: 220, width: 64, height: 64, color: '#6688cc', visible: true,
      });
      expect(created.status).toBe(201);
      sourceObjects.push((created.body as { object: { id: string; version: number } }).object);
    }

    const inviteResult = await requestJson(gmPage, '/api/invitations', 'POST', { campaignId: scene.campaignId, expiresInHours: 1 });
    const { invitation } = inviteResult.body as { invitation: string };
    await playerPage.goto(new URL(`/?invite=${encodeURIComponent(invitation)}`, baseURL).toString());
    await playerPage.getByRole('button', { name: 'Create account' }).click();
    await playerPage.getByLabel('Display name').fill('Clipboard Player');
    await playerPage.getByLabel('Email').fill(`clipboard-player-${suffix}@example.test`);
    await playerPage.getByLabel('Password').fill('e2e-test-password-24');
    const acceptPromise = playerPage.waitForResponse((response) => /\/api\/invitations\/[^/]+\/accept$/.test(new URL(response.url()).pathname));
    await playerPage.getByRole('button', { name: 'Create account', exact: true }).first().click();
    expect((await acceptPromise).status()).toBe(200);
    await expect(playerPage.getByRole('heading', { name: campaignTitle })).toBeVisible();

    await gmPage.locator('details.layer-tools summary').click();
    await gmPage.locator('.layer-select').filter({ hasText: 'Objects' }).click();
    await expect(gmPage.locator(`.scene-object-row[data-object-id="${sourceObjects[0]!.id}"]`)).toBeVisible();
    for (const [index, source] of sourceObjects.entries()) {
      await gmPage.locator(`.scene-object-row[data-object-id="${source.id}"] .object-select`).click(index ? { modifiers: ['Shift'] } : {});
    }

    const groupCopyResponsePromise = gmPage.waitForResponse((response) => response.url().endsWith(`/api/scenes/${scene.id}/objects/duplicate`) && response.request().method() === 'POST');
    await gmPage.getByRole('button', { name: 'Copy selected objects' }).click();
    await gmPage.getByRole('button', { name: 'Paste objects' }).click();
    const groupCopyResponse = await groupCopyResponsePromise;
    expect(groupCopyResponse.status()).toBe(201);
    const copied = (await groupCopyResponse.json() as { objects: Array<{ id: string; version: number }> }).objects;
    expect(copied).toHaveLength(2);
    expect(new Set(copied.map((object) => object.id)).size).toBe(2);
    expect(copied.every((object) => !sourceObjects.some((source) => source.id === object.id))).toBe(true);

    const beforeConflict = await requestJson(gmPage, `/api/scenes/${scene.id}/objects`);
    const staleCopy = await requestJson(gmPage, `/api/scenes/${scene.id}/objects/duplicate`, 'POST', {
      layerId: objectsLayer.id,
      objects: [
        { objectId: sourceObjects[0]!.id, expectedVersion: sourceObjects[0]!.version + 99, x: 400, y: 400 },
        { objectId: sourceObjects[1]!.id, expectedVersion: sourceObjects[1]!.version, x: 500, y: 400 },
      ],
    });
    expect(staleCopy.status).toBe(409);
    const afterConflict = await requestJson(gmPage, `/api/scenes/${scene.id}/objects`);
    expect((afterConflict.body as unknown[]).length).toBe((beforeConflict.body as unknown[]).length);
    const playerObjects = await requestJson(playerPage, `/api/scenes/${scene.id}/objects`);
    expect(copied.every((object) => (playerObjects.body as Array<{ id: string }>).some((item) => item.id === object.id))).toBe(true);
    const deniedCopy = await requestJson(playerPage, `/api/scenes/${scene.id}/objects/duplicate`, 'POST', {
      layerId: objectsLayer.id, objects: [{ objectId: sourceObjects[0]!.id, expectedVersion: sourceObjects[0]!.version, x: 500, y: 500 }],
    });
    expect(deniedCopy.status).toBe(403);

    const historyPath = `/api/scenes/${scene.id}/object-lifecycle`;
    const waitForHistory = () => gmPage.waitForResponse((response) => response.url().endsWith(historyPath) && response.request().method() === 'PATCH');
    const undo = gmPage.getByRole('button', { name: 'Undo', exact: true });
    await expect(undo).toBeEnabled();
    const undoResponse = waitForHistory();
    await gmPage.keyboard.press('Control+z');
    expect((await undoResponse).status()).toBe(200);
    const afterUndo = (await requestJson(playerPage, `/api/scenes/${scene.id}/objects`)).body as typeof copied;
    expect(afterUndo.map(({ id }) => id).sort()).toEqual(sourceObjects.map(({ id }) => id).sort());

    const redoResponse = waitForHistory();
    await gmPage.keyboard.press('Control+Shift+z');
    const redoing = await redoResponse;
    expect(redoing.status()).toBe(200);
    const restored = (await redoing.json() as { objects: typeof copied }).objects;
    expect(restored.map(({ id }) => id).sort()).toEqual(copied.map(({ id }) => id).sort());

    const { user } = (await requestJson(playerPage, '/api/auth/me')).body as { user: { id: string } };
    expect((await requestJson(gmPage, `/api/campaigns/${scene.campaignId}/members/${user.id}/role`, 'POST', { role: 'GM' })).status).toBe(200);
    await expect(playerPage.getByRole('button', { name: 'Add token' })).toBeVisible();
    expect((await requestJson(playerPage, `/api/objects/${restored[0]!.id}`, 'PATCH', { expectedVersion: restored[0]!.version, x: 777 })).status).toBe(200);
    const conflictResponse = waitForHistory();
    await undo.click();
    expect((await conflictResponse).status()).toBe(409);
    await expect(gmPage.getByText('Cannot apply history. Another change has already been saved.')).toBeVisible();
    const current = (await requestJson(gmPage, `/api/scenes/${scene.id}/objects`)).body as Array<{ id: string; x: number; version: number }>;
    expect(current.find(({ id }) => id === restored[0]!.id)?.x).toBe(777);
    expect(current.find(({ id }) => id === restored[1]!.id)?.version).toBe(restored[1]!.version);
    const redo = gmPage.getByRole('button', { name: 'Redo', exact: true });
    await expect(undo).toBeEnabled();
    await expect(redo).toBeDisabled();

    expect((await requestJson(gmPage, `/api/campaigns/${scene.campaignId}/members/${user.id}/role`, 'POST', { role: 'PLAYER' })).status).toBe(200);
    await expect(playerPage.getByRole('button', { name: 'Add token' })).toHaveCount(0);

    const id = restored[1]!.id;
    const remove = waitForHistory();
    await gmPage.locator(`.scene-object-row[data-object-id="${id}"]`).getByRole('button', { name: 'Delete', exact: true }).click();
    const removed = await remove;
    expect(removed.status()).toBe(200);
    const removedObject = (await removed.json() as { objects: typeof copied }).objects[0]!;
    expect(removedObject.version).toBe(restored[1]!.version + 1);

    const reverse = waitForHistory();
    await undo.click();
    const reversed = await reverse;
    expect(reversed.status()).toBe(200);
    expect(reversed.request().postDataJSON()).toEqual({ action: 'restore', objects: [{ objectId: id, expectedVersion: removedObject.version }] });
    const revived = (await reversed.json() as { objects: typeof copied }).objects[0]!;
    expect(revived.id).toBe(id);
    expect(revived.version).toBe(removedObject.version + 1);

    const removeAgain = waitForHistory();
    await redo.click();
    const repeated = await removeAgain;
    expect(repeated.status()).toBe(200);
    expect(repeated.request().postDataJSON()).toEqual({ action: 'delete', objects: [{ objectId: id, expectedVersion: revived.version }] });
    expect((await repeated.json() as { objects: typeof copied }).objects[0]!.version).toBe(revived.version + 1);

    const objectsPath = `/api/scenes/${scene.id}/objects`;
    const playerSnapshot = (check: (rows: typeof copied) => boolean) => playerPage.waitForResponse(async (response) =>
      response.url().endsWith(objectsPath) && response.request().method() === 'GET' && response.ok() &&
      check(await response.json() as typeof copied));
    const source = sourceObjects[1]!;
    const revision = (version: number, x: number) => requestJson(gmPage, `/api/objects/${source.id}`, 'PATCH', { expectedVersion: version, x });
    const frameKey = `${source.id}:${source.version + 1}`;
    const older = playerSnapshot((rows) => rows.some((object) => object.id === source.id && object.version === source.version + 1));
    expect((await revision(source.version, 380)).status).toBe(200);
    await older;
    await expect.poll(() => objectFrames.has(frameKey)).toBe(true);
    const oldFrame = objectFrames.get(frameKey)!;
    const latest = (rows: typeof copied) => rows.filter((object) => object.id === source.id).length === 1 &&
      rows.some((object) => object.id === source.id && object.version === source.version + 2);
    const currentRevision = playerSnapshot(latest);
    expect((await revision(source.version + 1, 440)).status).toBe(200);
    await currentRevision;
    const repeatedSnapshot = playerSnapshot(latest);
    playerWire!.send(oldFrame);
    playerWire!.send(oldFrame);
    await repeatedSnapshot;

    const hidden = playerSnapshot((rows) => rows.length === 0);
    expect((await requestJson(gmPage, `/api/layers/${objectsLayer.id}`, 'PATCH', {
      expectedVersion: objectsLayer.version, visibleToPlayers: false,
    })).status).toBe(200);
    await hidden;
    const canvas = playerPage.locator('.table-canvas canvas');
    const afterPaint = () => playerPage.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    await afterPaint();
    const hiddenCanvas = await canvas.screenshot();
    const replayWhileHidden = playerSnapshot((rows) => rows.length === 0);
    playerWire!.send(oldFrame);
    await replayWhileHidden;
    await afterPaint();
    expect((await canvas.screenshot()).equals(hiddenCanvas)).toBe(true);

    const shown = playerSnapshot(latest);
    expect((await requestJson(gmPage, `/api/layers/${objectsLayer.id}`, 'PATCH', {
      expectedVersion: objectsLayer.version + 1, visibleToPlayers: true,
    })).status).toBe(200);
    await shown;
    const deletedFrame = objectFrames.get(`${id}:${revived.version}`);
    expect(deletedFrame).toBeTruthy();
    const afterTombstone = playerSnapshot((rows) => rows.every((object) => object.id !== id));
    playerWire!.send(deletedFrame!);
    await afterTombstone;

    const draftTitle = `History draft ${suffix}`;
    await gmPage.getByRole('button', { name: /Add scene/ }).first().click();
    await gmPage.getByLabel('Scene name').fill(draftTitle);
    await gmPage.getByRole('button', { name: /^Create/ }).click();
    await gmPage.locator('.scene-tab').filter({ hasText: draftTitle }).click();
    await expect(undo).toBeDisabled();
    await expect(redo).toBeDisabled();
    await gmPage.locator('.scene-tab').filter({ hasText: activeTitle }).click();
    await expect(undo).toBeDisabled();
    const layerPanel = gmPage.locator('details.layer-tools');
    if (!(await layerPanel.evaluate((element) => (element as HTMLDetailsElement).open))) await layerPanel.locator('summary').click();
    await layerPanel.locator('.layer-select').filter({ hasText: 'Objects' }).click();

    const nextDeletion = waitForHistory();
    await gmPage.locator(`.scene-object-row[data-object-id="${sourceObjects[0]!.id}"]`).getByRole('button', { name: 'Delete', exact: true }).click();
    expect((await nextDeletion).status()).toBe(200);
    await expect(undo).toBeEnabled();
    await gmPage.getByRole('button', { name: /Campaigns/ }).click();
    const secondTitle = `History campaign ${suffix}`;
    await gmPage.getByLabel('Campaign name').fill(secondTitle);
    await gmPage.getByRole('button', { name: /^Create/ }).click();
    await expect(gmPage.getByRole('heading', { name: secondTitle })).toBeVisible();
    await expect(undo).toBeDisabled();
    await expect(redo).toBeDisabled();
    const campaigns = (await requestJson(gmPage, '/api/campaigns')).body as Array<{ campaign: { id: string; title: string } }>;
    const second = campaigns.find((item) => item.campaign.title === secondTitle)!.campaign;
    const newScene = (await requestJson(gmPage, '/api/scenes', 'POST', { campaignId: second.id, title: 'Next active scene' })).body as { scene: { id: string } };
    const join = (await requestJson(gmPage, '/api/invitations', 'POST', { campaignId: second.id })).body as { invitation: string };
    await playerPage.goto(new URL(`/?invite=${encodeURIComponent(join.invitation)}`, baseURL).toString());
    await expect(playerPage.getByRole('heading', { name: secondTitle })).toBeVisible();
    await expect(playerPage.locator('.scene-tab').filter({ hasText: 'Next active scene' })).toBeVisible();
    await afterPaint();
    const nextCanvas = await canvas.screenshot();
    let staleReads = 0;
    playerPage.on('request', (request) => { if (request.url().endsWith(objectsPath)) staleReads++; });
    playerWire!.send(oldFrame);
    await afterPaint();
    expect((await canvas.screenshot()).equals(nextCanvas)).toBe(true);
    expect(staleReads).toBe(0);
    expect((await requestJson(playerPage, `/api/scenes/${newScene.scene.id}/objects`)).body).toEqual([]);
  } finally {
    await Promise.allSettled([gmContext.close(), playerContext.close()]);
  }
});

test('GM can drag image files into the campaign asset library', async ({ browser }) => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();
  try {
    await register(page, 'Asset Guide', `assets-${suffix}@example.test`);
    const campaignTitle = `Asset Drop ${suffix}`;
    await page.getByLabel('Campaign name').fill(campaignTitle);
    await page.getByLabel('A short description').fill('Isolated asset drop acceptance data');
    await page.getByRole('button', { name: /^Create/ }).click();
    await expect(page.getByRole('heading', { name: campaignTitle })).toBeVisible();
    await page.getByRole('button', { name: 'Add scene' }).first().click();
    await page.getByLabel('Scene name').fill('Asset table');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Add token' })).toBeEnabled();
    await page.getByRole('button', { name: 'Asset library' }).click();
    await page.getByLabel('Upload as').selectOption('MAP');

    const uploadResponsePromise = page.waitForResponse((response) => response.url().includes('/api/campaigns/') && response.url().includes('/assets?category=MAP') && response.request().method() === 'POST');
    await page.getByTestId('asset-drop-zone').evaluate((element) => {
      const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2;
      const transfer = new DataTransfer();
      canvas.toBlob((blob) => {
        if (!blob) throw new Error('Could not create test PNG');
        transfer.items.add(new File([blob], 'dropped-map.png', { type: 'image/png' }));
        element.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
        element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      }, 'image/png');
    });
    const uploadResponse = await uploadResponsePromise;
    expect(uploadResponse.status()).toBe(201);
    const uploadBody = await uploadResponse.json() as { asset: { id: string; name: string } };
    expect(uploadBody.asset.name).toBe('dropped-map.png');
    await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('dropped-map.png');
    await expect(page.getByRole('img', { name: 'dropped-map.png' })).toHaveAttribute('src', `/api/assets/${uploadBody.asset.id}?variant=thumbnail`);
    await expect(page.getByRole('link', { name: 'dropped-map.png' })).toHaveAttribute('href', `/api/assets/${uploadBody.asset.id}`);
    await page.getByLabel('New folder name').fill('Session maps');
    await page.getByRole('button', { name: 'Create folder' }).click();
    await page.getByLabel('Folder: dropped-map.png').selectOption({ label: 'Session maps' });
    await page.getByLabel('Folder filter').selectOption({ label: 'Session maps' });
    await expect(page.locator('.asset-card')).toHaveCount(1);
    page.once('dialog', (dialog) => dialog.accept('Travel maps'));
    await page.getByRole('button', { name: 'Rename folder' }).click();
    await expect(page.getByLabel('Folder filter')).toHaveValue(/.+/);
    await expect(page.getByLabel('Folder filter').locator('option', { hasText: 'Travel maps' })).toHaveCount(1);
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Delete folder' }).click();
    await expect(page.getByLabel('Folder: dropped-map.png')).toHaveValue('');
    await page.getByLabel('Upload as').selectOption('TOKEN');
    const tokenUploadPromise = page.waitForResponse((response) => response.url().includes('/api/campaigns/') && response.url().includes('/assets?category=TOKEN') && response.request().method() === 'POST');
    await page.getByTestId('asset-drop-zone').evaluate((element) => {
      const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16;
      const context = canvas.getContext('2d')!; context.fillStyle = '#cf7048'; context.fillRect(0, 0, 16, 16);
      const transfer = new DataTransfer();
      canvas.toBlob((blob) => {
        if (!blob) throw new Error('Could not create token PNG');
        transfer.items.add(new File([blob], 'dropped-token.png', { type: 'image/png' }));
        element.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
        element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      }, 'image/png');
    });
    const tokenUpload = await tokenUploadPromise;
    expect(tokenUpload.status()).toBe(201);
    const tokenUploadBody = await tokenUpload.json() as { asset: { id: string; name: string } };
    expect(tokenUploadBody.asset.name).toBe('dropped-token.png');
    const tokenAssetCard = page.locator('.asset-card').nth(1);
    await expect(tokenAssetCard).toHaveAttribute('draggable', 'true');
    const canvasBounds = await page.locator('.table-canvas canvas').boundingBox();
    expect(canvasBounds).toBeTruthy();
    const tokenCreatedPromise = page.waitForResponse((response) => response.url().endsWith('/api/tokens') && response.request().method() === 'POST');
    await tokenAssetCard.dragTo(page.locator('body'), { targetPosition: { x: canvasBounds!.x + canvasBounds!.width * 0.62, y: canvasBounds!.y + canvasBounds!.height * 0.44 } });
    const tokenCreated = await tokenCreatedPromise;
    expect(tokenCreated.status()).toBe(201);
    const createdToken = (await tokenCreated.json() as { token: { imageAssetId: string } }).token;
    expect(createdToken.imageAssetId).toBe(tokenUploadBody.asset.id);
  } finally {
    await context.close();
  }
});

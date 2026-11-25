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

test('separate GM and player contexts keep drafts and GM objects private', async ({ browser, baseURL }) => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const gmContext = await browser.newContext({ locale: 'en-US' });
  const playerContext = await browser.newContext({ locale: 'en-US' });
  const gmPage = await gmContext.newPage();
  const playerPage = await playerContext.newPage();

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
    await Promise.allSettled([gmContext.close(), playerContext.close()]);
  }
});

test('GM can select, copy, and paste scene objects atomically', async ({ browser, baseURL }) => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const gmContext = await browser.newContext({ locale: 'en-US' });
  const playerContext = await browser.newContext({ locale: 'en-US' });
  const gmPage = await gmContext.newPage();
  const playerPage = await playerContext.newPage();

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
    const layers = (await requestJson(gmPage, `/api/scenes/${scene.id}/layers`)).body as Array<{ id: string; kind: string }>;
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
    const copied = (await groupCopyResponse.json() as { objects: Array<{ id: string }> }).objects;
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
    await expect(page.getByRole('textbox', { name: 'Name' })).toHaveValue('dropped-map.png');
  } finally {
    await context.close();
  }
});

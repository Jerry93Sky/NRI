import { expect, test } from '@playwright/test';

async function register(page: import('@playwright/test').Page, email: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Display name').fill('Copy Test GM');
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

test('GM can copy a campaign with independent maps, scenes, tokens and objects', async ({ browser, page }) => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const title = `Copy source ${suffix}`;
  await register(page, `copy-${suffix}@example.test`);
  await page.getByLabel('Campaign name').fill(title);
  await page.getByLabel('A short description').fill('Copy workflow verification');
  await page.getByRole('button', { name: /^Create/ }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();

  const campaignResponse = await requestJson(page, '/api/campaigns');
  const campaignRows = campaignResponse.body as Array<{ campaign: { id: string; title: string } }>;
  const sourceCampaign = campaignRows.find((row) => row.campaign.title === title)!.campaign;
  const firstSceneResponse = await requestJson(page, '/api/scenes', 'POST', { campaignId: sourceCampaign.id, title: 'Published room' });
  expect(firstSceneResponse.status).toBe(201);
  const firstScene = (firstSceneResponse.body as { scene: { id: string; isActive: boolean; version: number } }).scene;
  const secondSceneResponse = await requestJson(page, '/api/scenes', 'POST', { campaignId: sourceCampaign.id, title: 'GM draft' });
  expect(secondSceneResponse.status).toBe(201);
  const draftScene = (secondSceneResponse.body as { scene: { id: string; published: boolean } }).scene;

  const uploadResponse = await page.evaluate(async (campaignId) => {
    const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 128;
    const context = canvas.getContext('2d')!; context.fillStyle = '#5f796e'; context.fillRect(0, 0, 128, 128);
    context.fillStyle = '#e9c27b'; context.beginPath(); context.arc(64, 64, 28, 0, Math.PI * 2); context.fill();
    const response = await fetch(`/api/campaigns/${campaignId}/assets?category=MAP`, {
      method: 'POST', credentials: 'include',
      body: (() => { const form = new FormData(); form.append('files', new File([Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]!), (character) => character.charCodeAt(0))], 'copy-map.png', { type: 'image/png' })); return form; })(),
    });
    return { status: response.status, body: await response.json() };
  }, sourceCampaign.id);
  expect(uploadResponse.status).toBe(201);
  const mapAsset = (uploadResponse.body as { asset: { id: string } }).asset;
  const backgroundResponse = await requestJson(page, `/api/scenes/${firstScene.id}/background`, 'PUT', { assetId: mapAsset.id, expectedVersion: firstScene.version });
  expect(backgroundResponse.status).toBe(200);

  const tokenResponse = await requestJson(page, '/api/tokens', 'POST', { sceneId: firstScene.id, name: 'Source hero', x: 4, y: 5, color: '#c8794a' });
  expect(tokenResponse.status).toBe(201);
  const layersResponse = await requestJson(page, `/api/scenes/${draftScene.id}/layers`);
  const gmLayer = (layersResponse.body as Array<{ id: string; kind: string }>).find((layer) => layer.kind === 'GM')!;
  const secretObjectResponse = await requestJson(page, `/api/scenes/${draftScene.id}/objects`, 'POST', {
    layerId: gmLayer.id, kind: 'TEXT', x: 120, y: 140, width: 240, height: 64, color: '#d8b377', text: 'Copy-only GM clue', visible: false, locked: false,
  });
  expect(secretObjectResponse.status).toBe(201);

  const inviteResponse = await requestJson(page, '/api/invitations', 'POST', { campaignId: sourceCampaign.id });
  expect(inviteResponse.status).toBe(201);
  const invitation = (inviteResponse.body as { invitation: string }).invitation;
  const playerContext = await browser.newContext({ locale: 'en-US' });
  const playerPage = await playerContext.newPage();
  await playerPage.goto(`/?invite=${encodeURIComponent(invitation)}`);
  await playerPage.getByRole('button', { name: 'Create account' }).click();
  await playerPage.getByLabel('Display name').fill('Copy Test Player');
  await playerPage.getByLabel('Email').fill(`copy-player-${suffix}@example.test`);
  await playerPage.getByLabel('Password').fill('e2e-test-password-24');
  await playerPage.getByRole('button', { name: 'Create account', exact: true }).first().click();
  await expect(playerPage.getByRole('heading', { name: title })).toBeVisible();
  expect((await requestJson(playerPage, `/api/campaigns/${sourceCampaign.id}/duplicate`, 'POST', {})).status).toBe(403);

  await page.locator('.back-link').click();
  const sourceEntry = page.locator('.campaign-entry').filter({ hasText: title });
  const duplicateResponsePromise = page.waitForResponse((response) => response.url().endsWith(`/api/campaigns/${sourceCampaign.id}/duplicate`) && response.request().method() === 'POST');
  await sourceEntry.getByRole('button', { name: 'Make a copy' }).click();
  const duplicateResponse = await duplicateResponsePromise;
  expect(duplicateResponse.status()).toBe(201);
  const duplicateBody = await duplicateResponse.json() as { campaign: { id: string; title: string } };
  expect(duplicateBody.campaign.id).not.toBe(sourceCampaign.id);
  expect(duplicateBody.campaign.title).toBe(`Copy of ${title}`);
  await expect(page.getByRole('heading', { name: duplicateBody.campaign.title })).toBeVisible();

  const [sourceScenesResponse, copiedScenesResponse, copiedAssetsResponse] = await Promise.all([
    requestJson(page, `/api/campaigns/${sourceCampaign.id}/scenes`),
    requestJson(page, `/api/campaigns/${duplicateBody.campaign.id}/scenes`),
    requestJson(page, `/api/campaigns/${duplicateBody.campaign.id}/assets`),
  ]);
  const sourceScenes = sourceScenesResponse.body as Array<{ id: string; title: string; backgroundAssetId: string | null }>;
  const copiedScenes = copiedScenesResponse.body as Array<{ id: string; title: string; backgroundAssetId: string | null }>;
  expect(copiedScenes.map((scene) => scene.title)).toEqual(sourceScenes.map((scene) => scene.title));
  expect(copiedScenes.map((scene) => scene.id)).not.toEqual(sourceScenes.map((scene) => scene.id));
  expect(copiedScenes.find((scene) => scene.title === 'GM draft')).toBeTruthy();
  const copiedMapId = copiedScenes.find((scene) => scene.title === 'Published room')!.backgroundAssetId!;
  expect(copiedMapId).not.toBe(mapAsset.id);
  const copiedAssets = copiedAssetsResponse.body as { assets: Array<{ id: string; checksum: string }> };
  expect(copiedAssets.assets).toHaveLength(1);
  expect(copiedAssets.assets[0]!.id).toBe(copiedMapId);
  expect(copiedAssets.assets[0]!.checksum).toMatch(/^[0-9a-f]{64}$/);
  const copiedImage = await page.evaluate(async (assetId) => {
    const response = await fetch(`/api/assets/${assetId}`, { credentials: 'include' });
    const bytes = await response.arrayBuffer();
    return { status: response.status, contentType: response.headers.get('content-type'), byteLength: bytes.byteLength };
  }, copiedMapId);
  expect(copiedImage.status).toBe(200);
  expect(copiedImage.contentType).toBe('image/png');
  expect(copiedImage.byteLength).toBeGreaterThan(100);

  const copiedTokensResponse = await requestJson(page, `/api/scenes/${copiedScenes.find((scene) => scene.title === 'Published room')!.id}/tokens`);
  const sourceTokenId = (tokenResponse.body as { token: { id: string } }).token.id;
  const copiedTokens = copiedTokensResponse.body as Array<{ id: string; name: string }>;
  expect(copiedTokens).toHaveLength(1);
  expect(copiedTokens[0]!.id).not.toBe(sourceTokenId);
  expect(copiedTokens[0]!.name).toBe('Source hero');

  const copiedDraftId = copiedScenes.find((scene) => scene.title === 'GM draft')!.id;
  const copiedObjectsResponse = await requestJson(page, `/api/scenes/${copiedDraftId}/objects`);
  const sourceObjectId = (secretObjectResponse.body as { object: { id: string } }).object.id;
  const copiedObject = (copiedObjectsResponse.body as Array<{ id: string; text: string }>).find((object) => object.text === 'Copy-only GM clue');
  expect(copiedObject).toBeTruthy();
  expect(copiedObject!.id).not.toBe(sourceObjectId);
  const playerCampaigns = await requestJson(playerPage, '/api/campaigns');
  expect((playerCampaigns.body as Array<{ campaign: { id: string } }>).some((row) => row.campaign.id === duplicateBody.campaign.id)).toBe(false);
  await playerContext.close();
});

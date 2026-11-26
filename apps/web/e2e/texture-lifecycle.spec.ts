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

test('scene changes release unused image textures and load them again when needed', async ({ page }) => {
  test.setTimeout(120_000);
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const assetRequests: string[] = [];
  page.on('request', (request) => {
    if (/^\/api\/assets\/[0-9a-f-]+$/i.test(new URL(request.url()).pathname)) assetRequests.push(request.url());
  });

  await register(page, 'Texture GM', `texture-${suffix}@example.test`);
  const campaignTitle = `Texture lifecycle ${suffix}`;
  await page.getByLabel('Campaign name').fill(campaignTitle);
  await page.getByLabel('A short description').fill('Texture cache lifecycle verification');
  await page.getByRole('button', { name: /^Create/ }).click();
  await expect(page.getByRole('heading', { name: campaignTitle })).toBeVisible();

  await page.getByRole('button', { name: /Add scene/ }).first().click();
  await page.getByLabel('Scene name').fill(`Asset scene ${suffix}`);
  const firstSceneResponsePromise = page.waitForResponse((response) => response.url().endsWith('/api/scenes') && response.request().method() === 'POST');
  await page.getByRole('button', { name: /^Create/ }).click();
  const firstSceneResponse = await firstSceneResponsePromise;
  const { scene: firstScene } = await firstSceneResponse.json() as { scene: { id: string; campaignId: string } };
  await expect(page.locator('.table-canvas')).toBeVisible();

  const imageData = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 48; canvas.height = 48;
    const context = canvas.getContext('2d')!; context.fillStyle = '#db7948'; context.fillRect(0, 0, 48, 48);
    context.beginPath(); context.arc(24, 24, 15, 0, Math.PI * 2); context.fillStyle = '#f5d7ad'; context.fill();
    return canvas.toDataURL('image/png').split(',')[1]!;
  });
  const uploaded = await page.evaluate(async ({ campaignId, imageData }) => {
    const bytes = Uint8Array.from(atob(imageData), (character) => character.charCodeAt(0));
    const form = new FormData(); form.append('files', new Blob([bytes], { type: 'image/png' }), 'lifecycle-token.png');
    const response = await fetch(`/api/campaigns/${campaignId}/assets?category=TOKEN`, { method: 'POST', credentials: 'include', body: form });
    return { status: response.status, body: await response.json() as { assets: Array<{ id: string }> } };
  }, { campaignId: firstScene.campaignId, imageData });
  expect(uploaded.status).toBe(201);
  const assetId = uploaded.body.assets[0]!.id;
  const tokenCreated = await page.evaluate(async ({ sceneId, imageAssetId }) => {
    const response = await fetch('/api/tokens', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sceneId, name: 'Lifecycle token', x: 2, y: 2, imageAssetId }) });
    return response.status;
  }, { sceneId: firstScene.id, imageAssetId: assetId });
  expect(tokenCreated).toBe(201);
  const assetUrl = `/api/assets/${assetId}`;
  await expect.poll(() => assetRequests.filter((url) => new URL(url).pathname === assetUrl).length).toBe(1);

  await page.getByRole('button', { name: /Add scene/ }).first().click();
  const draftTitle = `Texture draft ${suffix}`;
  await page.getByLabel('Scene name').fill(draftTitle);
  await page.getByRole('button', { name: /^Create/ }).click();
  const draftTab = page.locator('.scene-tab').filter({ hasText: draftTitle });
  await expect(draftTab).toBeVisible();
  await draftTab.click();
  await expect(page.locator('.table-canvas')).toBeVisible();

  await page.locator('.scene-tab').filter({ hasText: `Asset scene ${suffix}` }).click();
  await expect.poll(() => assetRequests.filter((url) => new URL(url).pathname === assetUrl).length).toBe(2);
});

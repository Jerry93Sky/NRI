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

type WebGLCanvas = HTMLCanvasElement & {
  tabletopGL?: WebGLRenderingContext | WebGL2RenderingContext;
  lossExtension?: WEBGL_lose_context;
};

test('scene changes release textures and the visible table survives WebGL context loss', async ({ page, browser }) => {
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
  const { scene: firstScene } = await firstSceneResponse.json() as { scene: { id: string; campaignId: string; version: number } };
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

  // Record the real player canvas, which must recover without remounting the page.
  const layers = await (await page.request.get(`/api/scenes/${firstScene.id}/layers`)).json() as Array<{ id: string; kind: string }>;
  for (const layer of layers.filter(({ kind }) => kind === 'GM' || kind === 'OBJECTS')) {
    const response = await page.request.post(`/api/scenes/${firstScene.id}/objects`, { data: {
      layerId: layer.id, kind: 'RECTANGLE', x: layer.kind === 'GM' ? 620 : 940, y: 600, width: 210, height: 100,
    } });
    expect(response.status()).toBe(201);
  }
  expect((await page.request.put(`/api/scenes/${firstScene.id}/background`, { data: { assetId, expectedVersion: firstScene.version } })).status()).toBe(200);
  const invite = await page.request.post('/api/invitations', { data: { campaignId: firstScene.campaignId } });
  expect(invite.status()).toBe(201);
  const { invitation } = await invite.json() as { invitation: string };
  const playerContext = await browser.newContext({ locale: 'en-US' });
  try {
    await playerContext.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: WebGLCanvas, type: string, ...options: unknown[]) {
        const context = Reflect.apply(getContext, this, [type, ...options]);
        if (context && (type === 'webgl' || type === 'webgl2')) this.tabletopGL = context;
        return context;
      } as typeof getContext;
    });
    const player = await playerContext.newPage();
    const loadedTexture = player.waitForResponse((res) => res.url().endsWith(assetUrl) && res.ok());
    await player.goto(new URL(`/?invite=${encodeURIComponent(invitation)}`, page.url()).href);
    await player.getByRole('button', { name: 'Create account' }).click();
    await player.getByLabel('Display name').fill('Context player');
    await player.getByLabel('Email').fill(`texture-player-${suffix}@example.test`);
    await player.getByLabel('Password').fill('e2e-test-password-24');
    await player.getByRole('button', { name: 'Create account', exact: true }).first().click();
    await loadedTexture;
    const canvas = player.locator('.table-canvas canvas');
    await expect(canvas).toBeVisible();
    if (process.env.NRI_HARDWARE_CONTEXT_CHECK === '1') {
      const renderer = await canvas.evaluate((element) => {
        const gl = (element as WebGLCanvas).tabletopGL;
        const debug = gl?.getExtension('WEBGL_debug_renderer_info');
        return gl && debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : '';
      });
      expect(renderer).not.toMatch(/swiftshader|software|llvmpipe|basic render/i);
      expect(renderer.length).toBeGreaterThan(0);
      console.info(`Context-loss renderer: ${renderer}`);
    }
    const snapshot = async () => Promise.all(['layers', 'objects', 'tokens'].map(async (name) => {
      const response = await player.request.get(new URL(`/api/scenes/${firstScene.id}/${name}`, player.url()).href);
      expect(response.status()).toBe(200);
      return response.json();
    }));
    const before = await snapshot();
    expect(before[0].some(({ kind }: { kind: string }) => kind === 'GM')).toBe(false);
    expect(before[1]).toHaveLength(1);
    expect(before[2]).toHaveLength(1);
    const rendered = await canvas.screenshot();
    const writes: string[] = [];
    player.on('request', (request) => { if (/^(POST|PUT|PATCH|DELETE)$/.test(request.method())) writes.push(request.method()); });
    await canvas.evaluate(async (element) => {
      const gl = (element as WebGLCanvas).tabletopGL;
      const extension = gl?.getExtension('WEBGL_lose_context');
      if (!gl || !extension) throw new Error('The player Canvas did not expose WebGL context loss');
      (element as WebGLCanvas).lossExtension = extension;
      const lost = new Promise<void>((resolve) => element.addEventListener('webglcontextlost', () => resolve(), { once: true }));
      extension.loseContext();
      await lost;
      if (!gl.isContextLost()) throw new Error('The application Canvas did not lose its context');
    });
    await canvas.evaluate(async (element) => {
      const gl = (element as WebGLCanvas).tabletopGL!;
      const restored = new Promise<void>((resolve) => element.addEventListener('webglcontextrestored', () => resolve(), { once: true }));
      (element as WebGLCanvas).lossExtension!.restoreContext();
      await restored;
      if (gl.isContextLost()) throw new Error('The application Canvas did not restore its context');
    });
    await expect.poll(async () => (await canvas.screenshot()).equals(rendered)).toBe(true);
    expect(await snapshot()).toEqual(before);
    expect(writes).toEqual([]);
  } finally { await playerContext.close(); }
});

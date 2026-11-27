import { expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

async function requestJson(page: Page, path: string, method = 'GET', body?: unknown) {
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

async function register(page: Page, name: string, email: string, invite?: string) {
  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4175';
  await page.goto(invite ? `${baseURL}/?invite=${encodeURIComponent(invite)}` : baseURL);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Display name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('e2e-test-password-24');
  await page.getByRole('button', { name: 'Create account', exact: true }).first().click();
}

async function waitForReady(port: number, ready: boolean, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/ready`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok === ready) return;
    } catch {
      if (!ready) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`API readiness did not become ${ready ? 'ready' : 'unavailable'} within ${timeoutMs}ms`);
}

test('GM and Player sessions recover persisted campaign state after API restart', async ({ browser }) => {
  test.skip(!process.env.NRI_BROWSER_API_PID, 'Requires the isolated CI API process handle');
  test.setTimeout(180_000);
  const apiPid = Number(process.env.NRI_BROWSER_API_PID);
  expect(Number.isSafeInteger(apiPid) && apiPid > 1).toBe(true);
  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4175';
  const port = Number(process.env.PORT ?? 3001);
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const gmContext = await browser.newContext({ locale: 'en-US' });
  const playerContext = await browser.newContext({ locale: 'en-US' });
  const gmPage = await gmContext.newPage();
  const playerPage = await playerContext.newPage();
  let restartedApi: ChildProcess | undefined;
  try {
    await register(gmPage, 'Restart Guide', `restart-gm-${suffix}@example.test`);
    await expect(gmPage.getByRole('heading', { name: 'Your campaigns' })).toBeVisible();
    const campaignResponse = await requestJson(gmPage, '/api/campaigns', 'POST', { title: `Restart recovery ${suffix}`, description: '' });
    expect(campaignResponse.status).toBe(201);
    const campaignId = (campaignResponse.body as { campaign: { id: string } }).campaign.id;
    const sceneResponse = await requestJson(gmPage, '/api/scenes', 'POST', { campaignId, title: 'Persistent scene' });
    expect(sceneResponse.status).toBe(201);
    const sceneId = (sceneResponse.body as { scene: { id: string } }).scene.id;
    const tokenResponse = await requestJson(gmPage, '/api/tokens', 'POST', { sceneId, name: 'Persistent token', x: 7, y: 11, color: '#c8794a' });
    expect(tokenResponse.status).toBe(201);
    const tokenId = (tokenResponse.body as { token: { id: string } }).token.id;
    const inviteResponse = await requestJson(gmPage, '/api/invitations', 'POST', { campaignId });
    expect(inviteResponse.status).toBe(201);
    const invite = (inviteResponse.body as { invitation: string }).invitation;

    await gmPage.reload();
    await gmPage.getByRole('button', { name: new RegExp(`Restart recovery ${suffix}`) }).click();
    await expect(gmPage.getByRole('heading', { name: `Restart recovery ${suffix}` })).toBeVisible();
    await register(playerPage, 'Restart Player', `restart-player-${suffix}@example.test`, invite);
    await expect(playerPage.getByRole('heading', { name: `Restart recovery ${suffix}` })).toBeVisible();
    await expect(gmPage.locator('.live-status')).toHaveText('Live');
    await expect(playerPage.locator('.live-status')).toHaveText('Live');
    const initialPlayerTokens = (await requestJson(playerPage, `/api/scenes/${sceneId}/tokens`)).body as Array<{ id: string; x: number; y: number }>;
    expect(initialPlayerTokens).toContainEqual(expect.objectContaining({ id: tokenId, x: 7, y: 11 }));

    process.kill(apiPid, 'SIGTERM');
    await waitForReady(port, false);
    await expect(gmPage.locator('.live-status')).toHaveText(/Reconnecting|Offline/, { timeout: 15_000 });
    await expect(playerPage.locator('.live-status')).toHaveText(/Reconnecting|Offline/, { timeout: 15_000 });

    restartedApi = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: fileURLToPath(new URL('../../server', import.meta.url)),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: String(port),
        WEB_ORIGIN: baseURL,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let startupLog = '';
    const capture = (chunk: Buffer) => { startupLog = (startupLog + chunk.toString()).slice(-8_000); };
    restartedApi.stdout?.on('data', capture);
    restartedApi.stderr?.on('data', capture);
    const startupError = new Promise<never>((_resolve, reject) => {
      restartedApi!.once('error', reject);
      restartedApi!.once('exit', (code, signal) => reject(new Error(`Restarted API exited (${signal ?? code}):\n${startupLog}`)));
    });
    try { await Promise.race([waitForReady(port, true), startupError]); }
    catch (error) { throw new Error(`Restarted API failed readiness:\n${startupLog}`, { cause: error }); }
    await expect(gmPage.locator('.live-status')).toHaveText('Live', { timeout: 60_000 });
    await expect(playerPage.locator('.live-status')).toHaveText('Live', { timeout: 60_000 });

    expect((await requestJson(gmPage, '/api/auth/me')).status).toBe(200);
    expect((await requestJson(playerPage, '/api/auth/me')).status).toBe(200);
    const gmTokens = (await requestJson(gmPage, `/api/scenes/${sceneId}/tokens`)).body as Array<{ id: string; x: number; y: number }>;
    const playerTokens = (await requestJson(playerPage, `/api/scenes/${sceneId}/tokens`)).body as Array<{ id: string; x: number; y: number }>;
    expect(gmTokens).toContainEqual(expect.objectContaining({ id: tokenId, x: 7, y: 11 }));
    expect(playerTokens).toContainEqual(expect.objectContaining({ id: tokenId, x: 7, y: 11 }));
  } finally {
    await Promise.all([gmContext.close(), playerContext.close()]);
    restartedApi?.kill();
  }
});

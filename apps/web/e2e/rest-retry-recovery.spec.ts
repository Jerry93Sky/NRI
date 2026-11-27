import { expect, test } from '@playwright/test';

async function register(page: import('@playwright/test').Page, email: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Display name').fill('REST Retry GM');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('e2e-test-password-24');
  await page.getByRole('button', { name: 'Create account', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Your campaigns' })).toBeVisible();
}

async function loseFirstResponse(page: import('@playwright/test').Page, pathSuffix: string) {
  const requestIds: string[] = [];
  let first = true;
  await page.route((url) => url.pathname.endsWith(pathSuffix), async (route) => {
    requestIds.push(route.request().headers()['idempotency-key'] ?? '');
    if (first) {
      first = false;
      await route.fetch(); // Let the API commit, then discard only the response delivered to the browser.
      await route.abort('failed');
      return;
    }
    await route.continue();
  });
  return requestIds;
}

test('REST create retries after a committed response is dropped and reuses the same request IDs', async ({ page }) => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const title = `Retry campaign ${suffix}`;
  await register(page, `rest-retry-${suffix}@example.test`);

  const campaignRequestId = await loseFirstResponse(page, '/api/campaigns');
  await page.getByLabel('Campaign name').fill(title);
  await page.getByLabel('A short description').fill('lost response recovery');
  await page.getByRole('button', { name: /^Create/ }).click();
  await expect(page.getByText(/response was not received/i)).toBeVisible();
  const campaignReplay = page.waitForResponse((response) => response.url().endsWith('/api/campaigns') && response.request().method() === 'POST');
  await page.getByRole('button', { name: /^Create/ }).click();
  expect((await campaignReplay).status()).toBe(200);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  expect(campaignRequestId()).toHaveLength(2);
  expect(campaignRequestId()[0]).toMatch(/^[0-9a-f-]{36}$/i);
  expect(campaignRequestId()[1]).toBe(campaignRequestId()[0]);

  const sceneRequestId = await loseFirstResponse(page, '/api/scenes');
  await page.getByRole('button', { name: /Add scene/ }).click();
  await page.getByLabel('Scene name').fill('Retry room');
  await page.getByRole('button', { name: /^Create/ }).click();
  await expect(page.getByText(/response was not received/i)).toBeVisible();
  const sceneReplay = page.waitForResponse((response) => response.url().endsWith('/api/scenes') && response.request().method() === 'POST');
  await page.getByRole('button', { name: /^Create/ }).click();
  expect((await sceneReplay).status()).toBe(200);
  await expect(page.locator('.scene-tab').filter({ hasText: 'Retry room' })).toBeVisible();
  expect(sceneRequestId()).toHaveLength(2);
  expect(sceneRequestId()[1]).toBe(sceneRequestId()[0]);

  const tokenRequestId = await loseFirstResponse(page, '/api/tokens');
  await page.getByRole('button', { name: /Add token/ }).click();
  await expect(page.getByText(/response was not received/i)).toBeVisible();
  const tokenReplay = page.waitForResponse((response) => response.url().includes('/api/tokens') && response.status() === 200);
  await page.getByRole('button', { name: /Add token/ }).click();
  await tokenReplay;
  expect(tokenRequestId()).toHaveLength(2);
  expect(tokenRequestId()[1]).toBe(tokenRequestId()[0]);
});

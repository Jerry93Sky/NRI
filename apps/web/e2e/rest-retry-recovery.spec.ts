import { expect, test, type APIResponse, type Page, type Response } from '@playwright/test';

async function register(page: Page, email: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Display name').fill('REST Retry GM');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('e2e-test-password-24');
  await page.getByRole('button', { name: 'Create account', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Your campaigns' })).toBeVisible();
}

async function loseFirstResponse(page: Page, path: string) {
  const requestIds: string[] = [];
  const dropped: APIResponse[] = [];
  await page.route((url) => url.pathname === path, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    requestIds.push(route.request().headers()['idempotency-key'] ?? '');
    if (requestIds.length === 1) {
      dropped.push(await route.fetch());
      await route.abort('failed');
      return;
    }
    await route.continue();
  });
  return { requestIds, dropped };
}

async function expectReplay(first: Awaited<ReturnType<typeof loseFirstResponse>>, replay: Response, entity: string, replayStatus = 200) {
  expect(first.requestIds).toHaveLength(2);
  expect(first.requestIds[0]).toMatch(/^[0-9a-f-]{36}$/i);
  expect(first.requestIds[1]).toBe(first.requestIds[0]);
  expect(first.dropped[0]?.status()).toBe(201);
  expect(replay.status()).toBe(replayStatus);
  const ids = (body: Record<string, { id: string } | { id: string }[]>) => {
    const result = body[entity];
    if (!result) throw new Error(`Missing result: ${entity}`);
    return Array.isArray(result) ? result.map(({ id }) => id) : [result.id];
  };
  expect(ids(await replay.json())).toEqual(ids(await first.dropped[0]!.json()));
}

test('REST create, copy and upload recover committed results after lost responses', async ({ page }) => {
  page.setDefaultTimeout(10_000);
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const title = `Retry campaign ${suffix}`;
  await register(page, `rest-retry-${suffix}@example.test`);

  const campaignAttempt = await loseFirstResponse(page, '/api/campaigns');
  await page.getByLabel('Campaign name').fill(title);
  await page.getByLabel('A short description').fill('lost response recovery');
  await page.getByRole('button', { name: /^Create/ }).click();
  await expect(page.getByText(/response was lost|ответ не получен/i)).toBeVisible();
  const campaignReplay = page.waitForResponse((response) => response.url().endsWith('/api/campaigns') && response.request().method() === 'POST');
  await page.getByRole('button', { name: /^Create/ }).click();
  await expectReplay(campaignAttempt, await campaignReplay, 'campaign');
  await expect(page.getByRole('heading', { name: title })).toBeVisible();

  const sceneAttempt = await loseFirstResponse(page, '/api/scenes');
  await page.getByRole('button', { name: '＋ Add scene', exact: true }).click();
  await page.getByLabel('Scene name').fill('Retry room');
  await page.getByRole('button', { name: /^Create/ }).click();
  await expect(page.getByText(/response was lost|ответ не получен/i)).toBeVisible();
  const sceneReplay = page.waitForResponse((response) => response.url().endsWith('/api/scenes') && response.request().method() === 'POST');
  await page.getByRole('button', { name: /^Create/ }).click();
  await expectReplay(sceneAttempt, await sceneReplay, 'scene');
  await expect(page.locator('.scene-tab').filter({ hasText: 'Retry room' })).toBeVisible();

  const tokenAttempt = await loseFirstResponse(page, '/api/tokens');
  await page.getByRole('button', { name: /Add token/ }).click();
  await expect(page.getByText(/response was lost|ответ не получен/i)).toBeVisible();
  const tokenReplay = page.waitForResponse((response) => response.url().endsWith('/api/tokens') && response.request().method() === 'POST');
  await page.getByRole('button', { name: /Add token/ }).click();
  await expectReplay(tokenAttempt, await tokenReplay, 'token');

  const { scene } = await sceneAttempt.dropped[0]!.json();
  const { campaign } = await campaignAttempt.dropped[0]!.json();
  const secondToken = await page.request.post('/api/tokens', { data: { sceneId: scene.id, name: 'Second source', x: 6, y: 3, color: '#668d7b' } });
  expect(secondToken.status()).toBe(201);
  await expect(page.getByRole('checkbox', { name: 'Select Second source' })).toBeVisible();
  await page.locator('.token-group-tools').getByRole('button', { name: 'Select all', exact: true }).click();
  await page.getByRole('button', { name: 'Copy selected', exact: true }).click();
  await checkCopy(page, `/api/scenes/${scene.id}/tokens/duplicate`, 'Paste copied', 'tokens');

  const layers = await (await page.request.get(`/api/scenes/${scene.id}/layers`)).json() as { id: string; kind: string }[];
  const layer = layers.find(({ kind }) => kind === 'OBJECTS')!;
  const objectPath = `/api/scenes/${scene.id}/objects`;
  const created = await page.request.post(objectPath, { data: { layerId: layer.id, kind: 'RECTANGLE', x: 220, y: 220, color: '#6688cc' } });
  expect(created.status()).toBe(201);
  const { object } = await created.json();
  await page.locator('details.layer-tools summary').click();
  await page.locator('.layer-select').filter({ hasText: 'Objects' }).click();
  await page.locator(`.scene-object-row[data-object-id="${object.id}"] .object-select`).click();
  await page.getByRole('button', { name: 'Copy selected objects' }).click();
  await checkCopy(page, `${objectPath}/duplicate`, 'Paste objects', 'objects');

  await page.getByRole('button', { name: 'Asset library' }).click();
  await page.getByLabel('Upload as').selectOption('MAP');
  const uploadPath = `/api/campaigns/${campaign.id}/assets`;
  const uploadAttempt = await loseFirstResponse(page, uploadPath);
  const dropFile = () => page.getByTestId('asset-drop-zone').evaluate(async (element) => {
    const canvas = document.createElement('canvas');
    canvas.width = 2; canvas.height = 2;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Could not create test PNG');
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], 'retry-map.png', { type: 'image/png', lastModified: 1 }));
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await dropFile();
  await expect(page.getByRole('alert')).toContainText('The response was lost');
  const uploadReplay = page.waitForResponse((response) => new URL(response.url()).pathname === uploadPath && response.request().method() === 'POST');
  await dropFile();
  await expectReplay(uploadAttempt, await uploadReplay, 'assets', 201);
  await expect(page.locator('.asset-card')).toHaveCount(1);
});

async function checkCopy(page: Page, path: string, buttonName: string, entity: string) {
  const attempt = await loseFirstResponse(page, path);
  const paste = page.getByRole('button', { name: buttonName, exact: true });
  await paste.click();
  await expect(page.getByRole('alert')).toContainText('The response was lost');
  const replay = page.waitForResponse((response) => response.url().endsWith(path) && response.request().method() === 'POST');
  await paste.click();
  await expectReplay(attempt, await replay, entity);
}

test('a lost resource adjustment reloads HP and the prior version cannot apply twice', async ({ page }) => {
  await register(page, `resource-retry-${crypto.randomUUID()}@example.test`);
  const campaignResponse = await page.request.post('/api/campaigns', { data: { title: 'Resource recovery', description: '' } });
  expect(campaignResponse.status()).toBe(201);
  const { campaign } = await campaignResponse.json();
  const sceneResponse = await page.request.post('/api/scenes', { data: { campaignId: campaign.id, title: 'Resource room' } });
  expect(sceneResponse.status()).toBe(201);
  const { scene } = await sceneResponse.json();
  const created = await page.request.post('/api/tokens', { data: { sceneId: scene.id, name: 'Health test token', x: 3, y: 3, color: '#c8794a' } });
  expect(created.status()).toBe(201);
  const { token } = await created.json();
  const updated = await page.request.patch(`/api/tokens/${token.id}`, { data: { expectedVersion: token.version, resources: [
    { label: 'HP', current: 20, maximum: 20, visible: true },
    { label: 'Focus', current: 0, maximum: 0, visible: false },
  ] } });
  expect(updated.status()).toBe(200);
  const path = `/api/tokens/${token.id}/resources/adjust`;
  let version = (await updated.json()).token.version;
  for (let expected = 19; expected >= 16; expected--) {
    const response = await page.request.post(path, { data: { resourceIndex: 0, delta: -1, expectedVersion: version } });
    expect(response.status()).toBe(200);
    const result = (await response.json()).token;
    expect(result.resources[0].current).toBe(expected);
    version = result.version;
  }

  await page.reload();
  await page.getByRole('button', { name: /Resource recovery/ }).click();
  const hp = page.locator('.token-resource-controls .token-resource-quick').filter({ hasText: 'HP' });
  await expect(hp).toContainText('16 / 20');
  const attempt = await loseFirstResponse(page, path);
  const snapshot = page.waitForResponse((response) => response.url().endsWith(`/api/scenes/${scene.id}/tokens`) && response.request().method() === 'GET');
  await hp.getByRole('button', { name: '−', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('The change was not confirmed');
  const first = attempt.dropped[0]!;
  expect(first.status()).toBe(200);
  expect((await first.json()).token.resources[0].current).toBe(15);
  const stale = await page.request.post(path, { data: { resourceIndex: 0, delta: -1, expectedVersion: version } });
  expect(stale.status()).toBe(409);
  expect(await stale.json()).toMatchObject({ error: 'CONFLICT' });
  expect((await (await snapshot).json()).find((item: { id: string }) => item.id === token.id).resources[0].current).toBe(15);
  await expect(hp).toContainText('15 / 20');
});

test('lost chat and dice ACKs reuse their original command IDs on explicit retry', async ({ page }) => {
  const chatIds: string[] = [];
  const rollIds: string[] = [];
  const dropped = new Set<string>();
  const suppressed = new Set<string>();
  await page.routeWebSocket((url) => url.pathname === '/socket.io/', (wire) => {
    const upstream = wire.connectToServer();
    wire.onMessage((packet) => {
      if (typeof packet === 'string') {
        const match = /^42(\d+)(\[.*)$/s.exec(packet);
        if (match) {
          const [name, payload] = JSON.parse(match[2]!) as [string, { clientMessageId?: string; requestId?: string }];
          const ids = name === 'chat:send' ? chatIds : name === 'dice:roll' ? rollIds : undefined;
          if (ids) {
            if (!ids.length) dropped.add(match[1]!);
            ids.push(payload.clientMessageId ?? payload.requestId ?? '');
          }
        }
      }
      upstream.send(packet);
    });
    upstream.onMessage((packet) => {
      const id = typeof packet === 'string' ? /^43(\d+)\[/.exec(packet)?.[1] : undefined;
      if (id && dropped.delete(id)) { suppressed.add(id); return; }
      wire.send(packet);
    });
  });
  await register(page, `ack-retry-${crypto.randomUUID()}@example.test`);
  await page.getByLabel('Campaign name').fill('Retry ACK campaign');
  await page.getByRole('button', { name: /^Create/ }).click();
  await expect(page.locator('.live-status')).toHaveText('Live');

  const input = page.getByPlaceholder('Write a message…');
  await input.fill('Acknowledgment recovery');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry safely' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry safely' }).click();
  await expect(input).toHaveValue('');
  await expect(page.locator('.chat-message').filter({ hasText: 'Acknowledgment recovery' })).toHaveCount(1);

  await page.getByRole('button', { name: /d20 Roll/ }).click();
  const retryRoll = page.getByRole('button', { name: /d20 Retry/ });
  await expect(retryRoll).toBeEnabled();
  await retryRoll.click();
  await expect(page.getByRole('button', { name: /d20 Roll/ })).toBeEnabled();
  await expect(page.locator('.roll-row')).toHaveCount(1);
  expect(suppressed.size).toBe(2);
  for (const ids of [chatIds, rollIds]) {
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(ids[1]).toBe(ids[0]);
  }
});

import { expect, test, type Page } from '@playwright/test';
import type { PublicToken } from '@nri/contracts';

const grid = 48;
const startX = 672;
const endX = 816;
const password = 'e2e-test-password-24';

async function account(page: Page, label: string) {
  const result = await page.request.post('/api/auth/register', { data: {
    email: `${crypto.randomUUID()}@example.test`, password, displayName: label,
  } });
  expect(result.status()).toBe(201);
  return (await result.json()).user.id as string;
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
}

async function fit(page: Page, scene: { width: number; height: number }) {
  const canvas = page.locator('.table-canvas canvas');
  await expect(canvas).toBeVisible();
  await page.getByRole('button', { name: 'Fit scene', exact: true }).click();
  const bounds = (await canvas.boundingBox())!;
  const scale = Math.max(0.1, Math.min(4, Math.min(bounds.width / scene.width, bounds.height / scene.height) * 0.9));
  return (x: number, y: number) => ({ x: bounds.x + (bounds.width - scene.width * scale) / 2 + x * scale,
    y: bounds.y + (bounds.height - scene.height * scale) / 2 + y * scale });
}

test('GM and Player use server-authoritative collision in Vault of Four Doors', async ({ page, browser }) => {
  const title = `Geometry Workshop ${crypto.randomUUID().slice(0, 8)}`;
  await account(page, 'Collision Guide');
  const created = await page.request.post('/api/campaigns', { data: { title, description: '' } });
  expect(created.status()).toBe(201);
  const { campaign } = await created.json();
  const added = await page.request.post('/api/scenes', { data: { title: 'Vault of Four Doors', campaignId: campaign.id, gridSize: grid } });
  expect(added.status()).toBe(201);
  const { scene } = await added.json();
  const geometryPath = `/api/scenes/${scene.id}/geometry`;
  const tokenPath = `/api/scenes/${scene.id}/tokens`;
  const invite = await page.request.post('/api/invitations', { data: { campaignId: campaign.id } });
  expect(invite.status()).toBe(201);
  const { invitation } = await invite.json();
  const playerContext = await browser.newContext({ locale: 'en-US' });
  try {
    const player = await playerContext.newPage();
    const playerId = await account(player, 'Collision Player');
    const joined = await player.request.post(`/api/invitations/${encodeURIComponent(invitation)}/accept`);
    expect(joined.status()).toBe(200);
    const createToken = async (name: string, y: number): Promise<PublicToken> => {
      const response = await page.request.post('/api/tokens', { data: { sceneId: scene.id, name, x: startX / grid, y: y / grid } });
      expect(response.status()).toBe(201);
      const { token } = await response.json();
      const owner = await page.request.post(`/api/tokens/${token.id}/owner`, { data: { ownerUserId: playerId } });
      expect(owner.status()).toBe(200);
      return (await owner.json()).token;
    };
    const wallToken = await createToken('Wall Trial', 336);
    const doorToken = await createToken('Door Trial', 432);
    const addObstacle = (kind: string, startY: number, endY: number, doorState: string | null, visibility = 'STANDARD') =>
      page.request.post(geometryPath, { data: { kind, start: { x: 750, y: startY }, end: { x: 750, y: endY },
        doorState, visibility, blocksMovement: true, blocksVision: true } });
    expect((await addObstacle('WALL', 190, 409, null)).status()).toBe(201);
    const doorResponse = await addObstacle('DOOR', 409, 471, 'CLOSED');
    expect(doorResponse.status()).toBe(201);
    const secretResponse = await addObstacle('DOOR', 480, 570, 'LOCKED', 'SECRET');
    expect(secretResponse.status()).toBe(201);
    const secret = (await secretResponse.json()).obstacle as { id: string };
    const playerPackets: string[] = [];
    player.on('websocket', (socket) => socket.on('framereceived', ({ payload }) => playerPackets.push(String(payload))));
    const open = async (view: Page) => {
      await view.goto('/');
      await view.getByRole('button', { name: new RegExp(title) }).click();
      await expect(view.locator('.live-status')).toHaveText('Live');
    };
    await open(page);
    await open(player);
    let gmPoint = await fit(page, scene);
    let playerPoint = await fit(player, scene);
    const editor = page.getByRole('button', { name: 'Obstacles', exact: true });
    const policy = page.getByLabel('Restrict movement', { exact: true });
    const applyPolicy = async (enabled: boolean) => {
      await editor.click();
      await expect(policy).toBeEnabled();
      if ((await policy.isChecked()) !== enabled) await policy.click();
      await expect(policy).toBeChecked({ checked: enabled });
      await expect(policy).toBeEnabled();
      await editor.click();
    };
    const setDoor = async (state: string) => {
      await editor.click();
      await expect(policy).toBeEnabled();
      const point = gmPoint(750, 440);
      await page.mouse.click(point.x, point.y);
      const select = page.getByRole('combobox', { name: 'Door state', exact: true });
      await expect(select).toBeEnabled();
      await select.selectOption(state);
      await expect(select).toHaveValue(state);
      await expect(select).toBeEnabled();
      await editor.click();
    };
    const tokens = async (view: Page) => await (await view.request.get(tokenPath)).json() as PublicToken[];
    const position = async (view: Page, id: string) => (await tokens(view)).find((token) => token.id === id)?.x;
    const expectPosition = (view: Page, id: string, x: number) => expect.poll(() => position(view, id)).toBe(x / grid);

    await applyPolicy(true);
    await drag(player, playerPoint(startX, 336), playerPoint(endX, 336));
    await expect(player.getByRole('alert')).toContainText('Movement is blocked.');
    await expectPosition(player, wallToken.id, startX);
    await drag(player, playerPoint(startX, 336), playerPoint(624, 336));
    await expectPosition(player, wallToken.id, 624);
    await drag(player, playerPoint(624, 336), playerPoint(startX, 336));
    await expectPosition(player, wallToken.id, startX);

    await setDoor('OPEN');
    await drag(player, playerPoint(startX, 432), playerPoint(endX, 432));
    await expectPosition(player, doorToken.id, endX);
    await setDoor('CLOSED');
    await drag(player, playerPoint(endX, 432), playerPoint(startX, 432));
    await expect(player.getByRole('alert')).toContainText('Movement is blocked.');
    await expectPosition(player, doorToken.id, endX);
    await open(player);
    playerPoint = await fit(player, scene);
    await expectPosition(player, doorToken.id, endX);
    expect((await player.request.get(geometryPath)).status()).toBe(403);
    expect(playerPackets.some((packet) => packet.includes(secret.id) || packet.includes('geometry:changed') || packet.includes('obstacleMovementEnabled'))).toBe(false);

    await applyPolicy(false);
    await drag(player, playerPoint(endX, 432), playerPoint(startX, 432));
    await expectPosition(player, doorToken.id, startX);
    await drag(player, playerPoint(startX, 336), playerPoint(endX, 336));
    await expectPosition(player, wallToken.id, endX);
    await drag(player, playerPoint(endX, 336), playerPoint(startX, 336));
    await expectPosition(player, wallToken.id, startX);

    await applyPolicy(true);
    await setDoor('OPEN');
    await page.getByRole('button', { name: 'Select area', exact: true }).click();
    await drag(page, gmPoint(605, 287), gmPoint(738, 478));
    await page.getByRole('button', { name: 'Stop selecting', exact: true }).click();
    const group = page.waitForResponse((response) => response.url().endsWith('/tokens/group') && response.request().method() === 'PATCH');
    await drag(page, gmPoint(startX, 336), gmPoint(endX, 336));
    expect((await group).status()).toBe(409);
    await expectPosition(page, wallToken.id, startX);
    await expectPosition(page, doorToken.id, startX);
    await drag(page, gmPoint(startX, 336), gmPoint(624, 336));
    await expectPosition(page, wallToken.id, 624);
    await expectPosition(page, doorToken.id, 624);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expectPosition(page, wallToken.id, startX);
    await expectPosition(page, doorToken.id, startX);

    await open(page); // A new workspace scope clears group selection and history.
    gmPoint = await fit(page, scene);
    await drag(page, gmPoint(startX, 432), gmPoint(endX, 432));
    await expectPosition(page, doorToken.id, endX);
    await setDoor('CLOSED');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Movement is blocked.');
    await expectPosition(page, doorToken.id, endX);
    await setDoor('OPEN');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expectPosition(page, doorToken.id, startX);
    await setDoor('CLOSED');
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Movement is blocked.');
    await expectPosition(page, doorToken.id, startX);
  } finally { await playerContext.close(); }
});

import { expect, test, type Page } from '@playwright/test';
import type { SceneGeometry, ScenePoint } from '@nri/contracts/geometry';

type Scene = { id: string; width: number; height: number; campaignId: string };
const password = 'e2e-test-password-24';

async function register(page: Page, name: string) {
  const response = await page.request.post('/api/auth/register', {
    data: { email: `${crypto.randomUUID()}@example.test`, password, displayName: name },
  });
  expect(response.status()).toBe(201);
}

async function drag(page: Page, start: ScenePoint, end: ScenePoint, cancel = false) {
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 });
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up();
}

async function fit(page: Page, scene: Scene) {
  const canvas = page.locator('.table-canvas canvas');
  await expect(canvas).toBeVisible();
  await page.getByRole('button', { name: 'Fit scene', exact: true }).click();
  const bounds = (await canvas.boundingBox())!;
  const scale = Math.max(0.1, Math.min(4, Math.min(bounds.width / scene.width, bounds.height / scene.height) * 0.9));
  const x = bounds.x + (bounds.width - scene.width * scale) / 2;
  const y = bounds.y + (bounds.height - scene.height * scale) / 2;
  return { bounds, scale, point: (xWorld: number, yWorld: number) => ({ x: x + xWorld * scale, y: y + yWorld * scale }) };
}

test('GM draws and edits geometry on the live canvas with versioned persistence and Player privacy', async ({ page, browser }) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const title = `Obstacle workshop ${suffix}`;
  await register(page, 'Geometry test guide');
  const created = await page.request.post('/api/campaigns', { data: { title, description: '' } });
  expect(created.status()).toBe(201);
  const { campaign } = await created.json();
  const createScene = async (title: string): Promise<Scene> => {
    const response = await page.request.post('/api/scenes', { data: { campaignId: campaign.id, title } });
    expect(response.status()).toBe(201);
    return (await response.json()).scene;
  };
  const scene = await createScene('Walls fixture');
  const draft = await createScene('Empty geometry fixture');
  const route = `/api/scenes/${scene.id}/geometry`;
  const geometry = async (): Promise<SceneGeometry> => (await page.request.get(route)).json();
  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(title) }).click();
  await expect(page.locator('.live-status')).toHaveText('Live');
  const editor = page.getByRole('button', { name: 'Obstacles', exact: true });
  await editor.click();
  await expect(page.getByRole('status').filter({ hasText: 'Connecting' })).toHaveCount(0);
  let canvas = await fit(page, scene);
  const tool = (name: string) => page.getByRole('button', { name, exact: true });
  await tool('Draw wall').click();
  await drag(page, canvas.point(480, 480), canvas.point(864, 480));
  await expect.poll(async () => (await geometry()).obstacles.length).toBe(1);
  const [wall] = (await geometry()).obstacles;
  expect(wall).toMatchObject({ start: { x: 480, y: 480 }, end: { x: 864, y: 480 }, kind: 'WALL', version: 1 });
  await tool('Select obstacle').click();
  await page.mouse.click(canvas.point(672, 480).x, canvas.point(672, 480).y);
  await expect(tool('Delete obstacle')).toBeEnabled();
  await drag(page, canvas.point(864, 480), canvas.point(960, 576));
  await expect.poll(async () => (await geometry()).obstacles[0]?.end).toEqual({ x: 960, y: 576 });
  await tool('Draw wall').click();
  await drag(page, canvas.point(480, 720), canvas.point(864, 720), true);
  await expect.poll(async () => (await geometry()).revision).toBe(2);

  const anchor = canvas.point(760, 740);
  await page.mouse.move(anchor.x, anchor.y);
  await page.mouse.wheel(0, -230);
  const zoom = Math.max(0.25, Math.min(2.2, canvas.scale * Math.exp(0.23)));
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(anchor.x + 28, anchor.y + 14, { steps: 3 });
  await page.mouse.up({ button: 'right' });
  const transformed = (x: number, y: number) => ({ x: anchor.x + 28 + (x - 760) * zoom, y: anchor.y + 14 + (y - 740) * zoom });
  await tool('Draw door').click();
  await drag(page, transformed(576, 720), transformed(720, 720));
  await expect.poll(async () => (await geometry()).obstacles.find(({ kind }) => kind === 'DOOR')?.doorState).toBe('CLOSED');
  const door = (await geometry()).obstacles.find(({ kind }) => kind === 'DOOR')!;
  expect(door).toMatchObject({ start: { x: 576, y: 720 }, end: { x: 720, y: 720 } });
  const doorState = page.getByLabel('Door state');
  await doorState.selectOption('OPEN');
  await expect.poll(async () => (await geometry()).obstacles.find(({ id }) => id === door.id)?.doorState).toBe('OPEN');
  await expect(doorState).toHaveValue('OPEN');
  await expect(doorState).toBeEnabled();
  await doorState.selectOption('LOCKED');
  await expect.poll(async () => (await geometry()).obstacles.find(({ id }) => id === door.id)?.doorState).toBe('LOCKED');
  await expect(doorState).toHaveValue('LOCKED');
  await expect(page.getByLabel('Secret', { exact: true })).toBeEnabled();
  await page.getByLabel('Secret', { exact: true }).click();
  await expect.poll(async () => (await geometry()).obstacles.find(({ id }) => id === door.id)?.visibility).toBe('SECRET');
  await expect(page.getByLabel('Secret', { exact: true })).toBeChecked();

  await page.locator('.scene-tab').filter({ hasText: 'Empty geometry fixture' }).click();
  await expect(editor).toHaveAttribute('aria-pressed', 'false');
  await editor.click();
  await expect.poll(async () => (await (await page.request.get(`/api/scenes/${draft.id}/geometry`)).json()).obstacles.length).toBe(0);
  await page.locator('.scene-tab').filter({ hasText: 'Walls fixture' }).click();
  await page.reload();
  await page.getByRole('button', { name: new RegExp(title) }).click();
  await expect(page.locator('.live-status')).toHaveText('Live');
  await editor.click();
  canvas = await fit(page, scene);
  const midpoint = canvas.point(720, 528);
  await page.mouse.click(midpoint.x, midpoint.y);
  await expect(tool('Delete obstacle')).toBeEnabled();
  await tool('Delete obstacle').click();
  await expect.poll(async () => (await geometry()).obstacles.map(({ id }) => id)).toEqual([door.id]);

  let firstCommit: number | undefined;
  await page.route(`**${route}`, async (intercept) => {
    if (intercept.request().method() !== 'POST' || firstCommit !== undefined) return intercept.continue();
    const saved = await intercept.fetch();
    firstCommit = saved.status();
    await intercept.abort();
  });
  await tool('Draw wall').click();
  await drag(page, canvas.point(384, 384), canvas.point(768, 384));
  await expect(tool('Retry obstacle change')).toBeVisible();
  expect(firstCommit).toBe(201);
  await tool('Retry obstacle change').click();
  await expect(tool('Retry obstacle change')).toHaveCount(0);
  expect((await geometry()).obstacles.length).toBe(2);
  await editor.click();
  await tool('Measure').click();
  await expect(tool('Clear ruler')).toHaveAttribute('aria-pressed', 'true');

  const playerContext = await browser.newContext({ locale: 'en-US' });
  try {
    const player = await playerContext.newPage();
    await register(player, 'Geometry test player');
    const invitation = await page.request.post('/api/invitations', { data: { campaignId: campaign.id } });
    expect(invitation.status()).toBe(201);
    const { invitation: token } = await invitation.json();
    const join = await player.request.post(`/api/invitations/${encodeURIComponent(token)}/accept`);
    expect(join.status()).toBe(200);
    await player.goto('/');
    await player.getByRole('button', { name: new RegExp(title) }).click();
    await expect(player.locator('.live-status')).toHaveText('Live');
    await expect(player.getByRole('button', { name: 'Obstacles', exact: true })).toHaveCount(0);
    const denied = await player.request.get(route);
    expect(denied.status()).toBe(403);
    expect(await denied.json()).toEqual({ error: 'FORBIDDEN' });
    await expect(player.locator('.table-canvas canvas')).toBeVisible();
  } finally { await playerContext.close(); }
});

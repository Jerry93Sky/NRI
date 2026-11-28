import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { chromium } from '@playwright/test';

const requireServer = createRequire(new URL('../../server/package.json', import.meta.url));
const { Pool } = requireServer('pg');
const database = new URL(process.env.DATABASE_URL);
const base = new URL(process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4175');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.pathname, '/nri_geometry_test');
assert.equal(base.hostname, '127.0.0.1');
const pool = new Pool({ connectionString: database.href });
const title = `Geometry profile ${randomUUID().slice(0, 8)}`;
const browser = await chromium.launch({ channel: 'chrome', headless: false });

try {
  const context = await browser.newContext({ baseURL: base.origin, locale: 'en-US', viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  const register = await context.request.post('/api/auth/register', { data: {
    displayName: 'Geometry profiler', email: `${randomUUID()}@example.test`, password: randomUUID(),
  } });
  assert.equal(register.status(), 201);
  const campaignResponse = await context.request.post('/api/campaigns', { data: { title, description: '' } });
  assert.equal(campaignResponse.status(), 201);
  const { campaign } = await campaignResponse.json();
  const sceneIds = new Map();
  for (const count of [0, 100, 500, 2000]) {
    const response = await context.request.post('/api/scenes', { data: { campaignId: campaign.id, title: `Segments ${count}` } });
    assert.equal(response.status(), 201);
    const { scene } = await response.json();
    sceneIds.set(count, scene);
    if (count === 0) continue;
    await pool.query(`INSERT INTO scene_geometry (scene_id, revision) VALUES ($1, 1)`, [scene.id]);
    await pool.query(`INSERT INTO scene_obstacles (scene_id,start_x,start_y,end_x,end_y,kind,visibility,blocks_movement,blocks_vision)
      VALUES ($1,384000,384000,576000,384000,'WALL','STANDARD',true,true)`, [scene.id]);
    await pool.query(`INSERT INTO scene_obstacles (scene_id,start_x,start_y,end_x,end_y,kind,visibility,blocks_movement,blocks_vision)
      SELECT $1,(68+36*(n%50))*1000,(600+26*(n/50))*1000,(96+36*(n%50))*1000,(606+26*(n/50))*1000,
        'WALL',CASE WHEN n%5=0 THEN 'SECRET' ELSE 'STANDARD' END,true,true
      FROM generate_series(1,$2::int-1) AS n`, [scene.id, count]);
  }
  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(title) }).click();
  await page.locator('.live-status').filter({ hasText: /^Live$/ }).waitFor();
  const canvas = page.locator('.table-canvas canvas');
  await canvas.waitFor();
  const getGpu = () => page.evaluate(() => {
    const sample = document.createElement('canvas').getContext('webgl2');
    const debug = sample?.getExtension('WEBGL_debug_renderer_info');
    const renderer = debug ? sample?.getParameter(debug.UNMASKED_RENDERER_WEBGL) : 'unavailable';
    sample?.getExtension('WEBGL_lose_context')?.loseContext();
    return renderer;
  });
  console.log(JSON.stringify({ renderer: await getGpu(), viewport: '1920×1080', browser: 'headed Chrome' }));
  const editor = page.getByRole('button', { name: 'Obstacles', exact: true });
  async function sampleFrames() {
    return page.evaluate(() => new Promise((resolve) => {
      const intervals = [];
      let first = 0;
      let prior = 0;
      const sample = (t) => {
        if (first === 0) first = t;
        if (prior) intervals.push(t - prior);
        prior = t;
        if (t - first < 2400) requestAnimationFrame(sample);
        else {
          intervals.sort((a, b) => a - b);
          resolve({ fps: intervals.length * 1000 / (t - first), p95: intervals[Math.ceil(intervals.length * 0.95) - 1] });
        }
      };
      requestAnimationFrame(sample);
    }));
  }
  for (const count of [100, 500, 2000]) {
    const scene = sceneIds.get(count);
    const path = `/api/scenes/${scene.id}/geometry`;
    await page.locator('.scene-tab').filter({ hasText: `Segments ${count}` }).click();
    await page.getByRole('button', { name: 'Fit scene', exact: true }).click();
    const bounds = await canvas.boundingBox();
    const scale = Math.max(0.1, Math.min(4, Math.min(bounds.width / scene.width, bounds.height / scene.height) * .9));
    const center = (x, y) => ({ x: bounds.x + (bounds.width - scene.width * scale) / 2 + x * scale,
      y: bounds.y + (bounds.height - scene.height * scale) / 2 + y * scale });
    const loading = page.waitForResponse((response) => new URL(response.url()).pathname === path && response.request().method() === 'GET');
    const started = performance.now();
    await editor.click();
    const response = await loading;
    const payload = await response.body();
    const loadMs = performance.now() - started;
    assert.equal(JSON.parse(payload.toString()).obstacles.length, count);
    const idle = await sampleFrames();
    const midpoint = center(480, 384);
    await page.mouse.click(midpoint.x, midpoint.y);
    await page.getByRole('button', { name: 'Delete obstacle', exact: true }).waitFor();
    const endpoint = center(576, 384);
    const target = center(576, 432);
    const patch = page.waitForResponse((response) => response.url().includes(path + '/') && response.request().method() === 'PATCH');
    await page.mouse.move(endpoint.x, endpoint.y);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 8 });
    const editStart = performance.now();
    await page.mouse.up();
    const edited = await patch;
    assert.equal(edited.status(), 200);
    assert.equal((await edited.json()).obstacle.end.y, 432);
    const editMs = performance.now() - editStart;
    const interactive = sampleFrames();
    for (let step = 0; step < 8; step++) {
      await page.mouse.wheel(0, step % 2 ? 120 : -120);
      await page.mouse.down({ button: 'right' });
      await page.mouse.move(midpoint.x + step * 8, midpoint.y + step * 4, { steps: 3 });
      await page.mouse.up({ button: 'right' });
    }
    const activity = await interactive;
    await page.locator('.scene-tab').filter({ hasText: /^Segments 0/ }).click();
    assert.equal(await editor.getAttribute('aria-pressed'), 'false');
    assert.equal(await canvas.count(), 1);
    const emptyPath = `/api/scenes/${sceneIds.get(0).id}/geometry`;
    const emptySnapshot = page.waitForResponse((response) => new URL(response.url()).pathname === emptyPath);
    await editor.click();
    assert.equal((await (await emptySnapshot).json()).obstacles.length, 0);
    assert.equal(await page.getByRole('button', { name: 'Delete obstacle', exact: true }).count(), 0);
    console.log(JSON.stringify({ count, bytes: payload.byteLength, loadMs, idle, editMs, activity, clearedOnSwitch: true }));
  }
} finally {
  await browser.close();
  await pool.end();
}

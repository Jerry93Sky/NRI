import assert from 'node:assert/strict';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { chromium } from '@playwright/test';

const output = resolve(process.env.NRI_LOAD_DIR ?? '.data/nri-load');
const web = new URL(process.env.NRI_LOAD_WEB ?? 'http://127.0.0.1:4183');
const api = new URL(process.env.NRI_LOAD_API ?? 'http://127.0.0.1:3345');
assert.ok([web, api].every(({ hostname }) => ['127.0.0.1', 'localhost'].includes(hostname)));
const minutes = Number(process.env.NRI_SOAK_MINUTES ?? 30);
assert.ok(Number.isInteger(minutes) && minutes >= 1 && minutes <= 60);
const [profile] = JSON.parse(await readFile(resolve(output, 'fixture.json'), 'utf8'));
assert.equal(profile.name, 'A');
const report = resolve(output, `soak-${Date.now()}.jsonl`);
const browser = await chromium.launch({ channel: 'chrome', headless: false });
const canvasSelector = '.table-canvas canvas';
const viewport = { width: 1366, height: 768 };
const pageErrors = [];
let guidePage;

async function openTable(account) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'en-US' });
  await context.addCookies([{ name: 'nri_session', value: account.session, url: web.href, httpOnly: true }]);
  const page = await context.newPage();
  page.on('pageerror', ({ name }) => pageErrors.push(name));
  await page.goto(web.href);
  await page.getByRole('button', { name: new RegExp(profile.title) }).click();
  await page.locator(canvasSelector).waitFor({ state: 'visible' });
  return page;
}

async function request(page, path, method = 'GET', data, expected = 200) {
  const response = await page.request.fetch(new URL(path, web).href, { method, data });
  assert.equal(response.status(), expected, `${method} ${path.split('/').at(-1)}`);
  return expected === 204 ? null : response.json();
}

async function live(page) {
  await page.locator('.live-status').filter({ hasText: /^Live$/ }).waitFor();
}

async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
}

async function waitChanged(read, before) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const value = await read();
    if (value !== before) return value;
    await pause(100);
  }
  throw new Error('The pointer action did not persist');
}

async function sample(page, cdp, cycle, elapsedMs, mapReads) {
  const frames = await page.evaluate(() => new Promise((resolve) => {
    const times = [];
    const start = performance.now();
    let previous;
    function frame(now) {
      if (previous !== undefined) times.push(now - previous);
      previous = now;
      if (now - start >= 2000) resolve(times); else requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }));
  frames.sort((a, b) => a - b);
  const at = (q) => +frames[Math.max(0, Math.ceil(frames.length * q) - 1)].toFixed(2);
  const metrics = (await cdp.send('Performance.getMetrics')).metrics;
  const application = await (await fetch(new URL('/api/metrics', api))).json();
  const row = { cycle, elapsedMs: Math.round(elapsedMs), frameMs: { count: frames.length, p50: at(.5), p95: at(.95), p99: at(.99) },
    fps: +(1000 * frames.length / frames.reduce((a, b) => a + b, 0)).toFixed(2), mapReads,
    apiRssBytes: application.residentBytes, heapBytes: metrics.find(({ name }) => name === 'JSHeapUsedSize')?.value,
    ...await cdp.send('Memory.getDOMCounters'), pageErrors: pageErrors.length };
  await appendFile(report, `${JSON.stringify(row)}\n`);
  console.info(JSON.stringify(row));
}

try {
  const [gm, player] = await Promise.all(profile.accounts.slice(0, 2).map(openTable));
  guidePage = gm;
  await gm.bringToFront();
  const { campaignId, sceneId, tokenId } = profile;
  const tokensPath = `/api/scenes/${sceneId}/tokens`;
  const objectsPath = `/api/scenes/${sceneId}/objects`;
  const initiative = `/api/campaigns/${campaignId}/initiative`;
  const campaign = `/api/campaigns/${campaignId}`;
  const layers = await request(gm, `/api/scenes/${sceneId}/layers`);
  const layerId = layers.find(({ kind }) => kind === 'OBJECTS').id;
  const cdp = await gm.context().newCDPSession(gm);
  await cdp.send('Performance.enable');
  let mapReads = 0;
  gm.on('request', (req) => { if (/^\/api\/assets\/[0-9a-f-]+$/i.test(new URL(req.url()).pathname)) mapReads++; });
  const jpeg = await gm.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 512;
    const context = canvas.getContext('2d');
    context.fillStyle = '#df7d48'; context.fillRect(0, 0, 512, 512);
    context.fillStyle = '#426455'; context.fillRect(80, 70, 320, 300);
    return canvas.toDataURL('image/jpeg').split(',')[1];
  });
  const readToken = async () => (await request(gm, tokensPath)).find(({ id }) => id === tokenId);
  const started = performance.now();
  await writeFile(report, `${JSON.stringify({ browser: browser.version(), viewport, minutes })}\n`, { flag: 'wx' });
  let cycle = 0;
  do {
    const cycleStart = performance.now();
    const canvas = gm.locator(canvasSelector);
    await gm.locator('.scene-tab').filter({ hasText: 'Empty scene' }).click();
    const loaded = gm.waitForResponse((res) => res.ok() && res.url().endsWith(tokensPath));
    await gm.locator('.scene-tab').filter({ hasText: 'Benchmark table' }).click();
    await loaded;
    const fit = gm.getByRole('button', { name: 'Fit scene', exact: true });
    await fit.click();
    const point = async (x, y) => {
      const box = await canvas.boundingBox();
      const scale = Math.max(.1, .9 * Math.min(box.width, box.height) / profile.mapSize);
      return { x: box.x + box.width / 2 + (x - profile.mapSize / 2) * scale,
        y: box.y + box.height / 2 + (y - profile.mapSize / 2) * scale };
    };
    const token = await readToken();
    const select = gm.getByRole('button', { name: 'Select area', exact: true });
    await select.click();
    await drag(gm, await point(10, 5), await point(350, 200));
    await gm.getByRole('button', { name: 'Stop selecting', exact: true }).click();
    await gm.locator('.token-group-tools').getByRole('button', { name: 'Clear selection', exact: true }).click();
    const scene = (await request(gm, `/api/campaigns/${campaignId}/scenes`)).find(({ id }) => id === sceneId);
    const cell = scene.gridSize;
    const targetX = token.x < 9 ? token.x + 1 : 2;
    await drag(gm, await point(token.x * cell, token.y * cell), await point(targetX * cell, token.y * cell));
    await waitChanged(async () => (await readToken()).version, token.version);
    const middle = await point(1050, 1050);
    await gm.mouse.move(middle.x, middle.y);
    await gm.mouse.wheel(0, -200);
    await gm.mouse.down({ button: 'right' });
    await gm.mouse.move(middle.x + 25, middle.y + 20);
    await gm.mouse.up({ button: 'right' });
    await fit.click();

    const { object } = await request(gm, objectsPath, 'POST', { layerId, kind: 'RECTANGLE', x: 900, y: 1100, width: 140, height: 120 }, 201);
    const summary = gm.locator('details.layer-tools summary');
    if (!await gm.locator('.layer-select').filter({ hasText: 'Objects' }).isVisible()) await summary.click();
    await gm.locator('.layer-select').filter({ hasText: 'Objects' }).click();
    const row = gm.locator(`[data-object-id="${object.id}"]`);
    await row.waitFor();
    await fit.click();
    const readObject = async () => (await request(gm, objectsPath)).find(({ id }) => id === object.id);
    await drag(gm, await point(970, 1160), await point(1040, 1230));
    const moved = await waitChanged(async () => (await readObject()).x, object.x);
    const history = gm.locator('.table-actions');
    await history.getByRole('button', { name: 'Undo', exact: true }).click();
    assert.equal(await waitChanged(async () => (await readObject()).x, moved), object.x);
    await history.getByRole('button', { name: 'Redo', exact: true }).click();
    assert.equal(await waitChanged(async () => (await readObject()).x, object.x), moved);
    await request(gm, `/api/objects/${object.id}`, 'DELETE', { expectedVersion: (await readObject()).version }, 204);

    await gm.getByRole('button', { name: 'Draw', exact: true }).click();
    await gm.getByRole('button', { name: 'Stop drawing', exact: true }).waitFor();
    await canvas.scrollIntoViewIfNeeded();
    const strokeStart = await point(650, 850);
    const strokeEnd = await point(800, 930);
    assert.ok(await gm.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName === 'CANVAS', strokeStart), 'Drawing start is outside the playable viewport');
    const [drawingResponse] = await Promise.all([
      gm.waitForResponse((res) => res.url().endsWith(objectsPath) && res.request().method() === 'POST'),
      drag(gm, strokeStart, strokeEnd),
    ]);
    assert.equal(drawingResponse.status(), 201);
    const { object: drawing } = await drawingResponse.json();
    await gm.getByRole('button', { name: 'Stop drawing', exact: true }).click();
    await request(gm, `/api/objects/${drawing.id}`, 'DELETE', { expectedVersion: drawing.version }, 204);

    const chat = gm.getByPlaceholder('Write a message…');
    const message = `Soak message ${cycle + 1} (${new Date().toISOString()})`;
    await chat.fill(message); await chat.press('Enter');
    await player.getByText(message, { exact: true }).waitFor();
    await gm.getByRole('button', { name: /d20.*Roll/ }).click();
    const prior = await request(gm, initiative);
    if (!prior.tracker?.active) await request(gm, `${initiative}/start`, 'POST', { sceneId, entries: [{ tokenId, label: 'Measured token', score: 13 }] });
    const current = await request(gm, initiative);
    assert.equal(current.tracker.active, true);
    await request(gm, `${initiative}/stop`, 'POST', { expectedVersion: current.tracker.version });

    const upload = await gm.request.post(new URL(`${campaign}/assets?category=OTHER`, web).href, { multipart: {
      files: { name: `soak-${cycle}.jpg`, mimeType: 'image/jpeg', buffer: Buffer.from(jpeg, 'base64') },
    } });
    assert.equal(upload.status(), 201);
    const [{ id: asset }] = (await upload.json()).assets;
    const thumbnail = await gm.request.get(new URL(`/api/assets/${asset}?variant=thumbnail`, web).href);
    assert.equal(thumbnail.status(), 200);
    await request(gm, `/api/assets/${asset}`, 'DELETE', undefined, 204);

    await player.context().setOffline(true);
    await player.locator('.live-status').filter({ hasText: /Reconnecting|Offline/ }).waitFor();
    await pause(cycle % 2 ? 3000 : 800);
    await player.context().setOffline(false);
    await live(player);
    assert.equal((await request(player, tokensPath)).find(({ id }) => id === tokenId).version, (await readToken()).version);
    await sample(gm, cdp, ++cycle, performance.now() - started, mapReads);
    await pause(Math.max(0, Math.min(started + minutes * 60_000, cycleStart + 45_000) - performance.now()));
  } while (performance.now() - started < minutes * 60_000);
  const final = { complete: true, elapsedMs: Math.round(performance.now() - started), cycles: cycle, pageErrors };
  await appendFile(report, `${JSON.stringify(final)}\n`);
  assert.deepEqual(pageErrors, []);
  console.info(JSON.stringify(final));
} catch (error) {
  await guidePage?.screenshot({ path: `${report}.png` }).catch(() => {});
  throw error;
} finally { await browser.close(); }

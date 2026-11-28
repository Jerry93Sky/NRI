import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as pause } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { io } from 'socket.io-client';

const appUrl = process.env.NRI_LOAD_WEB ?? 'http://127.0.0.1:4183';
const apiUrl = process.env.NRI_LOAD_API ?? 'http://127.0.0.1:3345';
for (const target of [appUrl, apiUrl]) {
  if (!['127.0.0.1', 'localhost'].includes(new URL(target).hostname)) throw new Error('The load runner accepts loopback URLs only.');
}
const output = resolve(process.env.NRI_LOAD_DIR ?? '.data/nri-load');
const selected = process.env.NRI_LOAD_PROFILE;
const fixtures = JSON.parse(await readFile(resolve(output, 'fixture.json'), 'utf8')).filter(({ name }) => !selected || name === selected);
assert.ok(fixtures.length > 0);
const hardware = process.env.NRI_LOAD_HARDWARE === '1';
const captureCpu = process.env.NRI_LOAD_CPU_TRACE === '1';
const requireProduction = process.env.NRI_LOAD_REQUIRE_PRODUCTION === '1';
const viewport = { width: Number(process.env.NRI_LOAD_WIDTH ?? 1366), height: Number(process.env.NRI_LOAD_HEIGHT ?? 768) };
assert.ok(Number.isInteger(viewport.width) && Number.isInteger(viewport.height) && viewport.width >= 800 && viewport.height >= 600);
const browser = await chromium.launch(hardware ? { channel: 'chrome', headless: false } : {});
const report = hardware ? `hardware-${viewport.width}x${viewport.height}${selected ? `-${selected}` : ''}${captureCpu ? '-diagnostic' : ''}.json` : 'report.json';
const outcomes = [];
const samples = 24;
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (percentile) => +sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)].toFixed(2);
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
};
const metrics = async () => {
  const response = await fetch(`${apiUrl}/api/metrics`);
  assert.equal(response.status, 200);
  return response.json();
};
const statementCount = () => {
  const container = process.env.NRI_LOAD_PG_CONTAINER;
  if (!container) return null;
  const sql = "select coalesce(sum(calls),0) from pg_stat_statements where dbid = (select oid from pg_database where datname = current_database()) and query not ilike '%pg_stat_statements%'";
  return Number(execFileSync('docker', ['exec', container, 'psql', '-U', 'nri', '-d', 'nri_load', '-Atc', sql], { encoding: 'utf8' }).trim());
};

async function openTable(account) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'en-US' });
  await context.addInitScript(() => {
    globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      inject(renderer) { globalThis.__nriReactBundleType = renderer.bundleType; return 1; },
      onCommitFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
    };
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (...args) {
      const context = Reflect.apply(getContext, this, args);
      if (context && (args[0] === 'webgl' || args[0] === 'webgl2') && !this.__nriMeasuredContext) {
        this.__nriMeasuredContext = context;
        const textures = new Set();
        const counts = { textures, drawCalls: 0 };
        this.__nriCounts = counts;
        const create = context.createTexture.bind(context);
        const remove = context.deleteTexture.bind(context);
        context.createTexture = () => {
          const texture = create();
          if (texture) textures.add(texture);
          return texture;
        };
        context.deleteTexture = (texture) => { textures.delete(texture); remove(texture); };
        for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
          if (typeof context[name] !== 'function') continue;
          const draw = context[name].bind(context);
          context[name] = (...parameters) => { counts.drawCalls++; return draw(...parameters); };
        }
      }
      return context;
    };
  });
  await context.addCookies([{ name: 'nri_session', value: account.session, url: appUrl, httpOnly: true }]);
  return context;
}

async function join(profile, socket) {
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
    socket.connect();
  });
  assert.ok((await socket.timeout(5000).emitWithAck('campaign:join', profile.campaignId)).ok);
}

try {
  for (const profile of fixtures) {
    const sockets = profile.accounts.map((account) => io(apiUrl, {
      extraHeaders: { cookie: `nri_session=${account.session}` }, transports: ['websocket'], reconnection: false, autoConnect: false,
    }));
    const [guide, player] = sockets;
    const context = await openTable(profile.accounts[0]);
    const page = await context.newPage();
    page.on('pageerror', (error) => console.error(`Browser application error: ${error.message}`));
    const cdp = await context.newCDPSession(page);
    const traffic = { httpEncodedBytes: 0, wsReceivedPayloadBytes: 0, wsSentPayloadBytes: 0 };
    cdp.on('Network.dataReceived', ({ encodedDataLength }) => { traffic.httpEncodedBytes += encodedDataLength; });
    cdp.on('Network.webSocketFrameReceived', ({ response }) => { traffic.wsReceivedPayloadBytes += Buffer.byteLength(response.payloadData); });
    cdp.on('Network.webSocketFrameSent', ({ response }) => { traffic.wsSentPayloadBytes += Buffer.byteLength(response.payloadData); });
    await cdp.send('Network.enable');
    await cdp.send('Performance.enable');
    const browserMetrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]));
    const glCounts = (canvas) => canvas.evaluate((element) => {
      const counter = element.__nriCounts;
      return counter ? { textures: counter.textures.size, drawCalls: counter.drawCalls } : null;
    });
    const tokensPath = (sceneId) => `/api/scenes/${sceneId}/tokens`;
    const waitSnapshot = async (sceneId) => {
      const response = await page.waitForResponse((event) => event.url().endsWith(tokensPath(sceneId)));
      assert.ok(response.ok(), `Scene token snapshot returned HTTP ${response.status()}`);
      return response.json();
    };
    try {
      const before = await metrics();
      const beforeQueries = statementCount();
      await Promise.all(sockets.map((socket) => join(profile, socket)));
      const openedAt = performance.now();
      await page.goto(appUrl);
      const [renderedTokens] = await Promise.all([
        waitSnapshot(profile.sceneId), page.getByRole('button', { name: new RegExp(profile.title) }).click(),
      ]);
      assert.equal(renderedTokens.length, profile.tokenCount);
      const canvas = page.locator('.table-canvas canvas');
      await canvas.waitFor({ state: 'visible' });
      const reactBundleType = await page.evaluate(() => globalThis.__nriReactBundleType ?? null);
      if (requireProduction) assert.equal(reactBundleType, 0, 'The tabletop was not built with the production React renderer');
      const texture = await canvas.evaluate((element) => {
        const gl = element.__nriMeasuredContext;
        if (!gl) return null;
        const debug = gl.getExtension('WEBGL_debug_renderer_info');
        return { maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE), renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null };
      });
      if (hardware) assert.ok(texture?.renderer && !/swiftshader|software|llvmpipe|basic render/i.test(texture.renderer), 'The application canvas did not report a hardware renderer');
      const initialMs = +(performance.now() - openedAt).toFixed(2);
      let version = renderedTokens.find((token) => token.id === profile.tokenId).version;

      const ackMs = [];
      const syncMs = [];
      const payloadBytes = [];
      const initialBrowserMetrics = await browserMetrics();
      const beforeGl = await glCounts(canvas);
      if (captureCpu) {
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.start');
      }
      const started = performance.now();
      const frameTimesPromise = page.evaluate(() => new Promise((resolve) => {
        const times = [];
        const started = performance.now();
        let previous;
        function tick(now) {
          if (previous !== undefined) times.push(now - previous);
          previous = now;
          if (now - started >= 4_000) resolve(times);
          else requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
      }));
      for (let i = 0; i < samples; i++) {
        const sentAt = performance.now();
        const delivery = new Promise((resolve, reject) => {
          const timer = setTimeout(() => { player.off('token:moved', received); reject(new Error('Move delivery timed out')); }, 5000);
          const received = (token) => {
            if (token.id !== profile.tokenId || token.version !== version + 1) return;
            clearTimeout(timer);
            player.off('token:moved', received);
            resolve({ at: performance.now(), token });
          };
          player.on('token:moved', received);
        });
        const ack = guide.timeout(5000).emitWithAck('token:move', { tokenId: profile.tokenId, x: 2 + i % 8, y: 3, expectedVersion: version });
        const [reply, event] = await Promise.all([ack.then((value) => ({ value, at: performance.now() })), delivery]);
        assert.equal(reply.value.ok, true);
        version = reply.value.token.version;
        ackMs.push(reply.at - sentAt);
        syncMs.push(event.at - sentAt);
        payloadBytes.push(Buffer.byteLength(JSON.stringify(event.token)));
        await pause(125);
      }
      const frames = await frameTimesPromise;
      const elapsedMs = performance.now() - started;
      if (captureCpu) {
        const { profile: trace } = await cdp.send('Profiler.stop');
        await writeFile(resolve(output, `cpu-${profile.name}-${viewport.width}x${viewport.height}.json`), JSON.stringify(trace));
      }
      const afterMotion = await metrics();
      const afterGl = await glCounts(canvas);
      const afterMotionBrowser = await browserMetrics();

      const switchMs = [];
      for (let i = 0; i < 6; i++) {
        for (const [title, id] of [['Empty scene', profile.otherSceneId], ['Benchmark table', profile.sceneId]]) {
          const startedAt = performance.now();
          const [tokens] = await Promise.all([waitSnapshot(id), page.locator('.scene-tab').filter({ hasText: title }).click()]);
          assert.equal(tokens.length, id === profile.sceneId ? profile.tokenCount : 0);
          await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          switchMs.push(performance.now() - startedAt);
        }
      }
      const after = await metrics();
      const afterQueries = statementCount();
      const afterSwitches = await browserMetrics();
      const finalGl = await glCounts(canvas);
      const { name, playerCount, tokenCount, objectCount, mapSize } = profile;
      const cpu = afterMotion.cpu.user + afterMotion.cpu.system - before.cpu.user - before.cpu.system;
      const outcome = {
        name, playerCount, tokenCount, objectCount, mapSize, initialMs,
        browser: browser.version(), viewport, devicePixelRatio: await page.evaluate(() => devicePixelRatio), reactBundleType,
        fps: +(frames.length * 1000 / frames.reduce((sum, ms) => sum + ms, 0)).toFixed(2),
        frameMs: stats(frames), framesOver50Ms: frames.filter((ms) => ms > 50).length,
        ackMs: stats(ackMs), syncMs: stats(syncMs), switchMs: stats(switchMs),
        tokenPayloadBytes: stats(payloadBytes), traffic, texture,
        apiCpuMicroseconds: cpu, measuredMotionMs: +elapsedMs.toFixed(2),
        apiRssBytes: { before: before.residentBytes, after: after.residentBytes },
        browserHeapBytes: { beforeSwitches: afterMotionBrowser.JSHeapUsedSize, afterSwitches: afterSwitches.JSHeapUsedSize },
        browserWorkMs: Object.fromEntries(['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'].map((name) =>
          [name, +((afterMotionBrowser[name] - initialBrowserMetrics[name]) * 1000).toFixed(2)])),
        webGlTextures: { beforeMotion: beforeGl?.textures, afterMotion: afterGl?.textures, afterSwitches: finalGl?.textures },
        coreDrawCallsDuringMotion: beforeGl && afterGl ? afterGl.drawCalls - beforeGl.drawCalls : null,
        httpRequests: after.httpRequests - before.httpRequests, httpFailures: after.httpFailures - before.httpFailures,
        pgStatements: beforeQueries === null || afterQueries === null ? null : afterQueries - beforeQueries,
      };
      outcomes.push(outcome);
      await writeFile(resolve(output, report), JSON.stringify(outcomes, null, 2) + '\n');
      await page.screenshot({ path: resolve(output, `profile-${name}-${viewport.width}x${viewport.height}.png`) });
      console.info(JSON.stringify(outcome));
    } catch (error) {
      await page.screenshot({ path: resolve(output, `profile-${profile.name}-${viewport.width}x${viewport.height}-failure.png`) }).catch(() => {});
      throw error;
    } finally {
      await context.close();
      for (const socket of sockets) socket.disconnect();
    }
  }
} finally { await browser.close(); }

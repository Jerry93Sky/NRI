import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { setTimeout as pause } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { io } from 'socket.io-client';

const appUrl = process.env.NRI_LOAD_WEB ?? 'http://127.0.0.1:4183';
const apiUrl = process.env.NRI_LOAD_API ?? 'http://127.0.0.1:3345';
for (const target of [appUrl, apiUrl]) {
  if (!['127.0.0.1', 'localhost'].includes(new URL(target).hostname)) throw new Error('The load runner accepts loopback URLs only.');
}
const fixtures = JSON.parse(await readFile('.data/nri-load/fixture.json', 'utf8'));
const browser = await chromium.launch();
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
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: 'en-US' });
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
    const heap = async () => (await cdp.send('Performance.getMetrics')).metrics.find(({ name }) => name === 'JSHeapUsedSize')?.value;
    const tokensPath = (sceneId) => `/api/scenes/${sceneId}/tokens`;
    const waitSnapshot = (sceneId) => page.waitForResponse((response) => response.ok() && response.url().endsWith(tokensPath(sceneId)));
    try {
      const before = await metrics();
      const beforeQueries = statementCount();
      await Promise.all(sockets.map((socket) => join(profile, socket)));
      const initialSnapshot = waitSnapshot(profile.sceneId);
      const openedAt = performance.now();
      await page.goto(appUrl);
      await page.getByRole('button', { name: new RegExp(profile.title) }).click();
      const renderedTokens = await (await initialSnapshot).json();
      assert.equal(renderedTokens.length, profile.tokenCount);
      await page.locator('.table-canvas canvas').waitFor({ state: 'visible' });
      const initialMs = +(performance.now() - openedAt).toFixed(2);
      let version = renderedTokens.find((token) => token.id === profile.tokenId).version;

      const ackMs = [];
      const syncMs = [];
      const payloadBytes = [];
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
      const afterMotion = await metrics();

      const switchMs = [];
      const beforeSwitchHeap = await heap();
      for (let i = 0; i < 6; i++) {
        for (const [title, id] of [['Empty scene', profile.otherSceneId], ['Benchmark table', profile.sceneId]]) {
          const snapshot = waitSnapshot(id);
          const startedAt = performance.now();
          await page.locator('.scene-tab').filter({ hasText: title }).click();
          const tokens = await (await snapshot).json();
          assert.equal(tokens.length, id === profile.sceneId ? profile.tokenCount : 0);
          await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          switchMs.push(performance.now() - startedAt);
        }
      }
      const texture = await page.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl2');
        if (!gl) return null;
        const debug = gl.getExtension('WEBGL_debug_renderer_info');
        const result = { maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE), renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null };
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        return result;
      });
      const after = await metrics();
      const afterQueries = statementCount();
      const { name, playerCount, tokenCount, objectCount, mapSize } = profile;
      const cpu = afterMotion.cpu.user + afterMotion.cpu.system - before.cpu.user - before.cpu.system;
      const outcome = {
        name, playerCount, tokenCount, objectCount, mapSize, initialMs,
        fps: +(frames.length * 1000 / frames.reduce((sum, ms) => sum + ms, 0)).toFixed(2),
        frameMs: stats(frames), ackMs: stats(ackMs), syncMs: stats(syncMs), switchMs: stats(switchMs),
        tokenPayloadBytes: stats(payloadBytes), traffic, texture,
        apiCpuMicroseconds: cpu, measuredMotionMs: +elapsedMs.toFixed(2),
        apiRssBytes: { before: before.residentBytes, after: after.residentBytes },
        browserHeapBytes: { beforeSwitches: beforeSwitchHeap, afterSwitches: await heap() },
        httpRequests: after.httpRequests - before.httpRequests, httpFailures: after.httpFailures - before.httpFailures,
        pgStatements: beforeQueries === null || afterQueries === null ? null : afterQueries - beforeQueries,
      };
      outcomes.push(outcome);
      await page.screenshot({ path: `.data/nri-load/profile-${name}.png` });
      console.info(JSON.stringify(outcome));
    } catch (error) {
      await page.screenshot({ path: `.data/nri-load/profile-${profile.name}-failure.png` }).catch(() => {});
      throw error;
    } finally {
      await context.close();
      for (const socket of sockets) socket.disconnect();
    }
  }
} finally { await browser.close(); }
await writeFile('.data/nri-load/report.json', JSON.stringify(outcomes, null, 2) + '\n');

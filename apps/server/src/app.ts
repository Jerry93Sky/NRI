import Fastify, { LogController } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { constants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { isProduction, sessionSecret, trustProxy, uploadDirectory, webOrigins } from './config/runtime.js';
import { pool } from './db/index.js';
import { registerRealtime } from './realtime/register.js';
import { registerAuthRoutes } from './modules/auth/routes.js';
import { registerCampaignRoutes } from './modules/campaigns/routes.js';
import { registerMembershipRoutes } from './modules/memberships/routes.js';
import { registerChatRoutes } from './modules/chat/routes.js';
import { registerInitiativeRoutes } from './modules/initiative/routes.js';
import { registerSceneRoutes } from './modules/scenes/routes.js';
import { registerSceneContentRoutes } from './modules/scene-content/routes.js';
import { registerAssetRoutes } from './modules/assets/routes.js';
import { registerTokenRoutes } from './modules/tokens/routes.js';
import { errorCategory, operationalLogOptions } from './security/logging.js';

export async function createApp() {
  await mkdir(uploadDirectory, { recursive: true });
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info', ...operationalLogOptions },
    requestIdHeader: false,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 64 * 1024,
    trustProxy,
  });
  let requestCount = 0;
  let failedRequests = 0;
  let shuttingDown = false;
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: process.env.NODE_ENV === 'test' ? 500 : 120, timeWindow: '1 minute' });
  await app.register(import('@fastify/multipart'), { limits: { files: 12, fileSize: 12 * 1024 * 1024, fields: 0, parts: 12 } });
  if (!isProduction && sessionSecret.length < 24) app.log.warn('Set a unique SESSION_SECRET in .env before local use.');
  app.setErrorHandler((error, request, reply) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) request.log.error({ route: request.routeOptions.url, category: errorCategory(error) }, 'Request failed');
    const code = status >= 500 ? 'INTERNAL_ERROR' : status === 429 ? 'RATE_LIMITED' : (error as { code?: string }).code ?? 'INVALID';
    reply.code(status).send({ error: code });
  });
  app.addHook('onResponse', async (request, reply) => {
    requestCount++;
    if (reply.statusCode >= 500) failedRequests++;
    request.log.info({ method: request.method, route: request.routeOptions.url, statusCode: reply.statusCode, elapsedMs: reply.elapsedTime }, 'Request completed');
  });
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && !webOrigins.includes(origin)) return reply.code(403).send({ error: 'ORIGIN_REJECTED' });
  });

  app.get('/api/health', async () => ({ status: 'ok' }));
  app.get('/api/ready', async (_request, reply) => {
    if (shuttingDown) return reply.code(503).send({ status: 'not_ready' });
    try {
      await Promise.all([pool.query('select 1 from campaigns limit 0'), access(uploadDirectory, constants.W_OK)]);
      return { status: 'ready' };
    }
    catch { return reply.code(503).send({ status: 'not_ready' }); }
  });
  const io = registerRealtime(app.server, app.log);
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  app.get('/api/metrics', async (request, reply) => {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) {
      return reply.code(404).send({ error: 'NOT_FOUND' });
    }
    return {
      uptimeSeconds: process.uptime(),
      residentBytes: process.memoryUsage.rss(),
      cpu: process.cpuUsage(),
      httpRequests: requestCount,
      httpFailures: failedRequests,
      connectedSockets: io.sockets.sockets.size,
      databasePool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
      assetProcessing: { ...assetProcessing(), loopP95Ms: +(loopDelay.percentile(95) / 1e6).toFixed(2) },
    };
  });
  registerAuthRoutes(app, io);
  registerCampaignRoutes(app, io);
  registerMembershipRoutes(app, io);
  registerChatRoutes(app);
  registerInitiativeRoutes(app, io);
  registerSceneRoutes(app, io);
  registerSceneContentRoutes(app, io);
  const assetProcessing = registerAssetRoutes(app, io);
  registerTokenRoutes(app, io);

  const logIdleDatabaseError = (error: Error) => app.log.warn({ category: errorCategory(error) }, 'Idle database connection failed');
  pool.on('error', logIdleDatabaseError);

  app.addHook('preClose', async () => {
    shuttingDown = true;
    io.engine.close();
  });
  app.addHook('onClose', async () => {
    loopDelay.disable();
    try { await pool.end(); }
    finally { pool.off('error', logIdleDatabaseError); }
  });
  return app;
}

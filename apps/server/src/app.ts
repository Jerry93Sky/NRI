import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { isProduction, sessionSecret, webOrigins } from './config/runtime.js';
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

export async function createApp() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers.set-cookie'] },
    disableRequestLogging: true,
    bodyLimit: 64 * 1024,
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: process.env.NODE_ENV === 'test' ? 500 : 120, timeWindow: '1 minute' });
  await app.register(import('@fastify/multipart'), { limits: { files: 12, fileSize: 12 * 1024 * 1024, fields: 0, parts: 12 } });
  if (!isProduction && sessionSecret.length < 24) app.log.warn('Set a unique SESSION_SECRET in .env before local use.');
  app.setErrorHandler((error, request, reply) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) request.log.error({ route: request.routeOptions.url, type: error instanceof Error ? error.name : 'unknown' }, 'Request failed');
    const code = status >= 500 ? 'INTERNAL_ERROR' : status === 429 ? 'RATE_LIMITED' : (error as { code?: string }).code ?? 'INVALID';
    reply.code(status).send({ error: code });
  });
  app.addHook('onResponse', async (request, reply) => {
    request.log.info({ method: request.method, route: request.routeOptions.url, statusCode: reply.statusCode, elapsedMs: reply.elapsedTime }, 'Request completed');
  });
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && !webOrigins.includes(origin)) return reply.code(403).send({ error: 'ORIGIN_REJECTED' });
  });

  app.get('/api/health', async () => ({ status: 'ok' }));
  app.get('/api/ready', async (_request, reply) => {
    try { await pool.query('select 1'); return { status: 'ready' }; }
    catch { return reply.code(503).send({ status: 'not_ready' }); }
  });
  const io = registerRealtime(app.server);
  registerAuthRoutes(app, io);
  registerCampaignRoutes(app, io);
  registerMembershipRoutes(app, io);
  registerChatRoutes(app);
  registerInitiativeRoutes(app, io);
  registerSceneRoutes(app, io);
  registerSceneContentRoutes(app, io);
  registerAssetRoutes(app, io);
  registerTokenRoutes(app, io);

  app.addHook('onClose', async () => { io.close(); await pool.end(); });
  return app;
}

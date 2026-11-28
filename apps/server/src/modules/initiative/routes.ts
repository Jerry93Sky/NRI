import { idSchema } from '@nri/contracts';
import type { FastifyInstance } from 'fastify';
import type { Server } from 'socket.io';
import { cookieName } from '../../config/runtime.js';
import { db } from '../../db/index.js';
import { publishInitiative } from '../../realtime/initiativeEvents.js';
import { digest, parseBody } from '../../security/access.js';
import { commandSessionIsActive, lockCampaignActor } from '../../security/commandAccess.js';
import { changeInitiative, initiativeProjection, initiativeVersionSchema, readInitiative, startInitiativeSchema } from './service.js';

const errorStatus = { UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, SCENE_NOT_ACTIVE: 409, INVALID_TOKEN: 400 };

export function registerInitiativeRoutes(app: FastifyInstance, io: Server) {
  app.get('/api/campaigns/:campaignId/initiative', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const campaignId = parseBody(idSchema, (request.params as { campaignId: string }).campaignId);
    const tokenHash = digest(cookie);
    const result = await db.transaction(async (tx) => {
      const actor = await lockCampaignActor(tx, tokenHash, campaignId);
      if ('error' in actor) return { error: actor.error } as const;
      const snapshot = await readInitiative(tx, campaignId);
      if (!await commandSessionIsActive(tx, tokenHash)) return { error: 'UNAUTHENTICATED' } as const;
      return { view: initiativeProjection(snapshot!, actor.role !== 'PLAYER') };
    });
    if ('error' in result) return result.error === 'UNAUTHENTICATED'
      ? reply.code(401).send({ error: result.error }) : reply.code(404).send({ error: 'NOT_FOUND' });
    return result.view;
  });

  for (const action of ['start', 'advance', 'stop'] as const) {
    app.post(`/api/campaigns/:campaignId/initiative/${action}`, async (request, reply) => {
      const cookie = request.cookies[cookieName];
      if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
      const campaignId = parseBody(idSchema, (request.params as { campaignId: string }).campaignId).toLowerCase();
      const command = action === 'start' ? { action, input: parseBody(startInitiativeSchema, request.body) }
        : { action, input: parseBody(initiativeVersionSchema, request.body) };
      const result = await changeInitiative(digest(cookie), campaignId, command);
      if ('error' in result) return reply.code(errorStatus[result.error]).send({ error: result.error });
      void publishInitiative(io, campaignId, result.version).catch(() => request.log.error('Committed initiative could not be published'));
      return result.view;
    });
  }
}

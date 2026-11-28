import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Server } from 'socket.io';
import { z } from 'zod';
import { idSchema } from '@nri/contracts';
import { createObstacleSchema, deleteObstacleSchema, updateMovementPolicySchema, updateObstacleSchema } from '@nri/contracts/geometry';
import { cookieName } from '../../config/runtime.js';
import { withSceneAudience } from '../../realtime/campaignAudience.js';
import { digest, parseBody } from '../../security/access.js';
import { operationRequestId } from '../../security/operationReceipts.js';
import { applyObstacleCommand, readSceneGeometry, setObstacleMovementPolicy } from './service.js';

const base = '/api/scenes/:sceneId/geometry';
const obstaclePath = `${base}/:obstacleId`;
const sceneParams = z.object({ sceneId: idSchema });
const obstacleParams = sceneParams.extend({ obstacleId: idSchema });
const statuses = { UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, RESULT_UNAVAILABLE: 409, GEOMETRY_OUT_OF_BOUNDS: 400 };

export function registerGeometryRoutes(app: FastifyInstance, io: Server) {
  function publish(campaignId: string, sceneId: string, request: FastifyRequest) {
    void withSceneAudience(io, campaignId, sceneId, async (_tx, { recipients, canSend }) => {
      for (const recipient of recipients) {
        if (recipient.role !== 'PLAYER' && canSend(recipient)) recipient.socket.emit('geometry:changed', { campaignId, sceneId });
      }
    }).catch(() => request.log.error('Geometry change could not be published'));
  }

  async function mutate(request: FastifyRequest, reply: FastifyReply, sceneId: string, command: Parameters<typeof applyObstacleCommand>[2]) {
    reply.header('Cache-Control', 'no-store');
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const requestId = operationRequestId(request.headers['idempotency-key']);
    if (requestId === 'invalid') return reply.code(400).send({ error: 'INVALID_REQUEST_ID' });
    const result = await applyObstacleCommand(digest(cookie), sceneId, command, requestId);
    if ('error' in result) return reply.code(statuses[result.error]).send({ error: result.error });
    if (!result.replayed) publish(result.campaignId, sceneId, request);
    if (!result.obstacle) return reply.code(204).send();
    return reply.code(command.kind === 'create' && !result.replayed ? 201 : 200).send({ obstacle: result.obstacle });
  }

  app.get(base, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const { sceneId } = parseBody(sceneParams, request.params);
    const result = await readSceneGeometry(digest(cookie), sceneId);
    if ('error' in result) return reply.code(statuses[result.error]).send({ error: result.error });
    return result;
  });
  app.post(base, (request, reply) => {
    const { sceneId } = parseBody(sceneParams, request.params);
    return mutate(request, reply, sceneId, { kind: 'create', fields: parseBody(createObstacleSchema, request.body) });
  });
  app.patch(`${base}/movement-policy`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const requestId = operationRequestId(request.headers['idempotency-key']);
    if (requestId === 'invalid') return reply.code(400).send({ error: 'INVALID_REQUEST_ID' });
    const { sceneId } = parseBody(sceneParams, request.params);
    const input = parseBody(updateMovementPolicySchema, request.body);
    const result = await setObstacleMovementPolicy(digest(cookie), sceneId, input, requestId);
    if ('error' in result) return reply.code(statuses[result.error]).send({ error: result.error });
    if (result.changed) publish(result.campaignId, sceneId, request);
    return result.settings;
  });
  app.patch(obstaclePath, (request, reply) => {
    const { sceneId, obstacleId } = parseBody(obstacleParams, request.params);
    const { expectedVersion, ...fields } = parseBody(updateObstacleSchema, request.body);
    return mutate(request, reply, sceneId, { kind: 'update', id: obstacleId, expectedVersion, fields });
  });
  app.delete(obstaclePath, (request, reply) => {
    const { sceneId, obstacleId } = parseBody(obstacleParams, request.params);
    const { expectedVersion } = parseBody(deleteObstacleSchema, request.body);
    return mutate(request, reply, sceneId, { kind: 'delete', id: obstacleId, expectedVersion });
  });
}

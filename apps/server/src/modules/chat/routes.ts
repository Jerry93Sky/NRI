import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { messages, users } from '../../db/schema.js';
import type { FastifyInstance } from 'fastify';
import { digest, parseBody } from '../../security/access.js';
import { lockCampaignActor } from '../../security/commandAccess.js';
import { cookieName } from '../../config/runtime.js';
import { idSchema } from '@nri/contracts';

export function registerChatRoutes(app: FastifyInstance) {
  app.get('/api/campaigns/:campaignId/messages', async (request, reply) => {
    const cookie = request.cookies[cookieName];
    if (!cookie) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const campaignId = parseBody(idSchema, (request.params as { campaignId: string }).campaignId);
    const result = await db.transaction(async (tx) => {
      const actor = await lockCampaignActor(tx, digest(cookie), campaignId);
      if ('error' in actor) return { error: actor.error } as const;
      const recent = await tx.select({ id: messages.id, senderId: messages.senderId, displayName: users.displayName,
        body: messages.body, recipientId: messages.recipientId, createdAt: messages.createdAt })
        .from(messages).innerJoin(users, eq(messages.senderId, users.id))
        .where(and(eq(messages.campaignId, campaignId), or(isNull(messages.recipientId),
          eq(messages.senderId, actor.userId), eq(messages.recipientId, actor.userId))))
        .orderBy(desc(messages.createdAt), desc(messages.id)).limit(100);
      return { recent: recent.reverse() };
    });
    if ('error' in result) return result.error === 'UNAUTHENTICATED'
      ? reply.code(401).send({ error: result.error }) : reply.code(404).send({ error: 'NOT_FOUND' });
    return result.recent;
  });
}

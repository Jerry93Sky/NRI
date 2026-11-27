import { and, eq, isNull, or } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { messages, users } from '../../db/schema.js';
import type { FastifyInstance } from 'fastify';
import { requireUser, roleFor } from '../../security/access.js';

export function registerChatRoutes(app: FastifyInstance) {
  app.get('/api/campaigns/:campaignId/messages', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const { campaignId } = request.params as { campaignId: string };
    if (!await roleFor(campaignId, user.id)) return reply.code(404).send({ error: 'NOT_FOUND' });
    return db.select({ id: messages.id, senderId: messages.senderId, displayName: users.displayName, body: messages.body, recipientId: messages.recipientId, createdAt: messages.createdAt })
      .from(messages).innerJoin(users, eq(messages.senderId, users.id))
      .where(and(eq(messages.campaignId, campaignId), or(isNull(messages.recipientId), eq(messages.senderId, user.id), eq(messages.recipientId, user.id))))
      .orderBy(messages.createdAt).limit(100);
  });
}

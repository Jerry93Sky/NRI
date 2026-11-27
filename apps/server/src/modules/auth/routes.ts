import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { loginSchema, registerSchema } from '@nri/contracts';
import { db } from '../../db/index.js';
import { sessions, users } from '../../db/schema.js';
import type { FastifyInstance } from 'fastify';
import type { Server } from 'socket.io';
import { digest, parseBody, userForCookie } from '../../security/access.js';
import { cookieName, cookieOptions } from '../../config/runtime.js';
import { disconnectSession } from '../../realtime/session.js';

export function registerAuthRoutes(app: FastifyInstance, io: Server) {
  const publicUser = (user: { id: string; email: string; displayName: string }) => ({ id: user.id, email: user.email, displayName: user.displayName });

  async function issueSession(userId: string, previousToken?: string) {
    const previousHash = previousToken ? digest(previousToken) : null;
    const token = randomBytes(32).toString('base64url');
    await db.transaction(async (tx) => {
      if (previousHash) await tx.delete(sessions).where(eq(sessions.tokenHash, previousHash));
      await tx.insert(sessions).values({ tokenHash: digest(token), userId, expiresAt: new Date(Date.now() + cookieOptions.maxAge * 1000) });
    });
    if (previousHash) disconnectSession(io, previousHash);
    return token;
  }

  app.post('/api/auth/register', { config: { rateLimit: { max: process.env.NODE_ENV === 'test' ? 20 : 5, timeWindow: '1 hour' } } }, async (request, reply) => {
    const input = parseBody(registerSchema, request.body);
    const email = input.email.trim().toLowerCase();
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing) return reply.code(409).send({ error: 'ACCOUNT_EXISTS' });
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    const [user] = await db.insert(users).values({ email, passwordHash, displayName: input.displayName }).onConflictDoNothing({ target: users.email }).returning();
    if (!user) return reply.code(409).send({ error: 'ACCOUNT_EXISTS' });
    const token = await issueSession(user.id, request.cookies[cookieName]);
    return reply.setCookie(cookieName, token, cookieOptions).code(201).send({ user: publicUser(user) });
  });
  app.post('/api/auth/login', { config: { rateLimit: { max: 8, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const input = parseBody(loginSchema, request.body);
    const [user] = await db.select().from(users).where(eq(users.email, input.email.trim().toLowerCase())).limit(1);
    if (!user || !(await argon2.verify(user.passwordHash, input.password).catch(() => false))) return reply.code(401).send({ error: 'INVALID_CREDENTIALS' });
    const token = await issueSession(user.id, request.cookies[cookieName]);
    return reply.setCookie(cookieName, token, cookieOptions).send({ user: publicUser(user) });
  });
  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[cookieName];
    if (token) {
      const tokenHash = digest(token);
      await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
      disconnectSession(io, tokenHash);
    }
    const { maxAge: _maxAge, ...clearOptions } = cookieOptions;
    return reply.clearCookie(cookieName, clearOptions).code(204).send();
  });
  app.get('/api/auth/me', async (request, reply) => {
    const user = await userForCookie(request.cookies[cookieName]);
    if (!user) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    return { user: publicUser(user) };
  });
}

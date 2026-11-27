import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { loginSchema, registerSchema } from '@nri/contracts';
import { db } from '../../db/index.js';
import { sessions, users } from '../../db/schema.js';
import type { FastifyInstance } from 'fastify';
import { digest, parseBody, userForCookie } from '../../security/access.js';
import { cookieName, cookieOptions } from '../../config/runtime.js';

export function registerAuthRoutes(app: FastifyInstance) {
  const publicUser = (user: { id: string; email: string; displayName: string }) => ({ id: user.id, email: user.email, displayName: user.displayName });

  app.post('/api/auth/register', { config: { rateLimit: { max: process.env.NODE_ENV === 'test' ? 20 : 5, timeWindow: '1 hour' } } }, async (request, reply) => {
    const input = parseBody(registerSchema, request.body);
    const email = input.email.trim().toLowerCase();
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing) return reply.code(409).send({ error: 'ACCOUNT_EXISTS' });
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    const [user] = await db.insert(users).values({ email, passwordHash, displayName: input.displayName }).returning();
    if (!user) throw new Error('Account creation failed');
    const previousToken = request.cookies[cookieName];
    if (previousToken) await db.delete(sessions).where(eq(sessions.tokenHash, digest(previousToken)));
    const token = randomBytes(32).toString('base64url');
    await db.insert(sessions).values({ tokenHash: digest(token), userId: user.id, expiresAt: new Date(Date.now() + 14 * 86400000) });
    return reply.setCookie(cookieName, token, cookieOptions).code(201).send({ user: publicUser(user) });
  });
  app.post('/api/auth/login', { config: { rateLimit: { max: 8, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const input = parseBody(loginSchema, request.body);
    const [user] = await db.select().from(users).where(eq(users.email, input.email.trim().toLowerCase())).limit(1);
    if (!user || !(await argon2.verify(user.passwordHash, input.password).catch(() => false))) return reply.code(401).send({ error: 'INVALID_CREDENTIALS' });
    const previousToken = request.cookies[cookieName];
    if (previousToken) await db.delete(sessions).where(eq(sessions.tokenHash, digest(previousToken)));
    const token = randomBytes(32).toString('base64url');
    await db.insert(sessions).values({ tokenHash: digest(token), userId: user.id, expiresAt: new Date(Date.now() + 14 * 86400000) });
    return reply.setCookie(cookieName, token, cookieOptions).send({ user: publicUser(user) });
  });
  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[cookieName];
    if (token) await db.delete(sessions).where(eq(sessions.tokenHash, digest(token)));
    return reply.clearCookie(cookieName, { path: '/' }).code(204).send();
  });
  app.get('/api/auth/me', async (request, reply) => {
    const user = await userForCookie(request.cookies[cookieName]);
    if (!user) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    return { user: publicUser(user) };
  });
}

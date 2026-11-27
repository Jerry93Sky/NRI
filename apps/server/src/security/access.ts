import { createHash } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { campaigns, memberships, sessions, users } from '../db/schema.js';
import { type CampaignSceneRole } from '../domain/sceneAccess.js';
import { cookieName } from '../config/runtime.js';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export async function userForCookie(cookieValue?: string) {
  if (!cookieValue) return null;
  const rows = await db.select({ user: users }).from(sessions).innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.tokenHash, digest(cookieValue)), gt(sessions.expiresAt, new Date()))).limit(1);
  return rows[0]?.user ?? null;
}
export async function requireUser(request: { cookies: Record<string, string | undefined> }, reply: { code: (status: number) => { send: (value: unknown) => unknown } }) {
  const user = await userForCookie(request.cookies[cookieName]);
  if (!user) { reply.code(401).send({ error: 'UNAUTHENTICATED' }); return null; }
  return user;
}
export async function roleFor(campaignId: string, userId: string): Promise<CampaignSceneRole | null> {
  const [membership] = await db.select({ role: memberships.role }).from(memberships).innerJoin(campaigns, eq(memberships.campaignId, campaigns.id)).where(and(eq(memberships.campaignId, campaignId), eq(memberships.userId, userId), isNull(campaigns.archivedAt))).limit(1);
  const role = membership?.role;
  return role === 'OWNER' || role === 'GM' || role === 'PLAYER' ? role : null;
}
export function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw Object.assign(new Error('Invalid request'), { statusCode: 400, code: 'INVALID' });
  return result.data;
}

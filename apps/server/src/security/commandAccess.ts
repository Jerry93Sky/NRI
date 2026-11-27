import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { campaigns, memberships, sessions } from '../db/schema.js';
import type { CampaignSceneRole } from '../domain/sceneAccess.js';

export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function unexpiredSession(tokenHash: string) {
  return and(eq(sessions.tokenHash, tokenHash), sql`${sessions.expiresAt} > clock_timestamp()`);
}

export async function lockCommandSession(tx: Transaction, tokenHash: string) {
  const [session] = await tx.select({ userId: sessions.userId }).from(sessions)
    .where(unexpiredSession(tokenHash)).for('share').limit(1);
  return session;
}

export async function commandSessionIsActive(tx: Transaction, tokenHash: string) {
  const [session] = await tx.select({ userId: sessions.userId }).from(sessions).where(unexpiredSession(tokenHash)).limit(1);
  return Boolean(session);
}

export async function lockCommandSessions(tx: Transaction, tokenHashes: string[]) {
  return tx.select({ tokenHash: sessions.tokenHash, userId: sessions.userId, expiresAt: sessions.expiresAt }).from(sessions)
    .where(and(inArray(sessions.tokenHash, tokenHashes), sql`${sessions.expiresAt} > clock_timestamp()`))
    .orderBy(asc(sessions.tokenHash)).for('share');
}

export async function lockCampaign(tx: Transaction, campaignId: string, strength: 'share' | 'no key update' = 'share') {
  const [campaign] = await tx.select({ id: campaigns.id, archivedAt: campaigns.archivedAt }).from(campaigns)
    .where(eq(campaigns.id, campaignId)).for(strength).limit(1);
  return campaign && !campaign.archivedAt;
}

export async function lockCampaignRoles(tx: Transaction, campaignId: string, userIds: string[]) {
  const rows = await tx.select({ userId: memberships.userId, role: memberships.role }).from(memberships)
    .where(and(eq(memberships.campaignId, campaignId), inArray(memberships.userId, userIds)))
    .orderBy(asc(memberships.userId)).for('share');
  const roles = new Map<string, CampaignSceneRole>();
  for (const { userId, role } of rows) {
    if (role === 'OWNER' || role === 'GM' || role === 'PLAYER') roles.set(userId, role);
  }
  return roles;
}

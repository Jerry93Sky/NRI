import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { campaigns, memberships, scenes, sessions } from '../db/schema.js';
import type { CampaignSceneRole } from '../domain/sceneAccess.js';

export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type CampaignAccessError = { error: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' };
type CampaignActor = { userId: string; role: CampaignSceneRole; roles: Map<string, CampaignSceneRole> };
type CampaignSceneActor = CampaignActor & { scene: typeof scenes.$inferSelect };

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

export async function lockCampaign(tx: Transaction, campaignId: string, strength: 'share' | 'no key update' | 'update' = 'share') {
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

export async function lockCampaignActor(tx: Transaction, tokenHash: string, campaignId: string,
  options: { otherUsers?: string[]; strength?: 'share' | 'no key update' | 'update' } = {}): Promise<CampaignAccessError | CampaignActor> {
  const session = await lockCommandSession(tx, tokenHash);
  if (!session) return { error: 'UNAUTHENTICATED' } as const;
  if (!await lockCampaign(tx, campaignId, options.strength)) return { error: 'FORBIDDEN' } as const;
  const roles = await lockCampaignRoles(tx, campaignId, [session.userId, ...(options.otherUsers ?? [])]);
  const role = roles.get(session.userId);
  if (!role) return { error: 'FORBIDDEN' } as const;
  if (!await commandSessionIsActive(tx, tokenHash)) return { error: 'UNAUTHENTICATED' } as const;
  return { userId: session.userId, role, roles };
}

/** Lock an authenticated campaign member and one of its scenes in the shared command order. */
export async function lockCampaignSceneActor(tx: Transaction, tokenHash: string, sceneId: string,
  options: { otherUsers?: string[]; campaignStrength?: 'share' | 'no key update'; sceneStrength?: 'share' | 'update'; includeArchived?: boolean } = {}): Promise<CampaignAccessError | CampaignSceneActor> {
  const session = await lockCommandSession(tx, tokenHash);
  if (!session) return { error: 'UNAUTHENTICATED' } as const;
  const [location] = await tx.select({ campaignId: scenes.campaignId }).from(scenes).where(eq(scenes.id, sceneId)).limit(1);
  if (!location) return { error: 'NOT_FOUND' } as const;
  if (!await lockCampaign(tx, location.campaignId, options.campaignStrength)) return { error: 'FORBIDDEN' } as const;
  const roles = await lockCampaignRoles(tx, location.campaignId, [session.userId, ...(options.otherUsers ?? [])]);
  const role = roles.get(session.userId);
  if (!role) return { error: 'FORBIDDEN' } as const;
  const [scene] = await tx.select().from(scenes).where(and(eq(scenes.id, sceneId), eq(scenes.campaignId, location.campaignId),
    ...(options.includeArchived ? [] : [sql`${scenes.archivedAt} IS NULL`])))
    .for(options.sceneStrength ?? 'share').limit(1);
  if (!scene) return { error: 'NOT_FOUND' } as const;
  if (!await commandSessionIsActive(tx, tokenHash)) return { error: 'UNAUTHENTICATED' } as const;
  return { userId: session.userId, role, roles, scene } as const;
}

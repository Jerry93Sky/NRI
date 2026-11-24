import { boolean, doublePrecision, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(), email: varchar('email', { length: 254 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(), displayName: varchar('display_name', { length: 48 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export const sessions = pgTable('user_sessions', {
  tokenHash: text('token_hash').primaryKey(), userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expiry_idx').on(t.expiresAt)]);
export const campaigns = pgTable('campaigns', {
  id: uuid('id').defaultRandom().primaryKey(), ownerId: uuid('owner_id').notNull().references(() => users.id),
  title: varchar('title', { length: 80 }).notNull(), description: varchar('description', { length: 500 }).notNull().default(''),
  archivedAt: timestamp('archived_at', { withTimezone: true }), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('campaigns_owner_idx').on(t.ownerId)]);
export const memberships = pgTable('campaign_memberships', {
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }), userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: varchar('role', { length: 16 }).notNull(), joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.campaignId, t.userId] }), index('membership_user_idx').on(t.userId)]);
export const invitations = pgTable('campaign_invitations', {
  id: uuid('id').defaultRandom().primaryKey(), campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(), creatorId: uuid('creator_id').notNull().references(() => users.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), revokedAt: timestamp('revoked_at', { withTimezone: true }),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }), uses: integer('uses').notNull().default(0), maxUses: integer('max_uses').notNull().default(7),
}, (t) => [index('invitations_campaign_idx').on(t.campaignId)]);
export const assets = pgTable('assets', {
  id: uuid('id').defaultRandom().primaryKey(), campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  storageKey: varchar('storage_key', { length: 80 }).notNull().unique(), mediaType: varchar('media_type', { length: 32 }).notNull(),
  size: integer('size').notNull(), checksum: varchar('checksum', { length: 64 }).notNull(), uploaderId: uuid('uploader_id').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('assets_campaign_idx').on(t.campaignId)]);
export const scenes = pgTable('scenes', {
  id: uuid('id').defaultRandom().primaryKey(), campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 80 }).notNull(), backgroundAssetId: uuid('background_asset_id').references(() => assets.id, { onDelete: 'set null' }), gridSize: integer('grid_size').notNull().default(48), width: integer('width').notNull().default(2048), height: integer('height').notNull().default(2048),
  archivedAt: timestamp('archived_at', { withTimezone: true }), version: integer('version').notNull().default(1),
}, (t) => [index('scenes_campaign_idx').on(t.campaignId)]);
export const tokens = pgTable('tokens', {
  id: uuid('id').defaultRandom().primaryKey(), sceneId: uuid('scene_id').notNull().references(() => scenes.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 48 }).notNull(), x: doublePrecision('x').notNull(), y: doublePrecision('y').notNull(), color: varchar('color', { length: 7 }).notNull(),
  hidden: boolean('hidden').notNull().default(false), ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }), version: integer('version').notNull().default(1),
}, (t) => [index('tokens_scene_idx').on(t.sceneId), index('tokens_owner_idx').on(t.ownerUserId)]);
export const messages = pgTable('chat_messages', {
  id: uuid('id').defaultRandom().primaryKey(), campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  senderId: uuid('sender_id').notNull().references(() => users.id), recipientId: uuid('recipient_id').references(() => users.id), body: varchar('body', { length: 2000 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('messages_campaign_time_idx').on(t.campaignId, t.createdAt), index('messages_recipient_idx').on(t.recipientId)]);
export const diceRolls = pgTable('dice_rolls', {
  id: uuid('id').defaultRandom().primaryKey(), campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id), expression: varchar('expression', { length: 16 }).notNull(), result: integer('result').notNull(),
  detail: text('detail').notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('dice_campaign_time_idx').on(t.campaignId, t.createdAt)]);
export const initiatives = pgTable('initiative_trackers', {
  id: uuid('id').defaultRandom().primaryKey(), campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }).unique(),
  round: integer('round').notNull().default(1), activeIndex: integer('active_index').notNull().default(0), active: boolean('active').notNull().default(false), version: integer('version').notNull().default(1),
});
export const initiativeEntries = pgTable('initiative_entries', {
  id: uuid('id').defaultRandom().primaryKey(), trackerId: uuid('tracker_id').notNull().references(() => initiatives.id, { onDelete: 'cascade' }),
  tokenId: uuid('token_id').references(() => tokens.id, { onDelete: 'cascade' }), label: varchar('label', { length: 64 }).notNull(), score: integer('score').notNull(), tieOrder: integer('tie_order').notNull().default(0), hidden: boolean('hidden').notNull().default(false),
}, (t) => [index('initiative_entries_tracker_idx').on(t.trackerId, t.score)]);
export const auditEvents = pgTable('audit_events', {
  id: uuid('id').defaultRandom().primaryKey(), campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }), actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
  action: varchar('action', { length: 64 }).notNull(), targetId: uuid('target_id'), detail: varchar('detail', { length: 500 }).notNull().default(''), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('audit_campaign_time_idx').on(t.campaignId, t.createdAt)]);

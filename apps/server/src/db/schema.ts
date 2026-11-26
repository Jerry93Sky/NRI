import { boolean, check, doublePrecision, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

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
  playersCanDraw: boolean('players_can_draw').notNull().default(false),
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
export const assetFolders = pgTable('campaign_asset_folders', {
  id: uuid('id').defaultRandom().primaryKey(), campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 48 }).notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('asset_folders_campaign_name_idx').on(t.campaignId, t.name), index('asset_folders_campaign_idx').on(t.campaignId)]);
export const assets = pgTable('assets', {
  id: uuid('id').defaultRandom().primaryKey(), campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 120 }).notNull().default('Untitled image'), category: varchar('category', { length: 16 }).notNull().default('OTHER'),
  folderId: uuid('folder_id').references(() => assetFolders.id, { onDelete: 'set null' }),
  storageKey: varchar('storage_key', { length: 80 }).notNull().unique(), mediaType: varchar('media_type', { length: 32 }).notNull(),
  size: integer('size').notNull(), checksum: varchar('checksum', { length: 64 }).notNull(), uploaderId: uuid('uploader_id').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('assets_campaign_idx').on(t.campaignId)]);
export const scenes = pgTable('scenes', {
  id: uuid('id').defaultRandom().primaryKey(), campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 80 }).notNull(), backgroundAssetId: uuid('background_asset_id').references(() => assets.id, { onDelete: 'restrict' }), gridSize: integer('grid_size').notNull().default(48), width: integer('width').notNull().default(2048), height: integer('height').notNull().default(2048),
  gridColor: varchar('grid_color', { length: 7 }).notNull().default('#44453e'), gridOpacity: doublePrecision('grid_opacity').notNull().default(0.38), gridOffsetX: doublePrecision('grid_offset_x').notNull().default(0), gridOffsetY: doublePrecision('grid_offset_y').notNull().default(0), gridEnabled: boolean('grid_enabled').notNull().default(true), snapToGrid: boolean('snap_to_grid').notNull().default(true), unitsPerCell: doublePrecision('units_per_cell').notNull().default(5), unitLabel: varchar('unit_label', { length: 24 }).notNull().default('ft'),
  sortOrder: integer('sort_order').notNull().default(0), isActive: boolean('is_active').notNull().default(false), published: boolean('published').notNull().default(false), cameraX: doublePrecision('camera_x').notNull().default(0), cameraY: doublePrecision('camera_y').notNull().default(0), cameraZoom: doublePrecision('camera_zoom').notNull().default(1),
  archivedAt: timestamp('archived_at', { withTimezone: true }), version: integer('version').notNull().default(1),
}, (t) => [index('scenes_campaign_idx').on(t.campaignId), uniqueIndex('scenes_one_active_per_campaign_idx').on(t.campaignId).where(sql`${t.isActive} = true`)]);
export const sceneLayers = pgTable('scene_layers', {
  id: uuid('id').defaultRandom().primaryKey(), sceneId: uuid('scene_id').notNull().references(() => scenes.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 48 }).notNull(), kind: varchar('kind', { length: 16 }).notNull(), sortOrder: integer('sort_order').notNull().default(0),
  visibleToPlayers: boolean('visible_to_players').notNull().default(true), locked: boolean('locked').notNull().default(false), version: integer('version').notNull().default(1),
}, (t) => [index('scene_layers_scene_idx').on(t.sceneId), index('scene_layers_scene_kind_idx').on(t.sceneId, t.kind), check('scene_layers_kind_check', sql`${t.kind} IN ('BACKGROUND', 'OBJECTS', 'TOKENS', 'GM', 'CUSTOM')`)]);
export const sceneObjects = pgTable('scene_objects', {
  id: uuid('id').defaultRandom().primaryKey(), sceneId: uuid('scene_id').notNull().references(() => scenes.id, { onDelete: 'cascade' }), layerId: uuid('layer_id').notNull().references(() => sceneLayers.id, { onDelete: 'restrict' }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  kind: varchar('kind', { length: 16 }).notNull(), x: doublePrecision('x').notNull(), y: doublePrecision('y').notNull(), width: doublePrecision('width').notNull().default(64), height: doublePrecision('height').notNull().default(64),
  rotation: doublePrecision('rotation').notNull().default(0), opacity: doublePrecision('opacity').notNull().default(1), zIndex: integer('z_index').notNull().default(0),
  assetId: uuid('asset_id').references(() => assets.id, { onDelete: 'restrict' }), color: varchar('color', { length: 7 }), strokeWidth: doublePrecision('stroke_width'), points: jsonb('points').$type<Array<{ x: number; y: number }>>(), text: varchar('text', { length: 500 }),
  visible: boolean('visible').notNull().default(true), locked: boolean('locked').notNull().default(false), version: integer('version').notNull().default(1),
}, (t) => [index('scene_objects_scene_layer_z_idx').on(t.sceneId, t.layerId, t.zIndex), index('scene_objects_creator_idx').on(t.createdBy), check('scene_objects_kind_check', sql`${t.kind} IN ('IMAGE', 'LINE', 'FREEHAND', 'RECTANGLE', 'ELLIPSE', 'TEXT')`), check('scene_objects_dimensions_check', sql`${t.width} > 0 AND ${t.height} > 0 AND ${t.opacity} BETWEEN 0 AND 1 AND ${t.rotation} BETWEEN -360000 AND 360000`)]);
export const tokens = pgTable('tokens', {
  id: uuid('id').defaultRandom().primaryKey(), sceneId: uuid('scene_id').notNull().references(() => scenes.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 48 }).notNull(), x: doublePrecision('x').notNull(), y: doublePrecision('y').notNull(), color: varchar('color', { length: 7 }).notNull(), imageAssetId: uuid('image_asset_id').references(() => assets.id, { onDelete: 'set null' }),
  width: doublePrecision('width').notNull().default(1), height: doublePrecision('height').notNull().default(1), rotation: doublePrecision('rotation').notNull().default(0), opacity: doublePrecision('opacity').notNull().default(1),
  borderColor: varchar('border_color', { length: 7 }).notNull().default('#e8d7c3'), zIndex: integer('z_index').notNull().default(0), locked: boolean('locked').notNull().default(false), showName: boolean('show_name').notNull().default(true),
  resources: jsonb('resources').$type<[{ label: string; current: number; maximum: number; visible: boolean }, { label: string; current: number; maximum: number; visible: boolean }]>().notNull().default(sql`'[ {"label":"Resource 1","current":0,"maximum":0,"visible":false}, {"label":"Resource 2","current":0,"maximum":0,"visible":false} ]'::jsonb`),
  gmNote: text('gm_note').notNull().default(''), ownerNote: text('owner_note').notNull().default(''),
  hidden: boolean('hidden').notNull().default(false), ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }), deletedAt: timestamp('deleted_at', { withTimezone: true }), version: integer('version').notNull().default(1),
}, (t) => [index('tokens_scene_idx').on(t.sceneId), index('tokens_owner_idx').on(t.ownerUserId), check('tokens_dimensions_check', sql`${t.width} BETWEEN 0.25 AND 100 AND ${t.height} BETWEEN 0.25 AND 100 AND ${t.opacity} BETWEEN 0 AND 1 AND ${t.rotation} BETWEEN -360000 AND 360000`), check('tokens_resources_check', sql`jsonb_typeof(${t.resources}) = 'array' AND jsonb_array_length(${t.resources}) = 2 AND (${t.resources}->0->>'current')::integer BETWEEN 0 AND (${t.resources}->0->>'maximum')::integer AND (${t.resources}->1->>'current')::integer BETWEEN 0 AND (${t.resources}->1->>'maximum')::integer`)]);
export const messages = pgTable('chat_messages', {
  id: uuid('id').defaultRandom().primaryKey(), campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  senderId: uuid('sender_id').notNull().references(() => users.id), recipientId: uuid('recipient_id').references(() => users.id), body: varchar('body', { length: 2000 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('messages_campaign_time_idx').on(t.campaignId, t.createdAt), index('messages_recipient_idx').on(t.recipientId)]);
export const diceRolls = pgTable('dice_rolls', {
  id: uuid('id').defaultRandom().primaryKey(), campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id), expression: varchar('expression', { length: 16 }).notNull(), result: integer('result').notNull(),
  detail: text('detail').notNull(), hidden: boolean('hidden').notNull().default(false), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
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

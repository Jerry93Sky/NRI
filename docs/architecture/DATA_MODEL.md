# Data model

PostgreSQL is the source of truth. Every campaign-owned record carries `campaignId` directly or through a parent relation. Queries and writes must scope by membership and campaign ID. Add foreign keys, unique constraints, and indexes for access paths; use transactions for multi-row changes.

## V0.1 entities

| Entity | Key fields and constraints |
|---|---|
| User | id, normalized unique email, password hash, display name, created/updated timestamps |
| UserSession | hashed opaque session token, userId, expiry, creation/revocation; index user and expiry |
| Campaign | id, ownerId, title, description, coverAssetId, archivedAt, timestamps |
| CampaignMembership | campaignId, userId, role (OWNER/GM/PLAYER), joinedAt; unique campaign/user |
| CampaignInvitation | campaignId, tokenHash, expiry, revokedAt, creatorId, acceptedAt; unique token hash |
| Scene | campaignId, title, dimensions, backgroundAssetId, grid appearance/offset/snap/distance settings, sort order, active/published flags, initial camera values, archivedAt, optimistic version |
| SceneLayer | Scene-owned ordered layer; kind (BACKGROUND/OBJECTS/TOKENS/GM/CUSTOM), player visibility, lock state, optimistic version. Four canonical layers are backfilled and created for new scenes; client-created layers must use CUSTOM. |
| Asset | campaignId, storage key, detected media type, size, checksum, uploaderId; decoded dimensions are not stored yet |
| SceneObject | Scene- and layer-owned item with kind, position, size, rotation, opacity, z-order, optional campaign asset, drawing points/text, visibility, lock and optimistic version. Server CRUD and basic rectangle/ellipse canvas rendering/controls exist; selection, transforms, image rendering and complete editing workflows remain open. |
| Token | Scene-owned record with display data, grid-unit position, color, visibility, owner, two generic `{label,current,maximum,visible}` resource tracks, separate GM/owner notes, and optimistic version; V0.1 has no character model |
| TokenOwnership | tokenId, userId; unique token/user; authorization checked on server |
| ChatMessage | campaignId, senderId, channel/recipient, body, timestamp; secret recipient scoped |
| DiceRoll | campaignId, userId, parsed expression, server result and timestamp |
| InitiativeTracker | campaignId, sceneId, active state, round, current index, version |
| InitiativeEntry | trackerId, tokenId or participant reference, initiative, tie order, hidden flag |
| AuditEvent | campaignId, actorId, action, target, timestamp, redacted metadata |

Prefer numeric database IDs internally and opaque identifiers at public boundaries. Token ownership is separate from campaign role. Mutable scenes, tokens, and initiative trackers use optimistic versions. Player token projections include only resource tracks marked visible; owner adjustments are restricted to visible tracks and server-side bounds. GM notes are returned only to GMs, and owner notes only to GMs and the assigned owner. Critical invite acceptance, role changes, token ownership changes, scene activation, and initiative transitions are audited. Avoid storing plaintext invitation/session secrets. Scene duplication copies layers and objects with independent IDs in one transaction. Layer/object REST operations check campaign membership and scene scope; mutable records use optimistic versions. Scene activation and archive fallback also use transactions.

## Explicitly deferred

No full Character, faction, economy, world simulation, payment, subscription, or marketplace schema in V0.1. Future extension points are campaign references, versioned ruleset metadata, and scene/entity relationships; their actual models require their own release design.

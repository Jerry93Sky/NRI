# Realtime protocol (implemented)

Socket.IO is used for multiplayer delivery. The current implementation uses named event payloads and acknowledgement callbacks; it does **not** implement a protocol-version envelope, command IDs, event cursors, replay, or general idempotency. This document describes the wire behavior that exists today.

## Connection and rooms

The server resolves the opaque HTTP session cookie during the Socket.IO handshake and rechecks it after registering the session's revocation room. Logout and rotation disconnect sockets attached to that session. Other logins retain their connections. An expiry timer disconnects idle sessions at their stored expiry. `campaign:join` resolves current membership and joins campaign and member rooms plus the GM room for managers. Leave clears those subscriptions. Role changes update joined sockets, removal clears the affected member's subscriptions, and archiving a campaign clears all its subscriptions. Commands have per-event, per-socket rate limits.

## Client commands

| Event | Payload | Acknowledgement / checks |
|---|---|---|
| `campaign:join` | campaign UUID string | `{ok, role}` or `{error}`; role is resolved on server |
| `campaign:leave` | campaign UUID string | no acknowledgement |
| `scene:pointer` | `{campaignId, sceneId, x, y}` | `{ok}` or `{error}`; current membership and joined campaign room are checked, coordinates must be within scene bounds, Players may point only at the active scene, and per-socket updates are rate-limited to 20/sec |
| `token:move` | `{tokenId, x, y, expectedVersion}` | `{ok: true, token}`, `{error: 'CONFLICT', token}`, or `{error}`. Conflict details require current permission to move. Inaccessible and unknown token IDs receive `FORBIDDEN` without a token |
| `chat:send` | `{campaignId, body, recipientId?}` | `{ok, message}` or `{error}`; recipient membership and Player-to-GM private-message policy checked |
| `dice:roll` | `{campaignId, expression}` | `{ok, roll}` or `{error}`; server parses and generates dice results |

REST endpoints implement scene activation and editing, token creation/ownership, token properties and resource adjustments, layer and scene-object reads/CRUD, and initiative mutations. Token resource adjustments check campaign membership, active-scene visibility, role/ownership, track visibility for players, bounds, and optimistic version. Layer/object writes check campaign membership, active/archive state, same-scene layer references, asset campaign scope, and optimistic versions. Their successful changes publish privacy-filtered events after persistence. There is no general command deduplication key; clients should not retry non-idempotent commands blindly.

## Server events and confidentiality

| Event | Audience / purpose |
|---|---|
| `presence:joined` | Other campaign-room members |
| `membership:changed` | Campaign room, role update notification with `campaignId` |
| `membership:removed` | Affected user's personal room; client clears campaign state |
| `campaign:archived` | Campaign room, `{campaignId}`; clients close that workspace |
| `scene:activated` | Campaign room, `{campaignId, sceneId}` with nullable scene ID. Clients reload the role-filtered scene list |
| `scene:updated` | Campaign room, public projection, active scene settings only |
| `token:created`, `token:updated`, `token:moved` | Campaign room for visible active-scene tokens; GM room for hidden or inactive-scene tokens |
| `chat:message` | Campaign room for public messages |
| `chat:private` | Sender and recipient personal rooms |
| `dice:result` | Campaign room for public rolls and GM room for hidden rolls |
| `initiative:updated` | Campaign room, player-safe projection |
| `initiative:gm_updated` | GM room, full projection |
| `scene:layer_created`, `scene:layer_updated`, `scene:layer_deleted` | Current campaign audience. Players receive current public metadata on an active scene and ID-only deletion of formerly public layers |
| `scene:layer_hidden` | Eligible Players receive only `{sceneId, layerId}` when the formerly public layer is still inaccessible. Managers can receive the current private layer update |
| `scene:object_created`, `scene:object_updated`, `scene:object_deleted` | Current campaign audience. Player upserts require a current visible object on a readable layer and active scene. Manager upserts can include private data. Loss of public visibility sends Player removal with IDs only |
| `scene:pointer` | Transient coordinates and server-derived user identity; active scene pointers go to campaign room, while GM draft pointers go to the GM room only. Clients expire markers after 1.6 seconds; pointers are not persisted |

Players receive the active, non-archived scene in REST scene lists and token snapshots. Direct token snapshots for inactive or archived scenes are denied. Hidden token fields, note fields, scene items and initiative use role-specific projections. Owner-note events go to the assigned owner's joined campaign member room while the token is visible in the active scene. The ordinary token projection updates the former owner. Players may adjust visible resource tracks on owned tokens. Player object snapshots omit deleted objects, GM layers, other non-visible layers and invisible objects.

## Concurrency and recovery limits

Scene-content UI treats positive events as invalidations of the scoped REST snapshot. It discards superseded responses, coalesces refreshes queued together and immediately removes known objects/layers on a removal event. A layer reveal reloads the authorized layer and object snapshots. Older revisions, duplicates and events from another workspace cannot restore records from packet payloads. Snapshot readers lock current session, membership and scene while selecting their projections. The client also drops any object whose layer is absent from the paired layer response.

The scene publisher keeps database authorization and entity locks until Socket.IO enqueue, checks local subscription and expiry at each send and then releases the locks. Revocation after enqueue cannot cancel transport already in progress. There is no retained queue or global event order. If a publication cannot obtain a stable affected-layer set in its bounded retry, the next snapshot reconciles the result. [Audit matrix](../security/REALTIME_EVENT_MATRIX.md)

`PATCH /api/scenes/:sceneId/object-lifecycle` accepts `{action, objects: [{objectId, expectedVersion}]}` and returns `{objects}` with committed versions. Group conflicts keep the code-only response. A missing target or a target outside the requested scene returns `NOT_FOUND` to an authorized manager. Players receive `FORBIDDEN` from the group endpoint before it looks up any object. A hidden or missing target on the Player point-delete path receives `NOT_FOUND`. Restore preserves IDs and visibility flags.

Committed deletes use `scene:object_deleted` with `{sceneId, objectId}`. Restores reuse `scene:object_created` with `{object}`. The lifecycle publisher uses the room to find candidates and checks current session, role, scene and layer again in PostgreSQL. It suppresses packets for superseded revisions and filters private objects, layers and creator IDs from Players. Public removal packets require both prior public visibility and a currently readable layer. Clients can reconcile missed live events from scoped snapshots after reconnect.

`token:move` and `PATCH /api/scenes/:sceneId/tokens/group` share the [token movement transaction](ARCHITECTURE.md#token-movement-transaction). The group returns `{tokens}` after commit, HTTP 409 with `CONFLICT` for a stale authorized batch, or HTTP 403 with `FORBIDDEN` for forbidden movement on an accessible scene, including a positional patch on any locked target. Unknown and inaccessible scenes share the HTTP 404 response. Group rejections carry only an error code. An authorized Player-owner single conflict can include their owner note and visible resource tracks. The regular Player acknowledgement and public broadcast omit private notes.

The service commits before any successful movement or group event is queued. For these commands, sockets in the campaign room are delivery candidates. The publisher checks live sessions and roles in PostgreSQL and applies current scene and token visibility. A formerly public token hidden by a group update can emit `token:hidden` with only the token and scene IDs. Publication can reflect a newer committed version if another update wins before delivery. The acknowledgement is the scoped result at the command transaction. On transport interruption, subsequent snapshots reconcile durable state. The transport provides best-effort live delivery.

Mutable records use `expectedVersion`. A stale authorized `token:move` may return the latest allowed token projection. Token group updates and object lifecycle groups fail atomically if any expected version is stale. Undo/Redo submits inverse commands with the recorded versions, under current permissions. Clients rejoin and refill campaign and scene snapshots after reconnect. Scope checks discard late results from previous workspaces, and token events received while a snapshot loads are applied on top of it.

Command IDs and idempotency keys would help with non-idempotent chat and dice after a lost acknowledgement. The current client does not automatically retry these commands. Token/object edits use revision checks and snapshots. An event cursor or transactional outbox would become relevant when durable replay or delivery across API instances is required. The single-instance deployment uses in-memory rooms and has no general durable realtime replay contract.

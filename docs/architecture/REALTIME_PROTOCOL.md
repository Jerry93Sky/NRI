# Realtime protocol (implemented)

## Command ACK and transaction semantics

For CMD-ACL REST writers, state and audit commit before the existing publisher is invoked. A failed state/audit transaction produces no success publication. Socket.IO is still best effort: an ACK or packet can be lost after commit, and already queued bytes cannot be recalled. Chat and dice now have operation-specific request IDs with persisted results; this is not a global command-ID protocol. Remaining lost-response behavior is inventoried in the [retry policy](COMMAND_RETRY_POLICY.md).

Socket.IO is used for multiplayer delivery. The current implementation uses named event payloads and acknowledgement callbacks; it does **not** implement a protocol-version envelope, event cursors, durable replay, or general idempotency. Only chat and dice accept scoped retry IDs, described below.

## Connection and rooms

The server resolves the opaque HTTP session cookie during the Socket.IO handshake and rechecks it after registering the session's revocation room. Logout and rotation disconnect sockets attached to that session. Other logins retain their connections. An expiry timer disconnects idle sessions at their stored expiry. `campaign:join` locks the live session, campaign and membership while joining the campaign/member rooms and the manager room when applicable. Leave clears those subscriptions. Role changes update joined sockets, removal clears the affected member's subscriptions, and archiving a campaign clears all its subscriptions. Commands have per-event, per-socket rate limits.

## Client commands

| Event | Payload | Acknowledgement / checks |
|---|---|---|
| `campaign:join` | campaign UUID string | `{ok, role}` or `{error}`; role is resolved on server |
| `campaign:leave` | campaign UUID string | no acknowledgement |
| `scene:pointer` | `{campaignId, sceneId, x, y}` | `{ok}` or `{error}`; current session, campaign, sender/recipient memberships and roles, campaign-room subscription, and scene row are locked in one transaction through enqueue. Coordinates must be within scene bounds, Players may point only at the active scene, drafts reach managers only, and per-socket updates are throttled to 20/sec with a separate 1200/minute command ceiling |
| `token:move` | `{tokenId, x, y, expectedVersion}` | `{ok: true, token}`, `{error: 'CONFLICT', token}`, or `{error}`. Conflict details require current permission to move. Inaccessible and unknown token IDs receive `FORBIDDEN` without a token |
| `chat:send` | `{campaignId, clientMessageId, body, recipientId?}` | `{ok, message}` or `{error}`; current sender/recipient policy is validated transactionally; matching retry ID returns original row, changed payload conflicts |
| `dice:roll` | `{campaignId, requestId, expression, hidden?}` | `{ok, roll}` or `{error}`; server generates once per request ID and requires current manager access to recover hidden results |

REST endpoints implement scene activation and editing, token creation/ownership, token properties and resource adjustments, layer and scene-object reads/CRUD, and initiative mutations. Token resource adjustments check campaign membership, active-scene visibility, role/ownership, track visibility for players, bounds, and optimistic version. Layer/object writes check campaign membership, active/archive state, same-scene layer references, asset campaign scope, and optimistic versions. Their successful changes publish privacy-filtered events after persistence. REST creates/copies/uploads do not yet have retry IDs; clients must not retry those non-idempotent commands blindly. See the [retry policy](COMMAND_RETRY_POLICY.md).

## Server events and confidentiality

| Event | Audience / purpose |
|---|---|
| `presence:joined` | Other campaign-room members |
| `membership:changed` | Campaign room, `{campaignId, userId}`. The client rejoins to resolve its own current role or reloads the member list |
| `membership:removed` | Affected user's personal room; `{campaignId, userId}` remains deliverable after deletion. The client re-reads campaign membership and rejoins if a re-invitation already succeeded |
| `campaign:archived` | Campaign room, `{campaignId}`; the client re-reads its campaign list before closing the workspace |
| `campaign:drawing_permission` | Current campaign audience, `{id, playersCanDraw}` re-read under a share lock. The client reloads the stored campaign state |
| `scene:activated` | Current audience, `{campaignId, sceneId}` with the active ID re-read under campaign authorization. Clients ignore the ID and reload the role-filtered scene list |
| `scene:updated` | Current authorized campaign audience and exact current version of active scene settings only. The client reloads the authorized scene snapshot |
| `token:created`, `token:updated`, `token:moved` | Current subscribers with an active visible token projection for Players and wider manager scope |
| `chat:message` | Current authorized campaign subscribers |
| `chat:private` | Authorized sessions of the sender and recipient |
| `dice:result` | Current campaign subscribers for public and current managers for hidden |
| `initiative:updated` | Current campaign subscribers receive the Player projection |
| `initiative:gm_updated` | Current subscribed managers receive the full projection |
| `scene:layer_created`, `scene:layer_updated`, `scene:layer_deleted` | Current campaign audience. Players receive current public metadata on an active scene and ID-only deletion of formerly public layers |
| `scene:layer_hidden` | Eligible Players receive only `{sceneId, layerId}` when the formerly public layer is still inaccessible. Managers can receive the current private layer update |
| `scene:object_created`, `scene:object_updated`, `scene:object_deleted` | Current campaign audience. Player upserts require a current visible object on a readable layer and active scene. Manager upserts can include private data. Loss of public visibility sends Player removal with IDs only |
| `scene:pointer` | Transient coordinates and server-derived user identity; active scene pointers go to authorized campaign members, while GM draft pointers go to current managers only. Clients expire markers after 1.6 seconds; pointers are not persisted |

Players receive the active, non-archived scene in REST scene lists and token snapshots. Direct token snapshots for inactive or archived scenes are denied. Hidden token fields, note fields, scene items and initiative use role-specific projections. An owner-note event requires an authorized session of the currently assigned owner and the current visible active-scene token revision. The ordinary token projection updates the former owner. Players may adjust visible resource tracks on owned tokens. Player object snapshots omit deleted objects, GM layers, other non-visible layers and invisible objects.


### Private channel recovery

Private chat is delivered to matching personal sockets of current members, including another active login with a different campaign open. `GET /api/campaigns/:campaignId/messages` uses current viewer entitlement and returns the latest 100 permitted messages in chronological order. Original participants keep their own threads while members. A hidden roll uses the current manager audience, including the sending ACK. A committed append can return `FORBIDDEN` without a payload if the sending socket loses access before enqueue. Dice has no REST history.

`chat:send` carries `clientMessageId`; `dice:roll` carries `requestId`. Each ID is scoped to the authenticated user and campaign and is bound to a digest of result-affecting input. Same-ID/same-payload retries return the saved message or roll. Changed payload returns `CONFLICT`. The sender's current session and membership, current private-chat recipient rights, and current hidden-roll role are checked on replay. Replays ACK the original result but do not publish a second game event. IDs live as long as the message/roll row; campaign deletion removes both. The web client retries explicitly with the same in-memory payload after a missing ACK and never retries automatically. Other commands are not covered; see the [operation matrix](COMMAND_RETRY_POLICY.md).

Initiative packets identify the campaign. The browser uses both projection events as invalidations appropriate to its current role, accepts only its current REST request and scope, and never restores state from a replayed packet. A later revision suppresses an older pending publication. A linked token hide or reveal invalidates the same tracker revision. Hidden turns have a null `currentEntryId` for Players.

A targeted note packet has `id`, `ownerUserId`, `ownerNote` and `version` and requires current assignment, subscription and the current visible live token on the active scene. The client merges a note only when the current owner and token version match and drops old notes on reassignment. Reconnect hydrates the current projected tokens. Queued packets, previously rendered data and user copies are outside revocation. Delivery has no durable queue, replay cursor, global order or exactly-once contract.

## Concurrency and recovery limits

Scene-content UI treats positive events as invalidations of the scoped REST snapshot. It discards superseded responses, coalesces refreshes queued together and immediately removes known objects/layers on a removal event. A layer reveal reloads the authorized layer and object snapshots. Older revisions, duplicates and events from another workspace cannot restore records from packet payloads. Snapshot readers lock current session, membership and scene while selecting their projections. The client also drops any object whose layer is absent from the paired layer response.

Scene update and activation events are invalidations: the browser ignores their scene projection/ID and reloads the current role-filtered scene list. Drawing-permission and membership-change notifications likewise cause a current REST read or server rejoin instead of applying the packet's role/flag. A removal notice remains personal after the database membership disappears; if the response is delayed until an invitation is accepted, the current campaign list preserves the workspace and the client rejoins its new membership. Campaign archive uses the same availability check before clearing the scene.

The scene publisher keeps database authorization and entity locks until Socket.IO enqueue, checks local subscription and expiry at each send and then releases the locks. Revocation after enqueue cannot cancel transport already in progress. There is no retained queue or global event order. If a publication cannot obtain a stable affected-layer set in its bounded retry, the next snapshot reconciles the result. [Audit matrix](../security/REALTIME_EVENT_MATRIX.md)

`PATCH /api/scenes/:sceneId/object-lifecycle` accepts `{action, objects: [{objectId, expectedVersion}]}` and returns `{objects}` with committed versions. Group conflicts keep the code-only response. A missing target or a target outside the requested scene returns `NOT_FOUND` to an authorized manager. Players receive `FORBIDDEN` from the group endpoint before it looks up any object. A hidden or missing target on the Player point-delete path receives `NOT_FOUND`. Restore preserves IDs and visibility flags.

Committed deletes use `scene:object_deleted` with `{sceneId, objectId}`. Restores reuse `scene:object_created` with `{object}`. The lifecycle publisher uses the room to find candidates and checks current session, role, scene and layer again in PostgreSQL. It suppresses packets for superseded revisions and filters private objects, layers and creator IDs from Players. Public removal packets require both prior public visibility and a currently readable layer. Clients can reconcile missed live events from scoped snapshots after reconnect.

`token:move` and `PATCH /api/scenes/:sceneId/tokens/group` share the [token movement transaction](ARCHITECTURE.md#token-movement-transaction). The group returns `{tokens}` after commit, HTTP 409 with `CONFLICT` for a stale authorized batch, or HTTP 403 with `FORBIDDEN` for forbidden movement on an accessible scene, including a positional patch on any locked target. Unknown and inaccessible scenes share the HTTP 404 response. Group rejections carry only an error code. An authorized Player-owner single conflict can include their owner note and visible resource tracks. The regular Player acknowledgement and public broadcast omit private notes.

The service commits before any successful movement or group event is queued. For these commands, sockets in the campaign room are delivery candidates. The publisher checks live sessions and roles in PostgreSQL and applies current scene and token visibility. A formerly public token hidden by a group update can emit `token:hidden` with only the token and scene IDs. Publication can reflect a newer committed version if another update wins before delivery. The acknowledgement is the scoped result at the command transaction. On transport interruption, subsequent snapshots reconcile durable state. The transport provides best-effort live delivery.

Mutable records use `expectedVersion`. A stale authorized `token:move` may return the latest allowed token projection. Token group updates and object lifecycle groups fail atomically if any expected version is stale. Undo/Redo submits inverse commands with the recorded versions, under current permissions. Clients rejoin and refill campaign and scene snapshots after reconnect. Scope checks discard late results from previous workspaces, and token events received while a snapshot loads are applied on top of it.

Command IDs and idempotency keys would help with non-idempotent chat and dice after a lost acknowledgement. The current client does not automatically retry these commands. Token/object edits use revision checks and snapshots. An event cursor or transactional outbox would become relevant when durable replay or delivery across API instances is required. The single-instance deployment uses in-memory rooms and has no general durable realtime replay contract.

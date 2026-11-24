# Realtime protocol (implemented)

Socket.IO is used for multiplayer delivery. The current implementation uses named event payloads and acknowledgement callbacks; it does **not** implement a protocol-version envelope, command IDs, event cursors, replay, or general idempotency. This document describes the wire behavior that exists today.

## Connection and rooms

The server resolves the opaque HTTP session cookie during the Socket.IO handshake. Missing, expired, or revoked sessions are rejected. `campaign:join` takes a campaign UUID; the server checks current membership, joins `campaign:<id>`, and additionally joins `campaign:<id>:gm` for Owner/GM. `campaign:leave` leaves both rooms. Sensitive commands also check room membership and current role. Membership removal emits `membership:removed` to the affected `user:<id>` room and removes that socket from campaign rooms.

## Client commands

| Event | Payload | Acknowledgement / checks |
|---|---|---|
| `campaign:join` | campaign UUID string | `{ok, role}` or `{error}`; role is resolved on server |
| `campaign:leave` | campaign UUID string | no acknowledgement |
| `token:move` | `{tokenId, x, y, expectedVersion}` | `{ok, token}` or `{error}`; ownership/role, active scene, room and optimistic token version checked |
| `chat:send` | `{campaignId, body, recipientId?}` | `{ok, message}` or `{error}`; recipient membership and Player-to-GM private-message policy checked |
| `dice:roll` | `{campaignId, expression}` | `{ok, roll}` or `{error}`; server parses and generates dice results |

REST endpoints currently implement scene activation and editing, token creation/ownership, and initiative mutations. Their successful changes publish selected events after persistence. There is no general command deduplication key; clients should not retry non-idempotent commands blindly.

## Server events and confidentiality

| Event | Audience / purpose |
|---|---|
| `presence:joined` | Other campaign-room members |
| `membership:changed` | Campaign room, role update notification |
| `membership:removed` | Affected user's personal room; client clears campaign state |
| `scene:activated` | Campaign room, `{sceneId}` or `null`; clients reload role-filtered scene list |
| `scene:updated` | Campaign room, public projection, active scene settings only |
| `token:created`, `token:updated`, `token:moved` | Campaign room for visible active-scene tokens; GM room for hidden or inactive-scene tokens |
| `chat:message` | Campaign room for public messages |
| `chat:private` | Sender and recipient personal rooms |
| `dice:result` | Campaign room |
| `initiative:updated` | Campaign room, player-safe projection |
| `initiative:gm_updated` | GM room, full projection |

Players receive only the active, non-archived scene in REST scene lists and token snapshots. Direct token snapshots for inactive/archived scenes are denied. Hidden token snapshots and hidden initiative details use separate role projections. Clients must not use local filtering as an access control.

## Concurrency and recovery limits

Mutable scenes and tokens use `expectedVersion`; stale writes return `CONFLICT`. Reconnect requires a new authenticated connection and clients reload campaign and tabletop REST snapshots. There is no durable event log or cursor replay. The multiplayer smoke covers reconnect snapshots and scene lifecycle privacy, but simultaneous competing moves, every hidden-object event edge, and socket revocation across multiple simultaneous connections still require additional coverage.

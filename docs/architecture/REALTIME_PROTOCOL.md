# Realtime protocol

Socket.IO transports versioned commands and events; it does not grant authority. HTTP and realtime commands use the same validated application services and authorization policy.

## Connection and rooms

Authenticate using the same server session as HTTP. Reject missing, expired, revoked, or invalid sessions before joining any room. A socket joins a campaign room only after membership lookup. Room membership is rechecked for sensitive commands and removed on membership revocation. Never infer a role from client-supplied fields.

## Command envelope

```json
{
  "protocolVersion": 1,
  "commandId": "opaque-client-generated-id",
  "campaignId": "opaque-id",
  "expectedVersion": 12,
  "type": "token.move",
  "payload": { "tokenId": "opaque-id", "x": 4, "y": 7 }
}
```

All fields and command types are schema validated. Server replies with `command.accepted` and a committed revision, or a stable typed error (`UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `INVALID`, `CONFLICT`, `RATE_LIMITED`). Idempotency is scoped to actor and command ID for operations that may be retried.

## Event envelope and confidentiality

```json
{
  "protocolVersion": 1,
  "eventId": "opaque-id",
  "campaignId": "opaque-id",
  "revision": 13,
  "type": "token.moved",
  "payload": { "tokenId": "opaque-id", "x": 4, "y": 7 }
}
```

Events are emitted only after transaction commit. Each audience receives a server-built projection. Hidden tokens and secret messages are omitted entirely from player snapshots and event payloads; client filtering is not a security control. Secret messages are delivered only to sender and authorized recipient. Do not include hidden IDs or counts when those leak sensitive information.

## Recovery

On reconnect, authenticate and reauthorize campaign membership, then return a filtered snapshot with a revision cursor. Replay only events the user is allowed to see after that cursor; if retention is insufficient, send a fresh filtered snapshot. Clients deduplicate event IDs and discard stale revisions. Camera state remains local to each client.

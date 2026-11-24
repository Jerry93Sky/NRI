# Architecture

## V0.1 shape

Use a pnpm TypeScript workspace with a React/Vite frontend, a Fastify application, shared Zod contracts, and domain modules in a modular monolith. PostgreSQL is the durable source of truth; Socket.IO carries authorized realtime events. Prisma migrations describe the schema. Uploaded media goes to a local storage adapter in development and behind an interface suitable for later S3-compatible storage.

```text
Browser (React, PixiJS)
  ├── HTTPS JSON API ── Fastify ── domain/application services ── Prisma ── PostgreSQL
  └── Socket.IO ─────── auth + campaign room authorization ───────┘
                                      └── asset storage adapter ── local files
```

Shared contracts validate all external input and realtime payloads. REST and Socket.IO handlers call the same application/domain services. The browser is a renderer and command source; it is never authoritative for roles, random results, or final state.

## Module boundaries

- `identity`: users, password hashes, sessions, account lifecycle.
- `campaigns`: campaign metadata, membership, invitations, archive lifecycle.
- `assets`: validation, storage metadata, safe authorized media delivery.
- `tabletop`: scenes, layers, tokens, ownership, grid, object versions.
- `messaging`: public and secret message projection and retention.
- `dice`: bounded grammar and server-side randomness.
- `initiative`: turn ordering and atomic transitions.
- `realtime`: session-to-socket binding, room authorization, sequencing and snapshots.
- `audit`: append-only records for sensitive changes, with careful redaction.

Do not add placeholder modules for later products.

## State flow and concurrency

Authenticate every HTTP and WebSocket connection. Resolve campaign membership and role on each operation. Validate a command, check its object version and permissions, apply it in a database transaction, record audit where needed, commit, then publish a sanitized versioned event. Clients send command IDs for retry-safe critical operations. A stale version returns a conflict and authoritative revision; it does not overwrite silently. Reconnect uses a permission-filtered snapshot plus events after the snapshot cursor.

## Security and operations

Never broadcast ORM records directly. Build public and GM-specific projections. Enforce asset access at the server for every request. Do not log passwords, session IDs, invite secrets, message bodies marked secret, or hidden object payloads. Production uses HTTPS, secure cookies, generated secrets, restrictive origins, backups, and operator-managed secrets. No billing, AI dependency, or production readiness claim is part of this design.

## Extension points

Rules packages can later attach to campaign metadata and character records; campaign tooling can consume scene and entity IDs; a world simulator may propose commands through an audited GM approval boundary. Keep V0.1 free of game-specific schema assumptions.

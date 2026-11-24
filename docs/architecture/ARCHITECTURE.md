# Architecture

## V0.1 shape

Use a pnpm TypeScript workspace with a React/Vite frontend, a Fastify application, shared Zod contracts, and cohesive modules in a modular monolith. PostgreSQL is the durable source of truth; Drizzle ORM and Drizzle Kit migrations manage the schema. Socket.IO carries realtime events. Uploaded media currently uses a local filesystem directory configured with `UPLOAD_DIR`; the storage adapter is not yet abstracted for S3.

```text
Browser (React, PixiJS)
  ├── HTTP JSON API ── Fastify ── route/domain logic ── Drizzle ── PostgreSQL
  └── Socket.IO ─────── auth + campaign room authorization ───────┘
                                      └── asset storage adapter ── local files
```

Shared Zod contracts validate selected input boundaries. Several Socket.IO handlers still contain logic directly in `apps/server/src/index.ts`; common REST/socket application services are a V0.1.1 refactoring target. The browser is a renderer and command source; it is never authoritative for roles, random results, or final state.

## Module boundaries

Current code is primarily in `apps/server/src/index.ts` and `apps/server/src/db/`: auth, campaigns/membership, assets, scenes/tokens, messaging, dice, initiative, sockets and audit writes are route-level concerns. `packages/contracts` contains shared schemas and pure dice/movement rules. The named modules below are boundaries to extract as related V0.1.1 work is implemented, not existing directories.

Do not add placeholder modules for later products.

## State flow and concurrency

Authenticate every HTTP and WebSocket connection. The current handlers resolve membership for protected requests and use optimistic versions for scene/token/initiative writes. Not every multi-record operation shares a transaction, mutation command IDs are not implemented, and reconnect currently reloads scene state instead of replaying a durable event cursor. V0.1.1 should close these gaps before making broader reliability claims.

## Security and operations

Never broadcast ORM records directly. Build public and GM-specific projections. Enforce asset access at the server for every request. Do not log passwords, session IDs, invite secrets, message bodies marked secret, or hidden object payloads. Production uses HTTPS, secure cookies, generated secrets, restrictive origins, backups, and operator-managed secrets. No billing, AI dependency, or production readiness claim is part of this design.

## Extension points

Rules packages can later attach to campaign metadata and character records; campaign tooling can consume scene and entity IDs; a world simulator may propose commands through an audited GM approval boundary. Keep V0.1 free of game-specific schema assumptions.

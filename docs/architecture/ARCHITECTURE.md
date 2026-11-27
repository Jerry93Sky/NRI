# Architecture

## V0.1 shape

The pnpm TypeScript workspace contains a React/Vite frontend, a Fastify application and shared Zod contracts. PostgreSQL owns durable state. Drizzle ORM and Drizzle Kit migrations manage the schema. Socket.IO carries realtime events. Uploaded media uses the local filesystem directory configured by `UPLOAD_DIR`.

```text
Browser (React, PixiJS)
  ├── HTTP JSON API ── Fastify ── route/domain logic ── Drizzle ── PostgreSQL
  └── Socket.IO ─────── auth + campaign room authorization ───────┘
                                      └── asset module ── local files
```

Shared Zod contracts validate command inputs and define public token, layer and object shapes. The browser sends commands and renders server results. The server owns roles, random results and committed state.

## Module boundaries

- `index.ts` starts and shuts down the HTTP process. `app.ts` configures the server, middleware and route registration. `config/runtime.ts` validates the deployment settings for this process.
- Route modules own auth, campaigns, invitations and membership, chat, initiative, scenes, scene content, tokens and assets. `security/access.ts` shares session, role and body validation. `domain/projections.ts` owns sensitive projection rules. `realtime/` owns session and campaign subscriptions, command limits and socket commands.
- Several transactions and publications still sit in the feature route modules. Extracting shared token and scene mutation services remains open.
- The web app uses a scoped snapshot-and-event hook in `features/tabletop/useTabletopSync.ts`, versioned undo/redo in `useCommandHistory.ts`, an HTTP helper in `services/api.ts` and the lazy Pixi component in `ui/TableCanvas.tsx`. `App.tsx` retains page assembly and several workflow handlers.

## State flow and concurrency

HTTP and WebSocket operations resolve identity and campaign role. Scene, token, object and initiative writes use optimistic versions. Token groups, object copy and lifecycle groups use PostgreSQL transactions. The browser rejoins after reconnect and reloads its scoped snapshots. Some permission checks precede their mutation transaction. See [realtime details](REALTIME_PROTOCOL.md) for current limits.

## Security and operations

The security review tracks projection and media ACLs by role. The closed-alpha Compose configuration has locally verified HTTPS and shutdown paths. Operators manage deployment secrets, network restrictions and backups. [Security review](../security/V0.1.1_REVIEW.md) · [Production deployment](../operations/PRODUCTION_DEPLOYMENT.md)

## Extension points

Rules packages can later attach to campaign metadata and character records; campaign tooling can consume scene and entity IDs; a world simulator may propose commands through an audited GM approval boundary. Keep V0.1 free of game-specific schema assumptions.

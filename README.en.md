# NRI Platform

NRI Platform is a system-neutral virtual tabletop for role-playing games. Its core is not tied to a particular ruleset; game masters manage campaigns, scenes, tokens, and player access.

## Status

- **Version:** V0.1.1 — Tabletop Foundation Completion & Playability
- **Implementation:** IN_PROGRESS
- **Automated checks:** AUTOMATED_TESTS_PASSED for the local checks that exist
- **Owner acceptance:** IN_PROGRESS — V0.1.1 technical gates remain open

The API and web interface run locally, and `Amber Crossing` is available for manual review. A basic layer panel and rectangle/ellipse objects are available, while full object editing, image-backed calibration acceptance, expanded token properties, asset library, tabletop tools, Playwright, backup/restore, and load checks remain incomplete. See the [scope](docs/releases/V0.1.1_SCOPE.md) and [V0.1.1 acceptance report](docs/releases/V0.1.1_ACCEPTANCE_REPORT.md).

## Implemented

- Registration, login, logout, sessions, and rate limits.
- Campaigns, Owner/GM/Player roles, capped and revocable invitations, archive and restore.
- Scenes with a player-active version and GM drafts, rename, duplicate, archive/restore, ordering, and configurable grid/camera; players receive only the active scene.
- Tokens, ownership assignment, server-authorized movement, and Socket.IO synchronization. The tabletop has active-layer selection, visibility/lock controls, rectangle/ellipse creation, and active-layer canvas dragging/resizing. Object visibility, lock, rotation, opacity, z-order, same-scene layer move, duplicate, delete, and rendering are also available. The server enforces versions and GM-content filtering. Image rendering, layer ordering, and clipboard workflows remain incomplete. The drag/resize gestures have not been manually exercised in the browser.
- Public and private chat, server-side dice rolls, and initiative with hidden-turn filtering.
- Russian and English UI, local development, Docker Compose, PostgreSQL migrations, and a CI workflow.

## V0.1.1 limitations

- Full layer/object editing, expanded token sheets, and undo/redo are not implemented yet. Grid calibration now previews cell size and offsets before saving; map-backed browser acceptance still needs a scene with an uploaded map.
- Maps accept PNG/JPEG/WebP up to 12 MB; local storage does not validate full image decoding or dimension limits.
- There is no automated Playwright suite, isolated backup restore drill, or performance measurement report. Package-local Vitest suites and a PostgreSQL API/Socket.IO smoke have been run.
- Full layer/object editing, campaign export, and production deployment are not complete. GitHub Actions runs #33 and #34 passed on active-layer drag/resize implementation commit `581b066`.
- The asset library and additional tabletop tools are incomplete; full security review and owner acceptance are pending.

## Stack

React, TypeScript, Vite, PixiJS, Zustand, i18next; Node.js 24.13, Fastify, Socket.IO, PostgreSQL 16, Drizzle, Zod, pnpm workspaces, Docker Compose, Vitest, and GitHub Actions.

## Run and check

See [local setup](docs/development/LOCAL_SETUP.md). Main commands:

```powershell
corepack pnpm@12.23.0 install --frozen-lockfile
docker compose up -d db
corepack pnpm@12.23.0 db:migrate
corepack pnpm@12.23.0 dev
```

In another terminal:

```powershell
corepack pnpm@12.23.0 build
corepack pnpm@12.23.0 typecheck
corepack pnpm@12.23.0 test
```

The multiplayer integration test is documented in the [acceptance report](docs/releases/V0.1_ACCEPTANCE_REPORT.md). Do not publish `.env`, user data, or uploaded maps.

## Documentation and roadmap

- [Product vision](docs/product/PRODUCT_VISION.md) · [Roadmap](docs/product/ROADMAP.md) · [V0.1 scope](docs/product/V0_1_SCOPE.md)
- [Architecture](docs/architecture/ARCHITECTURE.md) · [Data model](docs/architecture/DATA_MODEL.md) · [Realtime protocol](docs/architecture/REALTIME_PROTOCOL.md)
- [Threat model](docs/security/THREAT_MODEL.md) · [Commercial strategy](docs/product/COMMERCIAL_STRATEGY.md)
- [Changelog](CHANGELOG.md) · [Third-party notices](THIRD_PARTY_NOTICES.md)

V0.1.1 is the active phase; V0.2 Tactical Tabletop starts after its acceptance. No project-wide source license has been selected; all rights remain with their owners.

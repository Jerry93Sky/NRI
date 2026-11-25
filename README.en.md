# NRI Platform

NRI Platform is a system-neutral virtual tabletop for role-playing games. Its core is not tied to a particular ruleset; game masters manage campaigns, scenes, tokens, and player access.

## Status

- **Version:** V0.1.1 — Tabletop Foundation Completion & Playability
- **Implementation:** IN_PROGRESS
- **Automated checks:** AUTOMATED_TESTS_PASSED for the local checks that exist
- **Owner acceptance:** IN_PROGRESS — V0.1.1 technical gates remain open

The API and web interface run locally, and `Amber Crossing` is available for manual review. Basic layer tools, library image and editable text objects, a temporary ruler and shared pointer with R/F/P/S/Escape shortcuts, token appearance/visibility, recoverable deletion, token images, two privacy-filtered generic resource tracks, GM/owner notes, atomic group token actions, and a categorized multi-file campaign asset library are available. A selected scene object can be copied with Ctrl/Cmd+C and pasted with Ctrl/Cmd+V onto the active editable layer; token and multi-object clipboard workflows remain open. Image/text rendering is implemented but has not been browser-accepted. Image-backed calibration, broader edit history, complete object editing, asset thumbnails/folders, drawing permissions, the remaining Playwright scenarios, and load checks remain incomplete. A two-context Playwright scenario covers invitations, draft/GM-layer privacy, and denied player writes. An isolated backup restore passed; a coordinated maintenance drill remains open. See the [scope](docs/releases/V0.1.1_SCOPE.md) and [V0.1.1 acceptance report](docs/releases/V0.1.1_ACCEPTANCE_REPORT.md).

## Implemented

- Registration, login, logout, sessions, and rate limits.
- Campaigns, Owner/GM/Player roles, capped and revocable invitations, archive and restore.
- Scenes with a player-active version and GM drafts, rename, duplicate, archive/restore, ordering, and configurable grid/camera; players receive only the active scene.
- Tokens, ownership assignment, server-authorized movement, and Socket.IO synchronization. GMs can edit token appearance/visibility, GM notes and owner notes with optimistic versions, configure two generic tracks, recover deleted tokens, and atomically change lock/visibility on up to 50 selected tokens. Token images are rendered and player reads are limited to visible tokens in the active scene. GM notes stay with GMs; owner notes are sent only to the assigned owner and GMs. Players see only visible tracks and can adjust them only on owned tokens; the server enforces bounds and versions. Locked tokens reject movement, and hide/show events preserve player filtering. The tabletop has layer selection/order/visibility/lock controls, library-backed image and editable text objects, line and rectangle/ellipse creation, GM freehand drawing with color and stroke-width controls, and active-layer canvas dragging/resizing for objects. Object visibility, lock, color, rotation, opacity, z-order, same-scene layer move, duplicate, delete, and rendering are also available. Image/text insertion and rendering are implemented but not manually exercised in the browser. Pointer authorization has server smoke coverage, while its browser display remains untested; typography controls, token/multi-object clipboard, and history for edits beyond group movement remain incomplete. Single-object scene copy/paste is available in-app. The drag/resize and freehand gestures have not been manually exercised in the browser.
- Public and private chat, server-side dice rolls, and initiative with hidden-turn filtering.
- Russian and English UI, local development, Docker Compose, PostgreSQL migrations, and a CI workflow.

## V0.1.1 limitations

- Full layer/object editing, token and multi-object clipboard, and broader undo/redo are still open; movement-only group undo/redo is available. Single-object scene copy/paste is available in-app. Grid calibration previews cell size and offsets before save; map-backed browser acceptance still needs a scene with an uploaded map.
- Images accept PNG/JPEG/WebP up to 12 MB each. Ingest checks file signatures, image headers, dimensions, and a 64 MiB decoded-pixel bound, but does not decode the full image stream. Category metadata, search, name/size sorting, previews, storage totals, and map/object/token usage counts are available; unused-only deletion is enforced. Generated thumbnails and folders remain open.
- A focused two-context Playwright suite exists; full workflow coverage, an automated backup job, and a performance measurement report remain open. An isolated `nri_test` restore passed row-count and referenced-media SHA-256 checks; a production-like maintenance-window drill remains open.
- Full layer/object editing, campaign export, and production deployment are not complete. GitHub Actions runs #93 and #94 failed on `307441f` because the smoke and browser suites shared an API process and exhausted the in-memory auth rate limit. The browser suite now uses a fresh API process; CI for that fix is pending.
- The asset library and additional tabletop tools are incomplete; full security review and owner acceptance are pending. Full and production dependency audits now pass after remediation of two moderate advisories; the targeted security review is still in progress.

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
- [Backup and restore procedure](docs/operations/BACKUP_RESTORE.md)
- [Threat model](docs/security/THREAT_MODEL.md) · [Commercial strategy](docs/product/COMMERCIAL_STRATEGY.md)
- [Changelog](CHANGELOG.md) · [Third-party notices](THIRD_PARTY_NOTICES.md)

V0.1.1 is the active phase; V0.2 Tactical Tabletop starts after its acceptance. No project-wide source license has been selected; all rights remain with their owners.

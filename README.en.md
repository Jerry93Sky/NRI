# NRI Platform

NRI Platform is a system-neutral virtual tabletop for role-playing games. Its core is not tied to a particular ruleset; game masters manage campaigns, scenes, tokens, and player access.

## Status

- **Version:** V0.1.1 — Tabletop Foundation Completion & Playability
- **Implementation:** IN_PROGRESS
- **Automated checks:** AUTOMATED_TESTS_PASSED for commit `bc26408` (GitHub Actions #184)
- **Owner acceptance:** IN_PROGRESS — V0.1.1 technical gates remain open

The API and web interface are available locally, and the separate `Amber Crossing: The Lantern Vault` campaign is prepared for manual review. Implemented workflows include GM drafts and an active Player scene, layers and scene objects, grid setup and calibration, tokens with privacy-filtered resources and notes, a campaign image library with folders, group actions, ruler, pointer, and drawing tools. Public/private chat, public/hidden rolls, initiative, reconnect, and versioned token-move conflict handling are supported. The right rail, fullscreen mode, and theme controls have automated browser coverage; Chromium checks layouts at 1366×768, 1920×1080, and 2560×1440. A focused Chromium check also confirms unused Pixi textures are released when leaving an asset scene and fetched again on return. GitHub Actions run #184 passed on commit `bc26408`, including removal of a member with two active Player sessions: both received revocation notices, stopped receiving campaign events, and were denied writes. These are automated checks, not owner acceptance. Open items include owner review of a full demo session and map calibration, parts of object editing and Undo/Redo, broader security review, a coordinated maintenance-window backup/restore, scheduled retention, and real performance measurements. See the [scope](docs/releases/V0.1.1_SCOPE.md) and [V0.1.1 acceptance report](docs/releases/V0.1.1_ACCEPTANCE_REPORT.md) for evidence and limitations.

## Implemented

The “Amber Crossing: The Lantern Vault” demo can be prepared with `corepack pnpm@12.23.0 db:seed:playable-amber`. It creates a separate campaign with three scenes and original procedural maps and portraits, leaving the original `Amber Crossing` untouched. Owners and GMs can make an independent campaign copy with new scene, layer, object, token, asset, and file IDs. See the [session guide](docs/demo/AMBER_CROSSING_PLAY_GUIDE.md) and [asset provenance register](docs/demo/ASSET_PROVENANCE.md). The copy workflow passed a dedicated two-context Playwright scenario; full manual campaign review remains open.

- Registration, login, logout, sessions, and rate limits.
- Campaigns, Owner/GM/Player roles, capped and revocable invitations, archive and restore.
- No-overwrite PostgreSQL/media backup commands with SHA-256 manifest verification (`db:backup`, `db:backup:verify`); a coordinated maintenance drill and scheduled retention remain open.
- The campaign library supports folders, filtering, moving assets, rename and delete; deleting a folder keeps its files in the library, and campaign copies remap folder and asset IDs.
- Scenes with a player-active version and GM drafts, rename, duplicate, archive/restore, ordering, and configurable grid/camera; players receive only the active scene.
- Tokens, ownership assignment, server-authorized movement, and Socket.IO synchronization. Canvas dragging converts screen deltas back to scene coordinates at the current zoom; an isolated Chromium flow verifies a one-cell GM move appears on the Player canvas. A version-conflict acknowledgement returns the latest privacy-filtered token snapshot to the authorized client. GMs can edit token appearance/visibility, GM notes and owner notes with optimistic versions, configure two generic tracks, recover deleted tokens, and atomically change lock/visibility on up to 50 selected tokens. Token images are rendered and player reads are limited to visible tokens in the active scene. GM notes stay with GMs; owner notes are sent only to the assigned owner and GMs. Players see only visible tracks and can adjust them only on owned tokens; the server enforces bounds and versions. Locked tokens reject movement, and hide/show events preserve player filtering. The tabletop has layer selection/order/visibility/lock controls, library-backed image and editable text objects, line and rectangle/ellipse creation, GM freehand drawing with color and stroke-width controls, and active-layer canvas dragging/resizing for objects. Object visibility, lock, color, rotation, opacity, z-order, same-scene layer move, duplicate, delete, and rendering are also available. Image/text insertion and rendering are implemented but not manually exercised in the browser. Pointer authorization and GM-to-Player event delivery have API smoke and Playwright coverage; visual crosshair timing has not been manually accepted; typography controls and history for edits beyond group movement remain incomplete. Single and group scene-object copy/paste is available in-app. GM drag/resize and broader object editing have not been manually exercised in the browser; the Player stroke workflow has automated browser coverage. The tabletop right rail supports locally persisted width and collapse preferences, and the workspace can enter fullscreen and switch between locally persisted light/dark themes; the Chromium suite exercises these controls.
- Public and private chat, public rolls, GM-only hidden rolls, server-side dice, and initiative with hidden-turn filtering.
- An isolated Chromium scenario checks a one-cell token drag at the current canvas scale and Player realtime update, plus Socket.IO offline/online reconnection and post-reconnect chat delivery.
- Russian and English UI, local development, Docker Compose, PostgreSQL migrations, and a CI workflow.

## V0.1.1 limitations

- Undo/Redo covers movement only; full history for object and property edits is not implemented. Some shape and text editing gestures still need manual review.
- The browser race between two authorized token movers, GM/Player recovery after API restart, and removal of a member with two active sockets are covered; a broader role/permission revocation matrix remains open.
- Local backup/restore and manifest verification passed on isolated databases. A coordinated quiesced maintenance window, scheduled retention, and confirmation of all required restored data remain open.
- Measurements for three load scenes and six players, including FPS, latency, memory, server load, and hardware texture limits, have not been collected.
- Owner review of calibration on a mapped scene and a complete demo session remains open. The targeted security review is not independent certification.

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

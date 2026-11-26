# NRI Platform

NRI Platform is a system-neutral virtual tabletop for role-playing games. Its core is not tied to a particular ruleset; game masters manage campaigns, scenes, tokens, and player access.

## Status

- **Version:** V0.1.1 — Tabletop Foundation Completion & Playability
- **Implementation:** IN_PROGRESS
- **Automated checks:** AUTOMATED_TESTS_PASSED for the local checks that exist
- **Owner acceptance:** IN_PROGRESS — V0.1.1 technical gates remain open

The API and web interface run locally, and `Amber Crossing` is available for manual review. Basic layer tools, library image and editable text objects, a temporary ruler and shared pointer with R/F/P/S/Escape shortcuts, token appearance/visibility, recoverable deletion, token images assignable in token properties or by dragging from the library onto the table, two privacy-filtered generic resource tracks, GM/owner notes, atomic group token actions, and a categorized multi-file campaign asset library with button and drag-and-drop upload are available. A GM or Owner can enable Player freehand drawing in the active scene; the server limits strokes to visible unlocked Objects layers, and Players can edit, delete individually, or clear their own strokes on that scene. A GM can Shift/Ctrl/Cmd-click up to 50 scene objects in the layer list and copy/paste them with Ctrl/Cmd+C and Ctrl/Cmd+V onto the active editable layer; the server checks source versions and creates the group atomically. A GM can also copy and paste up to 50 selected tokens atomically; duplicates get new IDs and locations, with ownership and owner-private notes cleared. Image/text rendering is implemented but has not been browser-accepted. The asset library fully decodes accepted PNG/JPEG/WebP uploads within a pixel bound and generates WebP thumbnails behind the same authorization checks as original files. Campaign-folder organization remains open. Automated Chromium checks confirm no horizontal page overflow and a usable tabletop at 1366×768, 1920×1080, and 2560×1440; owner visual acceptance remains open. Owner manual review of mapped calibration, broader edit history, complete object editing, remaining Playwright scenarios, and load checks remain incomplete. Three browser contexts also verify that public chat and a public d20 result reach both players while private GM chat reaches only its selected player and hidden rolls reach only GMs; they also exercise initiative start, advance, and stop. Chat and dice state clear on campaign switch, and late history responses or events from another campaign are ignored; Playwright verifies this. Playwright scenarios cover map calibration, invitations, single and group token copy/paste, grouped object copy with stale-version all-or-nothing behavior, draft/GM-layer privacy, hidden-object filtering, denied player writes, GM-controlled Player drawing with own-stroke deletion, bulk clearing after revocation, and denial checks, and drag-and-drop image upload with its thumbnail preview. An isolated backup restore passed; a coordinated maintenance drill remains open. See the [scope](docs/releases/V0.1.1_SCOPE.md) and [V0.1.1 acceptance report](docs/releases/V0.1.1_ACCEPTANCE_REPORT.md).

## Implemented

The “Amber Crossing: The Lantern Vault” demo can be prepared with `corepack pnpm@12.23.0 db:seed:playable-amber`. It creates a separate campaign with three scenes and original procedural maps and portraits, leaving the original `Amber Crossing` untouched. Owners and GMs can make an independent campaign copy with new scene, layer, object, token, asset, and file IDs. See the [session guide](docs/demo/AMBER_CROSSING_PLAY_GUIDE.md) and [asset provenance register](docs/demo/ASSET_PROVENANCE.md). The copy workflow passed a dedicated two-context Playwright scenario; full manual campaign review remains open.

- Registration, login, logout, sessions, and rate limits.
- Campaigns, Owner/GM/Player roles, capped and revocable invitations, archive and restore.
- No-overwrite PostgreSQL/media backup commands with SHA-256 manifest verification (`db:backup`, `db:backup:verify`); a coordinated maintenance drill and scheduled retention remain open.
- Scenes with a player-active version and GM drafts, rename, duplicate, archive/restore, ordering, and configurable grid/camera; players receive only the active scene.
- Tokens, ownership assignment, server-authorized movement, and Socket.IO synchronization. Canvas dragging converts screen deltas back to scene coordinates at the current zoom; an isolated Chromium flow verifies a one-cell GM move appears on the Player canvas. A version-conflict acknowledgement returns the latest privacy-filtered token snapshot to the authorized client. GMs can edit token appearance/visibility, GM notes and owner notes with optimistic versions, configure two generic tracks, recover deleted tokens, and atomically change lock/visibility on up to 50 selected tokens. Token images are rendered and player reads are limited to visible tokens in the active scene. GM notes stay with GMs; owner notes are sent only to the assigned owner and GMs. Players see only visible tracks and can adjust them only on owned tokens; the server enforces bounds and versions. Locked tokens reject movement, and hide/show events preserve player filtering. The tabletop has layer selection/order/visibility/lock controls, library-backed image and editable text objects, line and rectangle/ellipse creation, GM freehand drawing with color and stroke-width controls, and active-layer canvas dragging/resizing for objects. Object visibility, lock, color, rotation, opacity, z-order, same-scene layer move, duplicate, delete, and rendering are also available. Image/text insertion and rendering are implemented but not manually exercised in the browser. Pointer authorization and GM-to-Player event delivery have API smoke and Playwright coverage; visual crosshair timing has not been manually accepted; typography controls and history for edits beyond group movement remain incomplete. Single and group scene-object copy/paste is available in-app. GM drag/resize and broader object editing have not been manually exercised in the browser; the Player stroke workflow has automated browser coverage. The tabletop right rail supports locally persisted width and collapse preferences, and the workspace can enter fullscreen and switch between locally persisted light/dark themes; the Chromium suite exercises these controls.
- Public and private chat, public rolls, GM-only hidden rolls, server-side dice, and initiative with hidden-turn filtering.
- An isolated Chromium scenario checks a one-cell token drag at the current canvas scale and Player realtime update, plus Socket.IO offline/online reconnection and post-reconnect chat delivery.
- Russian and English UI, local development, Docker Compose, PostgreSQL migrations, and a CI workflow.

## V0.1.1 limitations

- Full layer/object editing and broader undo/redo are still open; movement-only group undo/redo is available. Single or grouped token copy/paste (up to 50 tokens) and grouped scene-object copy/paste (up to 50 objects) are available with Ctrl/Cmd+C/V. Grid calibration previews cell size and offsets before save; an isolated Playwright scenario now uploads a map and saves a calibrated grid; owner manual review remains open.
- Images accept PNG/JPEG/WebP up to 12 MB each. Ingest checks signatures and headers, applies a bounded full decode within 16,777,216 pixels, and rejects malformed pixel streams. Bounded WebP thumbnails use the same asset authorization checks. Category metadata, search, name/size sorting, previews, storage totals, and map/object/token usage counts are available; unused-only deletion is enforced. Campaign folders remain open.
- A focused multi-context Playwright suite exists; full workflow coverage and a performance measurement report remain open. No-overwrite database/media backup and manifest verification commands are implemented and passed on isolated `nri_test`; an automated schedule and production-like maintenance-window drill remain open.
- Full layer/object editing, campaign export, and production deployment are not complete. GitHub Actions runs #93 and #94 exposed the shared API process auth rate limit between smoke and browser suites. After isolating Playwright on a fresh API process, runs #95 and #96 passed on `221b17c`; runs #99 and #100 passed on code commit `92bed1d` with single-token copy/paste, including migrations, build, typecheck, unit suites, multiplayer smoke, and the two-context Chromium scenario.
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

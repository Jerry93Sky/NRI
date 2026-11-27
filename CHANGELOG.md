# Changelog

## Unreleased — RT-RETRY final fixes, SEC-OPS and PLAY-GESTURES

- Recover a committed token copy after source deletion and a scene copy after source archive. Recover a committed campaign copy before opening source files. Verify pruning concurrent with replay.
- Redact filesystem and database failure details from application logs. Add a canary test and a bounded upload profile with real image dimensions.
- Cancel interrupted canvas gestures, restore scene creation focus and refresh the authorized snapshot after history conflicts.
- Record planned Player Tabletop and NPC social relations, commercial hypotheses and the PERF-GPU/OPS follow-up.

## Unreleased — RT-RETRY Part II

- Add 90-day REST receipts and optional `Idempotency-Key` for token, object, scene and campaign create/copy, and asset upload. Store result IDs and check current access on replay.
- Show an unknown outcome on the campaign list and tabletop, and preserve the original request when scene activation or a realtime token update follows a committed write.
- Add PostgreSQL tests for concurrent replays, role changes, expiration and file rollback. Extend browser coverage for lost responses, resource snapshots, and token replay after API restart.
- Keep the batch key after a partial upload and refresh the asset list from the server. Use a receipt for the file upload stage of the scene background action.
- Record owner-approved Campaign Lobby and GM Screen requirements as `PLANNED`, separate proposed architecture, and align the brand, roadmap, product vision and audio/atlas notes. No UI or later feature implementation is included.

## Unreleased — V0.1.1 RT-RETRY (in progress)

- Add scoped, digest-bound retry IDs to public/private chat and dice; replay returns the original row/result after current authorization and does not republish an event.
- Add explicit in-memory chat/dice recovery actions and outcome-unknown copy for optimistic resource adjustment; no blind automatic retries.
- Add migration 0020 and an isolated PostgreSQL Socket.IO fault-injection scenario. Remaining create/copy/upload families are not yet covered; RT-RETRY remains `IN_PROGRESS`.
- Record approved future Campaign Doors, lobby, access-key metaphor and marketplace direction as `PLANNED`; no V0.1.1 UI or backend implementation.
- Prepare a finite SEC-OPS + PLAY-GESTURES validation package.

## Unreleased — V0.1.1 CMD-ACL (automated tests passed)

- Move token, scene, campaign, membership/invitation and asset command authorization and required audit writes into lock-compatible PostgreSQL transactions; retain existing movement and realtime publisher paths.
- Add [endpoint authorization matrix](docs/security/COMMAND_AUTHORIZATION_MATRIX.md), finite deferred RT-RETRY scope, and approved EVERDOOR brand direction (`PLANNED`).
- Add 20 dedicated PostgreSQL authorization, race, rollback, media privacy, filesystem-compensation and local profiling scenarios.
- Pass the complete Ubuntu 24.04 workflow, including all PostgreSQL regressions, Pixi preview and Playwright 9/9, on [CI run #196](https://github.com/Jerry93Sky/NRI/actions/runs/46014338206). V0.1.1 remains `IN_PROGRESS` pending manual and operational gates.

All notable project changes will be recorded here.

## Planned architecture and roadmap

- Document versioned rules packages, a minimal format for Character Studio, Homebrew, encounter automation and deterministic world simulation. Add dependency diagrams, licensing gates and release evidence from V0.1.1 through Marketplace. The active V0.1.1 implementation and acceptance scope still apply.

## Unreleased — V0.1.1

### Foundation stabilization

- Authorize transient pointers and scene settings/activation notifications against current sessions, campaign membership, roles and scene state. Draft pointers reach managers only; stale scene revisions are suppressed, and scene/control notifications now refresh authorized snapshots.
- Lock campaign join against concurrent access changes, minimize membership notification payloads, and rejoin after a delayed removal notice when the user has already been re-invited. Keep the personal removal signal deliverable after membership deletion.
- Add PostgreSQL and Socket.IO RT-ACL barriers for pointer demotion, scene-update removal, scene snapshots and role-scoped draft delivery. Measure pointer fanout at 1/4/8 senders and chat/dice ACK impact on loopback; production capacity remains unverified.

- Recheck active sessions, membership, role and scope for private chat, hidden dice, initiative and token-note packets. Authorize chat/dice writes and successful acknowledgements, and preserve participant-only history.
- Scope initiative to the active scene, commit audit and state together, and invalidate old projections on scene/visibility changes. Migration `0019_initiative_scene_scope` preserves legacy entries and stops unscoped trackers.
- Add 15 PostgreSQL private-channel regressions, Chromium role/snapshot and ownership/replay coverage, focused fanout measurements and the remaining V0.1.1 closure gates.

- Run Playwright on Ubuntu 24.04 after the Ubuntu 26.04 runner failed to fetch Chromium dependencies from the Microsoft APT repository.
- Route single Socket.IO moves and REST group moves through one PostgreSQL transaction for authorization, version checks, atomic writes and audit records. Reject positional updates to locked tokens, and authorize live movement delivery after commit.
- Add 23 PostgreSQL movement regression scenarios to CI, including lock-ordered authorization races, private conflict projections and rollback without realtime events.
- Make scene-object delete/restore and permanent own-drawing cleanup transactional. Synchronize scene, layer and object checks with competing writes and authorize lifecycle event recipients after commit.
- Add 28 PostgreSQL object lifecycle scenarios and extend Chromium coverage for versioned Undo/Redo and history isolation across workspaces.
- Authorize ordinary object and layer events after commit. Suppress stale upserts, send ID-only removals and reload current authorized snapshots on layer changes. Add a 24-event audit, 20 PostgreSQL regressions and Chromium replay checks.
- Record loopback P50/P95, payload sizes and SQL for 1–50 objects and up to eight sockets. Document the planned Dark Tavern RPG, Sound & Atmosphere and Adventure Atlas concepts.

- Split Fastify assembly, feature routes, realtime session and room management, and privacy projections into modules. Isolated frontend scene synchronization and a shared versioned history.
- Disconnect socket sessions on logout and rotation. Update room access on role changes, archive campaigns without leaving live subscriptions, and restrict owner-note delivery to the current member.
- Add versioned tabletop Undo/Redo for token movement and supported token/object edits, plus recoverable and atomic scene object lifecycle. Migration `0018_scene_object_recovery` extends existing databases.
- Fix production Pixi initialization. Reuse token display nodes and scope redraws to changed layers. Record measured profiles A, B and C.
- Add alpha HTTPS containers, controlled migration, graceful shutdown and local metrics. Verify quiesced backup/restore with Amber and add retention controls.
- Verify the playable demo on a clean local seed and add GM/Player acceptance steps. CI includes dependency, tracked-secret, operational and production renderer checks.

- Added an original three-scene “Amber Crossing: The Lantern Vault” demo seed with procedural map and portrait assets, hidden GM content, system-neutral resources, and a facilitator guide/provenance register. The seed is additive, idempotent, and refuses non-loopback or non-`nri_dev`/`nri_demo` databases.
- Added Owner/GM campaign copying with independent scene/layer/object/token/asset IDs, copied image bytes under new storage keys, preserved draft and GM content, no copied memberships/chat/live initiative, and cleared owner-specific token assignments/notes. Dedicated two-context Playwright coverage verifies copy relationships and Player denial.

- Fixed token dragging under fitted/zoomed canvases by converting pointer deltas back into scene coordinates. Isolated Chromium coverage now drags a token one grid cell and verifies the Player canvas receives the updated projection.
- Extended the isolated three-client Chromium scenario to take the Player offline and online, verify the connection recovers, and verify campaign realtime chat delivery after rejoining.
- Expanded multiplayer browser and API coverage for three-client public/private chat, public d20 results, GM-only hidden rolls, and GM-controlled initiative start/advance/stop, including hidden current-turn filtering for Players and Observers. Hidden dice results persist with an explicit visibility flag and emit only to the campaign GM room; Players cannot request them. Chat/dice socket listeners bind before campaign room joins, persisted history merges with realtime arrivals, and campaign-scoped payloads plus stale-request guards keep data isolated when switching campaigns. Playwright checks the cleared chat/dice state in a second campaign after late old history arrives. Raised the signup limiter only in test mode so all browser scenarios can share one isolated API process.
- Added per-scene grid, map size, distance, and camera settings with optimistic versions and a migration that preserves existing scenes.
- Added active player scenes and GM-only drafts, scene duplicate/archive/restore/reorder flows, and server filtering for player scene and token snapshots.
- Added regression coverage for scene privacy, stale edits, activation, fallback, and recovery to the multiplayer smoke runner.
- Added non-empty Vitest suites for server scene access policy and web camera zoom math; removed `--passWithNoTests` from all package test scripts.
- Lazy-loaded the Pixi tabletop; current measured web entry and canvas chunks are documented in the V0.1.1 acceptance report.
- Localized scene preparation actions, settings, camera controls, and canvas hints in Russian and English.
- Added map-based grid calibration with two-point measurement, cell-count sizing, and unsaved cell-size/offset preview; mapped Playwright coverage now passes; owner manual calibration review remains pending.
- Added a temporary multi-segment ruler using scene grid scale and units; measurements are not persisted as scene objects. Added R/F/Escape shortcuts for ruler, fit-to-scene, and clearing active canvas tools; shortcuts ignore text and form inputs.
- Added GM drag-box token selection using map-space token bounds; S activates selection, and Escape clears the temporary tool state.
- Added four scene layers, versioned layer/object APIs, scene duplication with independent layer/object IDs, and player-safe projections for GM-only content.
- Added a basic layer panel with active-layer selection/order, visibility/lock controls, rectangle/ellipse creation, active-layer canvas dragging/resizing, object visibility/lock, rotation, opacity, z-order, same-scene layer move, duplicate and delete actions; shapes render on the canvas.
- Added Pixi asset-texture tracking and release for assets no longer used in the current scene. A focused Chromium scenario confirms an image-backed token is fetched again after leaving and returning to its scene; load, FPS, memory, and hardware texture-limit measurements remain open.
- Added campaign-library image insertion as editable scene objects and lazy Pixi texture rendering through the existing campaign-scoped asset endpoint. Browser acceptance of this flow remains pending.
- Added localized creation and editing of text scene objects with Pixi text rendering; browser acceptance remains pending.
- Added selectable layer-list scene objects and single-object in-app copy/paste with Ctrl/Cmd+C and Ctrl/Cmd+V. Pasting creates a new versioned object on the active editable layer and reuses campaign asset references.
- Added Shift/Ctrl/Cmd multi-selection and atomic copy/paste for up to 50 scene objects. The server validates every source version, creates independent objects in one transaction, and preserves hidden-object visibility; stale sources return a conflict without partial copies.
- Fixed invitation acceptance by only setting JSON content type when a request has a body. Added a two-context Playwright privacy scenario and made it part of CI; broad browser workflow coverage remains open.
- Added GM single- and multi-token copy/paste. The server validates campaign membership, all source versions, and the same-campaign destination before atomically creating up to 50 new IDs; copies clear owner assignment/private owner notes. Stale group copies create no partial tokens.
- Extended the two-context Playwright privacy scenario to verify a copied hidden GM object stays hidden when placed on the player-visible Objects layer.
- Added bounded full decoding for uploaded PNG/JPEG/WebP assets and rejects truncated pixel streams; unit and isolated API smoke coverage exercise the decoder.
- Updated the CI checkout and Node setup actions to Node 24-compatible releases; disabled setup-node's implicit package-manager cache.
- Added an ephemeral shared pointer with server-checked campaign membership, active-scene/draft privacy, scene-bound validation, and per-socket rate limiting; the browser suite verifies delivery to the Player context.
- Remediated moderate i18next GHSA-6jcc-5g8w-32mx and esbuild GHSA-67mh-4wv8-2f99 advisories; full and production dependency audits are clean. Targeted review evidence and remaining review scope are recorded in `docs/security/V0.1.1_REVIEW.md`.
- Added a localized line-object action. Lines are stored as editable scene objects with point geometry and are covered by the multiplayer API smoke.
- Added a GM freehand mode with live stroke preview and persisted point geometry on the selected unlocked layer.
- Added a mapped-calibration Chromium flow that uploads a map, measures two canvas points, previews cell size, and saves grid settings. Owner manual review remains pending.
- Added GM-controlled Player freehand drawing on active scenes, with private authorship, versioned own-stroke edit/delete rules, and API/Playwright permission coverage.
- Added an own-drawing clear action for Players; it deletes only their freehand objects in a database transaction and remains available after drawing permission is revoked.
- Added persisted right-rail resize/collapse controls, a browser fullscreen toggle, and a locally persisted light/dark theme switch for the tabletop workspace.
- Tightened tabletop spacing on short desktop viewports and added Chromium layout checks plus screenshots at 1366×768, 1920×1080, and 2560×1440. Campaign asset texture URLs explicitly select Pixi's texture parser.
- Socket token-move conflicts now return the latest privacy-filtered token state. Multiplayer smoke and a two-browser Chromium flow race authorized moves from the same version, confirm only one commit, and compare the losing acknowledgement and Player realtime event with the winning state. A separate two-browser Chromium scenario restarts the isolated API and verifies GM/Player sessions reconnect and read persisted scene-token state.
- A three-context Chromium scenario removes a Player with two active sessions, checks that both sockets receive the user-scoped removal notice and stop receiving campaign chat, and confirms further Player socket writes are denied.
- Added localized drawing color and stroke-width controls plus per-object color editing.
- Added versioned GM token properties for name, fill/frame, cell dimensions, rotation, opacity, display order, lock and name visibility; hidden token transitions emit only a safe removal or player-visible creation.
- Added two generic versioned token resource tracks with label/current/maximum/player-visibility settings, owner-only player adjustments, bounded server updates, and private realtime projections for hidden tracks.
- Added separate GM and token-owner notes with REST projections and owner-scoped realtime updates.
- Added recoverable token deletion with a role-scoped trash view and restore, plus all-or-none GM group updates for up to 50 tokens with optimistic version checks.
- Added atomic group dragging for selected editable tokens; coordinate changes share the same version-checked transaction as group property changes. Added a 20-step movement-only undo/redo that rejects stale versions.
- Documented the no-overwrite database/media backup procedure and passed an isolated PostgreSQL/media restore drill for `nri_test`.
- Added no-overwrite `db:backup` and `db:backup:verify` commands for a PostgreSQL custom dump plus media, manifest checksums, complete-inventory verification, and a loopback Docker Compose fallback. Isolated create/verify passed on `nri_test` (212 files); maintenance-window restore and scheduling remain open.
- Added a GM-only categorized campaign image library with button and drag-and-drop multi-file uploads, bounded 320×240 WebP thumbnails, search, name/size sorting, metadata editing, campaign folders, storage totals and map/object/token reference counts. Folder filtering, asset assignment, folder CRUD, and campaign-copy folder ID remapping have isolated API and Chromium coverage. Thumbnail reads inherit original asset authorization; unused-only deletion checks references transactionally and removes derived previews. Token images render on the tabletop and are served to players only for visible tokens in the active scene; GM users can also drag a TOKEN-category card from the asset library onto the tabletop to create a linked token. Uploads use signature, dimension, and bounded full-decode checks. Unit, isolated smoke, and Playwright coverage verify thumbnail generation, ACL filtering, and dropped PNG preview.
- Restricted layer creation to custom layers and changed object-to-layer deletion behavior so a non-empty layer cannot cascade-delete its objects.
- V0.1.1 is still in progress. Typography controls, owner manual calibration/ruler review, broader undo, additional Playwright flows, broader security review, quiesced maintenance-window backup/restore and scheduled retention, performance testing, and demo acceptance remain open. The shared pointer has browser event-delivery coverage but still needs visual acceptance.

## Unreleased — V0.1 foundation

- Initialized the repository and V0.1 work branch.
- Added the pnpm workspace, React/PixiJS client, Fastify/Socket.IO server, shared contracts, PostgreSQL schema/migrations, Docker Compose, and CI workflow.
- Implemented account sessions, campaign membership/invitations, scenes/maps, tokens, chat, dice, initiative, reconnect, and RU/EN interface flows.
- Added a multi-client integration smoke runner and documented its passing local result; 8 shared-contract unit tests also pass.
- Fixed local Socket.IO origin validation for both `localhost` and `127.0.0.1`.
- Updated local setup and README status; published the branch and opened draft PR #1. GitHub Actions passed. V0.1 remains in progress pending owner acceptance, backup restore, browser automation, full security review, and performance measurements.

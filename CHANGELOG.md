# Changelog

All notable project changes will be recorded here.

## Unreleased — V0.1.1

- Expanded multiplayer browser and API coverage for three-client public/private chat, public d20 results, GM-only hidden rolls, and GM-controlled initiative start/advance/stop. Hidden results are stored with an explicit visibility flag and emitted only to the campaign GM room; Players cannot request them. Chat/dice socket listeners bind before campaign room joins, persisted history merges with realtime arrivals, and campaign-scoped payloads plus stale-request guards keep data isolated when switching campaigns. Playwright checks the cleared chat/dice state in a second campaign. Raised the signup limiter only in test mode so all browser scenarios can share one isolated API process.
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
- Socket token-move conflicts now return the latest privacy-filtered token state. Multiplayer smoke races two authorized moves and checks the conflict acknowledgement against the winning move and snapshot.
- Added localized drawing color and stroke-width controls plus per-object color editing.
- Added versioned GM token properties for name, fill/frame, cell dimensions, rotation, opacity, display order, lock and name visibility; hidden token transitions emit only a safe removal or player-visible creation.
- Added two generic versioned token resource tracks with label/current/maximum/player-visibility settings, owner-only player adjustments, bounded server updates, and private realtime projections for hidden tracks.
- Added separate GM and token-owner notes with REST projections and owner-scoped realtime updates.
- Added recoverable token deletion with a role-scoped trash view and restore, plus all-or-none GM group updates for up to 50 tokens with optimistic version checks.
- Added atomic group dragging for selected editable tokens; coordinate changes share the same version-checked transaction as group property changes. Added a 20-step movement-only undo/redo that rejects stale versions.
- Documented the no-overwrite database/media backup procedure and passed an isolated PostgreSQL/media restore drill for `nri_test`.
- Added a GM-only categorized campaign image library with button and drag-and-drop multi-file uploads, bounded 320×240 WebP thumbnails, search, name/size sorting, metadata editing, storage totals and map/object/token reference counts. Thumbnail reads inherit original asset authorization; unused-only deletion checks references transactionally and removes derived previews. Token images render on the tabletop and are served to players only for visible tokens in the active scene; GM users can also drag a TOKEN-category card from the asset library onto the tabletop to create a linked token. Uploads use signature, dimension, and bounded full-decode checks; campaign folders remain open. Unit, isolated smoke, and Playwright coverage verify thumbnail generation, ACL filtering, and dropped PNG preview.
- Restricted layer creation to custom layers and changed object-to-layer deletion behavior so a non-empty layer cannot cascade-delete its objects.
- V0.1.1 is still in progress. Typography controls, owner manual calibration/ruler review, broader undo, asset folders, additional Playwright flows, broader security review, automated/quiesced backup validation, performance testing, and demo expansion remain open. The shared pointer has server smoke coverage but still needs browser acceptance.

## Unreleased — V0.1 foundation

- Initialized the repository and V0.1 work branch.
- Added the pnpm workspace, React/PixiJS client, Fastify/Socket.IO server, shared contracts, PostgreSQL schema/migrations, Docker Compose, and CI workflow.
- Implemented account sessions, campaign membership/invitations, scenes/maps, tokens, chat, dice, initiative, reconnect, and RU/EN interface flows.
- Added a multi-client integration smoke runner and documented its passing local result; 8 shared-contract unit tests also pass.
- Fixed local Socket.IO origin validation for both `localhost` and `127.0.0.1`.
- Updated local setup and README status; published the branch and opened draft PR #1. GitHub Actions passed. V0.1 remains in progress pending owner acceptance, backup restore, browser automation, full security review, and performance measurements.

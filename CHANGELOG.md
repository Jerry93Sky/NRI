# Changelog

All notable project changes will be recorded here.

## Unreleased — V0.1.1

- Added per-scene grid, map size, distance, and camera settings with optimistic versions and a migration that preserves existing scenes.
- Added active player scenes and GM-only drafts, scene duplicate/archive/restore/reorder flows, and server filtering for player scene and token snapshots.
- Added regression coverage for scene privacy, stale edits, activation, fallback, and recovery to the multiplayer smoke runner.
- Added non-empty Vitest suites for server scene access policy and web camera zoom math; removed `--passWithNoTests` from server and web scripts.
- Lazy-loaded the Pixi tabletop; current measured web entry and canvas chunks are documented in the V0.1.1 acceptance report.
- Localized scene preparation actions, settings, camera controls, and canvas hints in Russian and English.
- V0.1.1 is still in progress. Layers, calibration, richer tokens, asset library, other tabletop tools, Playwright, security review, backup/restore, performance testing, and demo expansion remain open.

## Unreleased — V0.1 foundation

- Initialized the repository and V0.1 work branch.
- Added the pnpm workspace, React/PixiJS client, Fastify/Socket.IO server, shared contracts, PostgreSQL schema/migrations, Docker Compose, and CI workflow.
- Implemented account sessions, campaign membership/invitations, scenes/maps, tokens, chat, dice, initiative, reconnect, and RU/EN interface flows.
- Added a multi-client integration smoke runner and documented its passing local result; 8 shared-contract unit tests also pass.
- Fixed local Socket.IO origin validation for both `localhost` and `127.0.0.1`.
- Updated local setup and README status; published the branch and opened draft PR #1. GitHub Actions passed. V0.1 remains in progress pending owner acceptance, backup restore, browser automation, full security review, and performance measurements.

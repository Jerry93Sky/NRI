# NRI Platform

NRI Platform is a system-neutral virtual tabletop. Game masters manage campaigns, scenes, tokens and player access. The long-term goal is a platform for creating custom rules, automating play and simulating worlds.

**EVERDOOR** is the approved product name and **Every door, a new adventure** the tagline; NRI Platform remains the temporary technical project name. The brand direction and user journey are `PLANNED` in the [EVERDOOR brand vision](docs/design/EVERDOOR_BRAND_VISION.md); the current interface is unchanged.

## Status

**V0.1.1 — IN_PROGRESS.** See the [V0.1.1 report](docs/releases/V0.1.1_ACCEPTANCE_REPORT.md) for the stabilization checkpoint. Work continues in [Draft PR #1](https://github.com/Jerry93Sky/NRI/pull/1).

## Implemented

- Campaign roles, invitations, active scenes and GM drafts. PostgreSQL and Socket.IO back multiplayer commands.
- Grid calibration, images, tokens and private notes, layers and objects, grouped actions, drawing, ruler, pointer and selection. Version-aware Undo/Redo covers movement, supported properties and the object lifecycle.
- Single movement and group token updates share a PostgreSQL transaction for authorization, version checks and atomic writes. Movement events are published after commit.
- Scene object deletion and restoration are atomic and check current permissions, layers and versions. Restore preserves object IDs, and delivery checks current recipient access.
- Object creation, editing and movement between layers, and layer changes use current delivery permissions. The client refreshes its authorized snapshot when content is hidden or removed. [Event inventory](docs/security/REALTIME_EVENT_MATRIX.md)
- Pointer and active-scene metadata use current audience and version checks. Control notifications reconcile roles, scenes and drawing permission from authorized snapshots. RT-ACL is automatically verified; remaining writer authorization work is listed in the [closure plan](docs/releases/V0.1.1_CLOSURE_PLAN.md#следующий-конечный-пакет-cmd-acl).
- Public/private chat, public and hidden rolls, initiative, reconnect and API restart recovery. Chat/dice support scoped retry IDs to recover results after a lost ACK; create/copy of scenes, tokens, objects and campaigns, and file uploads are not covered yet. RT-RETRY remains `IN_PROGRESS`. [Retry policy](docs/architecture/COMMAND_RETRY_POLICY.md) · [V0.1.1 closure plan](docs/releases/V0.1.1_CLOSURE_PLAN.md)
- **Amber Crossing: The Lantern Vault** with original assets, campaign copy and the [owner acceptance guide](docs/releases/V0.1.1_MANUAL_ACCEPTANCE.md).
- Isolated verification of the [HTTPS alpha stack](docs/operations/PRODUCTION_DEPLOYMENT.md), [SHA-256 backup/restore and retention](docs/operations/BACKUP_RESTORE.md), and [load profiles A/B/C](docs/performance/LOAD_TEST_REPORT.md).

## V0.1.1 limitations

- A complete human session and owner acceptance are pending. CMD-ACL is checking the remaining transactional commands in the [authorization matrix](docs/security/COMMAND_AUTHORIZATION_MATRIX.md); lost acknowledgement handling remains a separate task.
- Large scenes remain slow in the software renderer. Hardware runs, long-duration memory checks and detailed profiling remain open.
- The [V0.2 Tactical Tabletop implementation plan](docs/releases/V0.2_IMPLEMENTATION_PLAN.md) describes work after the current release gates.

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

The [V0.1 report](docs/releases/V0.1_ACCEPTANCE_REPORT.md) documents the multiplayer integration test. The [V0.1.1 report](docs/releases/V0.1.1_ACCEPTANCE_REPORT.md#transactional-token-movement--2026-11-27) covers concurrent movement tests. Do not publish `.env`, user data, or uploaded maps.

## Documentation and roadmap

- [Product vision](docs/product/PRODUCT_VISION.md) · [Roadmap](docs/product/ROADMAP.md) · [V0.1 scope](docs/product/V0_1_SCOPE.md)
- [Long-term plan and release gates](docs/product/LONG_TERM_IMPLEMENTATION_PLAN.md) · [Ruleset licensing strategy](docs/product/RULESET_LICENSING_STRATEGY.md)
- [Architecture](docs/architecture/ARCHITECTURE.md) · [Data model](docs/architecture/DATA_MODEL.md) · [Realtime protocol](docs/architecture/REALTIME_PROTOCOL.md)
- [Backup and restore procedure](docs/operations/BACKUP_RESTORE.md)
- [Threat model](docs/security/THREAT_MODEL.md) · [Commercial strategy](docs/product/COMMERCIAL_STRATEGY.md)
- [Changelog](CHANGELOG.md) · [Third-party notices](THIRD_PARTY_NOTICES.md)

V0.1.1 is the active phase; V0.2 Tactical Tabletop starts after its acceptance. No project-wide source license has been selected; all rights remain with their owners.

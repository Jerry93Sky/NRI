# V0.1 scope

- **Release:** Foundation & Multiplayer Virtual Tabletop
- **Status:** IN_PROGRESS — core flows are implemented and local automated checks pass; acceptance gates remain open. See [V0.1 acceptance report](../releases/V0.1_ACCEPTANCE_REPORT.md).

## In scope

- TypeScript monorepo, local development, containerized infrastructure, migrations, health/readiness, structured logs, CI, and documented operations.
- Account registration, login/logout, server sessions, rate limits, campaign roles (Owner, GM, Player), campaign creation/listing/archive/restore, expiring/revocable invitations, membership administration.
- Multi-scene tabletop; image map upload; fixed-size visible grid; token placement and movement; server-validated ownership and permissions; per-client camera state.
- Chat (public and GM-private), server-side dice parsing and randomness, initiative tracker, reconnect snapshots and persisted state.
- Russian and English UI; in-product starter guidance and an original demo campaign.
- Unit and multi-client integration checks. Browser automation, complete security review, backup restore drill, and measured performance report remain release gates.

## Release validation gates

- Install, build, startup, migration, and seed follow documented commands without editing source.
- Independent clients complete the multi-user session flow. Unauthorized token movement and secret-data requests are rejected without disclosure.
- State survives refresh, disconnect/reconnect, and server restart; concurrent edits produce explicit conflict outcomes.
- PostgreSQL and local media backup can be restored to an isolated environment.
- Scene configuration, including grid settings, is available through documented user flows.
- Russian and English interfaces work; no critical open defects; a human owner performs manual acceptance.
- Counts for passed, failed, skipped, blocked tests and performance measurements are recorded from actual runs.

## Out of scope

Advanced walls, lighting, and fog of war; map editor; voice/video; AI generation; living-world simulation; full D&D automation; character sheet designer; Marketplace; payments; native mobile apps; 3D tabletop.

## Operational constraints

Development and production configuration must be distinct. PostgreSQL must not be exposed publicly by default. Production secrets are supplied by operators. No fabricated credentials, commercial content, or acceptance claims. Preserve owner data and avoid rewriting existing work.

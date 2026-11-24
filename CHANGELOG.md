# Changelog

All notable project changes will be recorded here.

## Unreleased — V0.1 foundation

- Initialized the repository and V0.1 work branch.
- Added the pnpm workspace, React/PixiJS client, Fastify/Socket.IO server, shared contracts, PostgreSQL schema/migrations, Docker Compose, and CI workflow.
- Implemented account sessions, campaign membership/invitations, scenes/maps, tokens, chat, dice, initiative, reconnect, and RU/EN interface flows.
- Added a multi-client integration smoke runner and documented its passing local result; 8 shared-contract unit tests also pass.
- Fixed local Socket.IO origin validation for both `localhost` and `127.0.0.1`.
- Updated local setup and README status. V0.1 remains in progress pending owner acceptance, backup restore, browser automation, full security review, performance measurements, and remote CI/publication.

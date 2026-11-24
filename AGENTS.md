# NRI Platform contributor rules

## Product principles

- Keep the core system independent of any one tabletop RPG ruleset.
- Prefer a simple first-run path and a modular monolith over premature microservices.
- Treat the server as the authority for identity, permissions, dice, and persistent campaign state.
- Do not send secret GM information to clients without permission. Enforce this at APIs, realtime events, and file access, not only in the UI.
- Preserve campaign data across refreshes, reconnects, restarts, and concurrent edits.
- The core product must work without AI services.
- Use original, procedural, or appropriately licensed assets. Track third-party licenses. Do not select a project-wide source license without the owner's decision.
- Do not implement billing or subscriptions in V0.1.

## Engineering rules

- Use strict TypeScript and shared validated contracts at trust boundaries.
- Validate environment configuration at startup; never commit secrets or use production-default credentials.
- Check campaign membership and role on every protected server operation. A campaign role is scoped to that campaign.
- Use transactions for critical multi-record operations and optimistic versions for mutable tabletop objects.
- Keep modules cohesive and avoid duplicated domain rules between REST and realtime entry points.
- Add migrations for schema changes and document operational requirements.
- Keep development configuration explicitly separate from production configuration.
- Document actual implementation and verification status. Never claim tests, security checks, performance, backup restores, or manual acceptance that were not performed.
- Do not add tests or run test suites unless the task asks for tests or verification.
- Do not merge to `main`, force-push, change repository visibility, or publish secrets.

## Scope discipline

V0.1 covers the project foundation and multiplayer tabletop described in `docs/product/V0_1_SCOPE.md`. Later roadmap items are documentation only until their release is explicitly in scope. Do not create placeholder modules or represent stubs as implemented features.

## Change workflow

- Work on `codex/v0-1-foundation-vtt` for V0.1.
- Use focused commits with conventional prefixes where practical.
- Update `README.md`, `README.en.md`, `CHANGELOG.md`, and relevant canonical docs after substantial changes.
- Keep Russian and English project summaries aligned.
- Mark statuses as `PLANNED`, `IN_PROGRESS`, `IMPLEMENTED`, `AUTOMATED_TESTS_PASSED`, `MANUAL_ACCEPTANCE_PENDING`, `ACCEPTED`, or `BLOCKED` only when evidence supports them.

# Product roadmap

Statuses describe plans, not current implementation. V0.1.1 is the active release scope; V0.1 remains unmerged and pending acceptance.

| Version | Focus | Dependencies | Exit criteria | Constraints / architecture |
|---|---|---|---|---|
| V0.1 | Foundation & Multiplayer Virtual Tabletop | None | Durable campaigns, auth and scoped roles, scenes, maps, tokens, chat, dice, initiative, reconnect, bilingual UI; automated and manual acceptance recorded | System-neutral modular monolith; server-authoritative; no billing, advanced lighting, or rules automation |
| V0.1.1 | Tabletop Foundation Completion & Playability | Existing V0.1 branch | Scene lifecycle/privacy, layers/objects, grid calibration, expanded tokens, asset library, tabletop tools, reliability/security checks, Playwright, backup/restore, measured performance, playable demo; owner acceptance recorded. Current work adds image-backed token assets, deletion recovery, atomic group move/property controls, version-checked group-move undo/redo, a temporary scene-unit ruler, and canvas shortcuts; an isolated `nri_test` restore drill has also passed; remaining gaps are tracked in the acceptance report | Continue the existing branch and PR; do not claim incomplete V0.1 foundations as accepted |
| V0.2 | Tactical Tabletop | V0.1 scene, object, and realtime contracts | Walls and doors; visibility and lighting tested for permissions and performance | Visibility is server-filtered; keep renderer independent from persistence |
| V0.3 | Character Studio | Stable identity, campaign membership, asset and permission model | Configurable character sheets and ownership in campaigns | Schema-defined fields; no single game system baked into core |
| V0.4 | Universal Rules Engine | Character Studio; versioned rule packages | Authors can define and safely execute checks and mechanics without arbitrary server code | Sandboxed declarative rules, versioning, migrations, deterministic evaluation |
| V0.5 | Campaign Studio | Characters and rules package interfaces | Campaign planning, notes, timelines, and GM organization with secret-aware sharing | Reuse campaign access controls and secret projections |
| V0.6 | Living World Engine | Campaign Studio; time, faction, and entity schemas | Deterministic simulation can be previewed, approved, edited, and reverted by the GM | Separate bounded simulation module; no direct dependency on London; AI not required |
| V0.7 | Map Studio | Asset and scene format stability | Create and edit maps with import/export and versioned assets | Preserve standalone map import/export; avoid coupling map editing to a game system |
| V0.8 | Community Alpha | Account, moderation, sharing, and consent foundations | Invite/search/community workflows pass privacy and moderation review | Minimize public profile data; opt-in discovery |
| V0.9 | Commercial Beta | Operational readiness, support, licensing, and pricing research | Beta support, observability, backup, restore, security review, and billing design complete | No price assumptions in core code; validate service costs and user demand |
| V1.0 | Commercial Release | Beta exit criteria | Reliability, accessibility, security, legal, support, and product acceptance signed off | Owner approves code license and commercial terms |
| V1.1+ | Marketplace & Ecosystem | V1.0 trust, licensing, payments, moderation | Creator publishing, purchase, entitlement, and takedown paths accepted | Rights provenance and content safety are required |

Release exit criteria do not mean a feature is complete until evidence is documented. Dependencies are architectural gates, not promises of delivery dates. Prices, if any, remain hypotheses and configurable.

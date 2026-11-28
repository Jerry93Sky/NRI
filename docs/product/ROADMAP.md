# Product roadmap

**V0.1.1 and V0.2 — IN_PROGRESS.** The owner authorized V0.2 development on the working branch during the remaining V0.1.1 manual checks. The [V0.1.1 scope](../releases/V0.1.1_SCOPE.md) and [acceptance gates](../releases/V0.1.1_ACCEPTANCE_REPORT.md) still govern release. V0.1 is the preceding foundation. Entries after V0.2 are `PLANNED`. [Long-term implementation plan](LONG_TERM_IMPLEMENTATION_PLAN.md)

The planned product designs cover [Inventory & Equipment](../design/INVENTORY_EQUIPMENT.md), [Trading](../design/TRADING.md), [Loot](../design/LOOT.md), [Master Studio](../design/MASTER_STUDIO.md) and [Adventure Builder](../design/ADVENTURE_BUILDER.md). Campaign preparation starts with the tools the GM chooses to use. The release table governs technical delivery.

| Release | Goal | Required predecessors | Exit evidence |
| --- | --- | --- | --- |
| V0.1 | Foundation and multiplayer VTT | — | [Original scope and validation](V0_1_SCOPE.md) |
| V0.1.1 | Stabilize playable tabletop | Existing V0.1 branch | Current acceptance report and owner session under existing gates |
| V0.2 | Tactical Tabletop | V0.1.1 gates | Versioned geometry, movement validation, per-player LOS/fog and visual lighting. [Scope](../releases/V0.2_SCOPE.md) · [PR 1 result](../releases/V0.2_PR_01_RESULT.md) · [PR 2 result](../releases/V0.2_PR_02_RESULT.md) |
| V0.3 | [Character Studio](../design/CHARACTER_STUDIO.md) and minimal rules contract | V0.2 release, campaign identity and package subset | Two original built-in fixtures with dissimilar sheets and mechanics, stable pins and field-level privacy |
| V0.4 | Universal Rules Engine | V0.3 format subset and entity snapshots | Broader safe interpreter and dice families, deterministic replay and verified resource limits |
| V0.4.1 | Ruleset Library | V0.4 and licensing gates | Validated import/export, version registry, permissions and approved migration/restore |
| V0.4.2 | Homebrew Studio | V0.4.1 | Visual authoring, dependency-aware overrides, draft tests and explicit publish/upgrade |
| V0.4.3 | Combat Automation | V0.2 tactical queries, V0.4 Rules, V0.3 Character | Atomic actions, reaction/turn variants, adjustable automation and guarded undo |
| V0.5 | Campaign Studio | Campaign Core and V0.3 character links | Planning, snapshots, encounters, notes and secret-aware timelines |
| V0.5.1 | Tactical AI | V0.2 perception, V0.4.3 action API and V0.5 encounter workflows | Reproducible proposed actions, perception limits, visual profiles and immediate GM takeover |
| V0.6 | World Simulation Core | V0.5 campaign/time workflow and bounded evaluator subset | Optional World Instance, game-time stepping, preview/apply, repeatability and checkpoints |
| V0.6.1 | NPC Simulation | V0.6 | Individual and aggregate updates with scoped knowledge, memories, goals and relationships |
| V0.6.2 | Political Simulation | V0.6 and V0.6.1 social inputs | Configurable institutions, succession and diplomacy with deterministic conflict resolution |
| V0.6.3 | Economic Simulation | V0.6 and optional political inputs | Reconciled stock/flow ledger with abstract and detailed modes |
| V0.6.4 | World Rules Studio | V0.6 and representative V0.6.1–V0.6.3 laws | Visual authoring and testing of bounded, versioned event rules |
| V0.6.5 | Narrative Engine | V0.6 causal records and V0.6.4 policies | Reviewable hooks with lineage, audience scoping and controlled publication |
| V0.7 | Map Studio | V0.2 geometry and stable asset references | Map round-trips, permission-aware variants, versioned scene import |
| V0.8 | Community Hub | Account, sharing, moderation and rights review | Opt-in discovery, reporting, removal and privacy acceptance |
| V0.9 | Commercial Beta | Implemented beta scope, operations and commercial rights | Measured capacity, restore drills, support workflows, privacy and security reviews |
| V1.0 | Commercial Release | V0.9 exit and owner sign-off | Reliability, accessibility, legal and support gates meet agreed targets |
| V1.1+ | Marketplace and ecosystem | V1.0 and separate commerce/provenance approval | Catalog, publication, entitlements and takedown tested end to end |

V0.3 introduces a small built-in package format and the evaluation contract needed for schema-derived sheets. V0.4 extends that contract, V0.4.1 opens the registry to approved imports, and V0.4.2 adds visual authoring. Map Studio follows a later product release even though V0.2 must define reusable geometry. The World Core runs with reference laws before the World Rules Studio UI exists. Political and economic models remain separately optional at runtime.

## Proposed placement of product concepts

### EVERDOOR brand and experience

**PLANNED; no V0.1.1 implementation.** EVERDOOR is the approved product name and Hearth the working name for its warm, genre-neutral base theme. The planned journey is Landing → Campaign Doors → Campaign Lobby → Adventure. The owner-approved Campaign Doors direction is a responsive illustrated grid, campaign-specific appearance, a lobby transition, and server-authorized access represented visually by future keys. Public adventure discovery and a GM marketplace are late-stage ideas requiring separate financial, moderation, and legal design. See [Brand Vision](../design/EVERDOOR_BRAND_VISION.md) and [Campaign Doors](../design/CAMPAIGN_DOORS.md). Do not add these features, subscriptions, or payments in V0.1.1.

| Concept | Proposed placement |
| --- | --- |
| [Dark Tavern RPG](../design/DARK_TAVERN_DESIGN_VISION.md) | Owner-reviewed visual milestone after V0.1.1, coordinated with V0.2 without changing its tactical gates |
| [Campaign Lobby](../design/CAMPAIGN_LOBBY.md) | Owner-approved product direction; sequencing and release scope remain to be agreed. Lobby and scene audio share one planned multitrack concept |
| [GM Screen](../design/GM_SCREEN.md) | Owner-approved requirements recorded as `PLANNED`; module boundaries and sequencing remain design proposals |
| [Master Studio](../design/MASTER_STUDIO.md) and [Adventure Builder](../design/ADVENTURE_BUILDER.md) | Planned preparation concepts for Campaign Studio and later simulation stages. Minimum authoring flows, wider collaboration and linked campaigns require scope decisions within the established release gates |
| [Sound & Atmosphere](../architecture/SCENE_AUDIO.md) | Optional Campaign Studio follow-up after scene privacy. Spatial and reactive audio follow geometry and rule/simulation integration |
| [Adventure Atlas](../architecture/ADVENTURE_ATLAS.md) | Linked maps and discovery after V0.2 and V0.5. Map authoring stays with V0.7, and split-party exploration needs a later location model |

The table above records concepts without setting their relative release order. [Player Tabletop](../design/PLAYER_TABLETOP.md) and [Social Relations](../architecture/SOCIAL_RELATIONS.md) are planned directions outside V0.1.1. The Adventure Chronicle's structured drafting and review flow is a proposal. It can operate without generative AI and must preserve audience privacy. The [commercial draft](COMMERCIAL_STRATEGY_DRAFT.md) contains hypotheses for owner validation.

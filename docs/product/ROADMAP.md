# Product roadmap

**Active release: V0.1.1 — IN_PROGRESS.** Continue the existing [stabilization scope](../releases/V0.1.1_SCOPE.md) and its [acceptance gates](../releases/V0.1.1_ACCEPTANCE_REPORT.md). V0.1 is the preceding foundation on the same development line. All later entries are `PLANNED`. Dependencies describe release gates and include no delivery dates. Detailed exit evidence is defined in the [long-term implementation plan](LONG_TERM_IMPLEMENTATION_PLAN.md).

| Release | Goal | Required predecessors | Exit evidence |
| --- | --- | --- | --- |
| V0.1 | Foundation and multiplayer VTT | — | [Original scope and validation](V0_1_SCOPE.md) |
| V0.1.1 | Stabilize playable tabletop | Existing V0.1 branch | Current acceptance report and owner session under existing gates |
| V0.2 | Tactical Tabletop | V0.1.1 gates | Versioned geometry, movement validation, per-player LOS/fog and lighting. [Existing scope](../releases/V0.2_SCOPE.md) |
| V0.3 | Character Studio and minimal rules contract | V0.2 release; campaign identity and package subset | Two original built-in fixtures with dissimilar sheets and mechanics, stable pins and field-level privacy |
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

# Product vision

## Purpose

NRI Platform is a system-neutral platform for creating, automating and running tabletop role-playing games. A GM can start at a virtual table, then add custom rules, character sheets, encounters, campaign tools and an evolving world at the depth their group wants. Commercial distribution and international use are product goals.

## Product principles

1. **Easy first session:** a GM should be able to create a campaign, add a map, place tokens, and invite players without extensive setup.
2. **System neutral.** A campaign selects its rules. Levels, classes, hit points, initiative and d20 rolls are optional mechanics.
3. **Modular monolith first:** cohesive modules and stable boundaries, without premature microservices.
4. **Server authority:** the server determines membership, permissions, dice results, and persisted state.
5. **Confidentiality by construction:** secret GM content is excluded from unauthorized API responses, realtime messages, downloads, logs, and exports.
6. **Durability:** refreshes, restarts, reconnects, retries, and concurrent changes must not silently lose campaign state.
7. **AI independent.** Core play, tactical agents and world outcomes use software rules. Optional generated prose may describe approved facts for a permitted audience.
8. **Commercially adaptable:** future tiers, storage limits, self-hosting, localization, import/export, and creator distribution must fit without embedding prices into core logic.
9. **Rights aware:** no unlicensed books, game text, maps, or art. No project-wide code license until the owner decides.

## Product directions

| Capability | Player, GM or creator outcome |
| --- | --- |
| Virtual and Tactical Tabletop | Play with maps, tokens and shared tools. Later add movement constraints, per-player visibility, lighting and fog |
| Character Studio | Create characters, NPCs and creatures from package-defined sheets. Inspect derived values and control access to private fields |
| Universal Rules Engine, Ruleset Library and Homebrew Studio | Install a permitted version, build or extend a ruleset visually, test it and opt in to campaign upgrades |
| Combat Automation and Tactical AI | Choose the degree of rules assistance. Let approved NPC profiles propose or execute allowed game actions and return control to the GM |
| Campaign Studio | Prepare sessions, scenes, encounters and notes, and keep an audience-scoped timeline |
| Living World Engine | Advance a world by chosen game-time steps. Optional NPC, political and economic rules generate reviewable consequences and story hooks |
| Map Studio | Author reusable maps and geometry independently of a ruleset, with explicit import and export |
| Community Hub and Marketplace | Discover and share authorized material. Later support creator distribution and commerce with consent, moderation, provenance and entitlements |

V0.1.1 is the active stabilization release. The [acceptance report](../releases/V0.1.1_ACCEPTANCE_REPORT.md) describes working features and open checks. Future capabilities follow the [roadmap](ROADMAP.md) and [implementation gates](LONG_TERM_IMPLEMENTATION_PLAN.md).

## Campaign and world choices

Character rules and world laws have separate versioned configurations. A campaign can run a rules-neutral tabletop, use only character rules, or attach a World Instance with its own calendar and selected subsystems. Fantasy, science fiction, historical, modern and custom settings choose their own concepts and depth, including worlds without magic, states or monetary economies.

The GM controls advancement and automation. A simulation step proposes a result from saved state, configured laws and recorded randomness. The GM can preview and approve, edit, defer or reject proposals under campaign policy. Secrets stay within their audiences. Any conceptual borrowing from the earlier London work creates no runtime dependency.

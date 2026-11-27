# Long-term implementation plan

V0.1.1 remains `IN_PROGRESS`. The contracts added with this plan are `PLANNED`. The [roadmap](ROADMAP.md) is the release-order index. Each gate below requires evidence before the next release relies on it.

## Foundation decisions now

### EVERDOOR brand decision — PLANNED

The owner approved the product name EVERDOOR, the tagline “Every door, a new adventure,” a genre-neutral opening-door symbol, and Hearth as the working name for the warm base theme. The final logo, landing and campaign-door layouts, lobby details, theme catalog, Personal Haven, and commercial packaging remain open. The intended journey is Landing → Campaign Doors → Campaign Lobby → Adventure. These decisions do not rename technical identifiers or authorize a V0.1.1 frontend redesign. See [EVERDOOR Brand Vision](../design/EVERDOOR_BRAND_VISION.md).

### Campaign Lobby and GM Screen — PLANNED

Approved directions are recorded in [Campaign Lobby](../design/CAMPAIGN_LOBBY.md), [GM Screen](../design/GM_SCREEN.md), [Player Tabletop](../design/PLAYER_TABLETOP.md) and [Social Relations](../architecture/SOCIAL_RELATIONS.md). Master Studio prepares content used by the lobby and the game. One multitrack audio concept spans both. Audience-scoped chronicle drafts and review, configurable combat automation and the Social Relations architecture are proposals. Release sequencing and licensing decisions remain open. [Commercial hypotheses](COMMERCIAL_STRATEGY_DRAFT.md) are separate from delivery scope.

| Current area | Preserve or improve in V0.1.1 | First release that implements the new capability |
| --- | --- | --- |
| REST and realtime mutations | Share the token-movement service and check current membership, role, scene state and record versions in the write transaction. Verify competing edits, permission changes and reconnect behavior against PostgreSQL. Scope retry handling to known lost-acknowledgement cases | V0.2 adds authoritative geometry. Later transactional workflows own their receipt and retry contracts |
| Identity and privacy | Preserve opaque IDs, campaign scoping, version checks and viewer-specific projections through snapshots, realtime and media | V0.3 adds scoped entity IDs and sheet projections. V0.6 adds world and fact references |
| Tabletop data | Keep stable scene, token, grid, object, dice and initiative behavior. Avoid using current token resource slots as a future universal sheet model | V0.2 defines spatial units and queries. V0.3 introduces a rules-defined entity. V0.4.3 introduces package-defined encounter policies |
| Durability and evidence | Preserve existing wire compatibility, migration and backup/restore, add scope-specific negative tests under the stabilization plan, and complete GPU and owner-session checks from the acceptance report | V0.4.1 adds package upgrade snapshots. V0.6 adds simulation checkpoints. Neither feature requires a general event store today |
| Rights and extensibility | Use original or attributed fixture assets. Keep durable identities independent of names and translated labels | V0.3 uses built-in fixtures, V0.4.1 adds package distribution gates, V0.8 adds public moderation, V1.1+ adds commercial publication |

The active [V0.1.1 acceptance gates](../releases/V0.1.1_ACCEPTANCE_REPORT.md) still apply. New package schemas, runtime modules, scheduling infrastructure and public catalog features enter the codebase with their own release scope.

## Release evidence

| Release | Implementation slice | Tests and completion evidence |
| --- | --- | --- |
| V0.1 | Existing foundation | Record original validation, preservation of campaign data and known limits per the [scope](V0_1_SCOPE.md) |
| V0.1.1 | Existing stabilization increment and remaining blockers | Current CI plus PostgreSQL-backed permission and concurrency cases, measured rendering and owner session under the [acceptance plan](../releases/V0.1.1_ACCEPTANCE_REPORT.md) |
| V0.2 | Ship the existing staged geometry, movement, visibility and lighting plan | Legacy scenes keep their behavior without new geometry. Verify deterministic intersections, doors and windows, per-player privacy, multi-client conflicts and measured rendering. [V0.2 plan](../releases/V0.2_IMPLEMENTATION_PLAN.md) |
| V0.3 | Introduce exact built-in rule pins and a minimal typed schema/evaluator subset, then generate sheets and link placements | Create, edit and reload two original, structurally different systems, including a classless one. Verify recalculation, cycle reporting, visibility, edit conflicts and legacy scenes without character links. [Character Engine](../architecture/CHARACTER_ENGINE.md) |
| V0.4 | Extend the V0.3 interpreter with versioned calculations, checks, dice families and typed effects | Compare deterministic replays and traces across supported operators, pool and percentile fixtures, bounded explosions, opposed checks and failure on exceeded budgets. Prior sheet pins remain valid. [Ruleset Architecture](../architecture/RULESET_ARCHITECTURE.md) |
| V0.4.1 | Registry staging, dependency resolution, private or cleared export and opt-in upgrade | Verify digest and schema errors, dependency cycles, denied redistribution, exact pin persistence, failed migration rollback and old snapshot replay. [Licensing](RULESET_LICENSING_STRATEGY.md) |
| V0.4.2 | Visual Homebrew for original packages and permitted overlays | A creator authors and tests a custom sheet and rule, resolves an override conflict, publishes a new immutable version and migrates a copy. Verify bounds, hidden fields and license propagation. [Homebrew](../architecture/HOMEBREW_ARCHITECTURE.md) |
| V0.4.3 | Server encounter pipeline, optional turn/action models, reaction windows and GM policy | Two distinct encounters exercise target and geometry checks, private rolls, interruptions, atomic multi-target writes, retry and contested undo. Confirm Manual through Custom modes. [Combat Engine](../architecture/COMBAT_ENGINE.md) |
| V0.5 | Campaign preparation, encounter templates, session notes and timeline | Run a session from preparation to resume with and without rules enabled. Verify private sections, stale edits, export privacy and links surviving scene/campaign copies |
| V0.5.1 | FSM and utility profiles, bounded game paths through perceived space | Replay equal inputs, check unknown-state isolation, group contention, stale inputs, resource bounds and interruption by a GM. Confirm play works offline from AI services. [Tactical AI](../architecture/TACTICAL_AI.md) |
| V0.6 | Optional World Instance, calendars, step coordinator, reference laws and checkpoint control | Repeat equivalent steps with identical seeds, pause, preserve queued consequences through restart, reject stale proposals, restore an isolated checkpoint and test a world with optional subsystems disabled. [World Simulation](../architecture/WORLD_SIMULATION.md) |
| V0.6.1 | Named, scheduled and aggregate NPCs with knowledge and agenda changes | Verify private observations, goal updates, deterministic promotion, conservation when moving between cohorts and individuals, and optional encounter integration. [NPC Simulation](../architecture/NPC_SIMULATION.md) |
| V0.6.2 | Versioned political definitions and configurable fictional institutions | Test elections or succession, overlapping claims, conflicting transitions, audience-filtered laws and worlds without states. [Political Simulation](../architecture/POLITICAL_SIMULATION.md) |
| V0.6.3 | Stock/flow tracking, optional market detail and delayed effects | Reconcile inventories, shipments, taxes and budgets with programmatic invariants. Exercise contention, aggregate labor and worlds without currency. [Economic Simulation](../architecture/ECONOMIC_SIMULATION.md) |
| V0.6.4 | Visual world law editing, test horizons and publication of a new law set | Verify rule cycles, bounded feedback, custom schedules, compatible law upgrades and an isolated GM preview whose confirmed result matches the committed step. [World Rules Studio](../architecture/WORLD_RULES_STUDIO.md) |
| V0.6.5 | Causal hooks, scope-filtered narratives and GM publication | Exercise deduplicated generation, provenance after restart, privacy through published summaries, deferral and controlled state changes. Run the full flow using templates. [Narrative Engine](../architecture/NARRATIVE_ENGINE.md) |
| V0.7 | Versioned map authoring and export against the existing geometry contract | Round-trip layout and editable geometry. Prove imported scenes hold their source revision, safety limits reject oversized maps and Player exports omit hidden layers |
| V0.8 | Opt-in public profiles and sharing, discovery and moderation | Verify default privacy, blocking, consent, cascading removal from discovery, rights review and reported-content handling |
| V0.9 | Commercial beta readiness and service support | Agree quantitative capacity and reliability targets before load tests. Verify support, accessibility, maintenance, backup/restore, privacy and eligible content in supported deployment configurations |
| V1.0 | Commercial release with owner approval | Record security, reliability, accessibility, localization, operational, rights and support gate evidence. Test the real owner/GM/Player journey before release |
| V1.1+ | Marketplace with commercial publication and entitlements | Verify creator ownership, entitlement checks and revocation, paid-content availability, refunds where applicable, moderation and removal without leaking restricted files |

## Architectural tensions and actions

The owner-requested [Dark Tavern direction](../design/DARK_TAVERN_DESIGN_VISION.md), [scene audio concept](../architecture/SCENE_AUDIO.md) and [Adventure Atlas concept](../architecture/ADVENTURE_ATLAS.md) are planned design work. The visual milestone needs both-role usability and an asset budget. Audio needs permission-scoped streaming and recovery evidence. Atlas needs discovery separate from activation and a media test proving hidden raster pixels and metadata never reach a Player. Follow the proposed [roadmap placement](ROADMAP.md#proposed-placement-of-product-concepts) after the current release gates.

| Risk | Decision and next validation |
| --- | --- |
| Characters depend on rules before the full engine ships | Define the narrow V0.3 format and evaluation interfaces against two original systems. Extend in V0.4 and test compatibility with old pins before user import |
| Package updates can silently change play or reveal fields | Use immutable exact pins and GM-approved migration plans with redaction checks. Lock evaluator semantics and retain inputs required for authorized replay |
| Live randomness and deterministic replay have different requirements | Draw with server entropy for interactive play. Supply an explicit versioned RNG for reproducibility and protect internal draw state and traces |
| Automation can become a second write path or an information leak | Route all action intents through the ordinary application coordinator. Use perception-filtered input, current authorization, typed effects and policy-controlled publication |
| World laws need an editor, while the editor needs real examples | Start with bounded reference laws in World Core. Build and measure representative optional subsystems before V0.6.4. Reuse expression primitives while keeping separate capabilities |
| World steps and rules can exceed capacity or conflict | Bound work and require deterministic phase ordering and conflict resolution. Measure on representative worlds before introducing workers, additional infrastructure or long-horizon limits |
| State rollback can undo commitments already visible to players | Treat live undo as a current-version command. Use reviewed checkpoint restore or compensation for world history with downstream dependencies |
| Compatible game mechanics and content rights are easily conflated | Gate import, campaign sharing, public and commercial publication separately by exact edition, component and channel. Preserve provenance through derived packages |
| V0.2 needs geometry before V0.7 map authoring | V0.2 owns the versioned spatial contract. V0.7 authors and imports assets against it after round-trip and privacy tests |

Start with the next stabilization slice in the acceptance report. When it passes, validate the existing V0.2 geometry and privacy contracts. Prepare the V0.3 format using original fixtures only once the tactical release gates are met.

# Combat Automation Engine

**Status · PLANNED for V0.4.3.** An encounter binds a scene revision, participant references, effective rules, turn policy and automation policy. The table can also run an encounter with manually selected turns, simultaneous phases or no initiative mechanic.

## Action pipeline

1. Resolve the actor and its authority, selected action, targets and expected entity, encounter and geometry revisions. Ask Tactical Tabletop for authorized range, movement and line-of-sight facts. Recheck visibility and valid targets at commit or reject the stale plan.
2. Evaluate action availability, resources, turn budget, restrictions and modifiers against pinned character snapshots. Apply the package's dice rules. Resolve hits, damage, resistance, immunity, conditions and resource effects through named stages. Defaults come from the package.
3. If the rule opens reactions, persist a bounded encounter choice with eligible responders, scope and an explicit close condition. Responses use the same scoped command path. The final plan is assembled after reactions close. Cancellation rules define whether resources were reserved or merely previewed.
4. Return proposed typed effects and a calculation trace. Fit the result to the selected automation and audience policy. Override through explicit fields and log the GM decision.
5. Revalidate actor, policy and all affected revisions. Commit the final effects, turn/periodic updates, draw receipt and action receipt atomically. Publish projected results after commit. A stale result causes a new review, with any resampling and its reason made explicit.

The package describes legal phases, action budgets and when recurring effects occur or expire. The coordinator owns persistence and invokes the [Character Engine](CHARACTER_ENGINE.md) for character mutations and [Tactical Tabletop](TACTICAL_TABLETOP_ARCHITECTURE.md) for spatial ones. A play action cannot bypass either module's access controls. Hidden target data and private rolls follow audience policy through offers, receipts and errors.

| Mode | System behavior |
| --- | --- |
| Manual | GM records outcomes and chooses typed changes for the server to commit |
| Assisted | Server checks validity and offers rolls, effects or explanations for review |
| Semi-Automatic | Routine opted-in effects apply under policy. Configured exceptions pause for the GM |
| Automatic | Approved classes of valid actions commit after all guards and reaction windows. GM can pause or take over |
| Custom | GM selects policy by action and stage. Campaign security and transaction guards always apply |

Every commit records originating action ID, input/output revisions, effective rules, protected draw reference, effects and trace. Retries with the same scoped action ID return the recorded result after current access verification. Undo applies supported inverses against recorded output revisions with current permission checks. It fails on incompatible changes, unknown outcomes, settled irreversible publications or causal dependents without a reviewed compensating plan.

Verify action-budget variants, simultaneous/incomplete reactions, range and visibility changes between preview and commit, wrong-audience receipts, resistance/immune effects, recurring effects, policy switches, duplicate delivery and rollback of multi-target effects. [Ruleset Architecture](RULESET_ARCHITECTURE.md)

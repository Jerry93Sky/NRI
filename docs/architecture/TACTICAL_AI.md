# Tactical AI for Game Encounters

**Status · PLANNED for V0.5.1.** Use a small state machine for encounter lifecycle and a bounded utility selector over legal game actions. The selector can rank actions and targets with a readable trace. Requirements for richer planners are evaluated after this path is measured.

| Approach | Adoption |
| --- | --- |
| Finite-state machine | First release for control mode, assessment, action submission, reaction wait and pause. Keeps handoff and recovery explicit |
| Utility AI | First release for ordering approved action candidates using profile weights, thresholds and deterministic tie-breaks |
| Behavior trees | Candidate later for reusable scripted sequences if priority rules alone are hard to author |
| Goal-oriented action planning | Deferred pending a need for bounded multi-step planning and measured execution budgets |
| Spatial reasoning and pathfinding | Query Tactical Tabletop over the agent's perceived and last-known scene. Use bounded deterministic pathfinding over authorized traversable cells or regions and recheck the actual move through the normal game command |
| Group coordination | Start with explicit orders and shared observations that reached participants under campaign rules. Cap group attempts and coordinate through encounter state |

## Decision boundary

`ChooseAction(perceivedSnapshot, legalChoices, profileRef, rngState) → intent | pass, decisionTrace, nextRngState`. An NPC receives its observations, allowed memories, available game actions, assigned goals and scoped spatial facts. It cannot query the GM world snapshot. An unknown obstacle or unavailable target causes a normal authorized failure or replan. Feedback must avoid revealing the concealed cause unless the actor could learn it.

Resolve exact input revisions, profile and rules version, evaluator/planner version and random state. Sort stable IDs before evaluating or drawing ties so replays are reproducible. Apply planning budgets across candidates, paths and group iterations. On exhaustion pass control back to the GM or select a profile's safe fallback.

The GM's visual editor expresses conditions, goal and target priorities, ordered actions, reactions, retreat thresholds, cover preferences, protection of allies, ability preferences, group directives and exceptional behavior. Profiles compile to a typed, versioned policy. A preview displays considered legal actions and score inputs within that viewer's permissions.

Control mode is settable per NPC, group or encounter. Turning it off invalidates in-flight proposals by control revision and cancels queued work. Already committed actions stay authoritative. Automatic play still invokes the [Combat Engine](COMBAT_ENGINE.md) under its configured policy with server validation. Acceptance includes deterministic replay, strict perception boundaries, contention for game resources, stale route rejection, budget exhaustion and GM takeover during a pending action.

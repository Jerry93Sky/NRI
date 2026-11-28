# NPC Simulation

**Status · PLANNED for V0.6.1.** This module owns long-horizon choices by fictional inhabitants. Encounter control uses [Tactical AI](TACTICAL_AI.md) through separate game-action contracts.

An individual NPC can carry personality, traits, values, needs, motivations, goals, resources, relationships, obligations, roles, beliefs, memories, constraints and allowed actions. Templates may define new fields and choose which are relevant. Distinguish an occurrence in authoritative state from an observation, communicated report or belief. Each knowledge record carries source, time, subject and confidence or expiry when the world model uses those concepts.

`ProposeIntent(actorView, agenda, lawLock, tick, rngState) → intention | idle, reasons`. Rules rank permitted choices from the actor's own facts, capabilities and obligations. World services validate the proposed effect against actual state. Denial or failure returns only observations the actor can learn. Outcomes can change goals, commitments and relationships through typed events. The GM can inspect authorized reasons and override an agenda through a new versioned change.

| Detail | Model |
| --- | --- |
| Individual | Named NPCs keep independent agendas, relationships, observations and history |
| Scheduled | Supporting NPCs are evaluated on a due boundary with a smaller action set and batched routine updates |
| Aggregate | Cohorts carry distributions, shared attributes and aggregate stock/flow effects for large populations |

Detail changes occur at explicit steps. Promotion assigns a stable identity and records its cohort origin, seeded initial traits and claimed population/resources. Demotion reconciles those quantities and retains relevant history if the policy allows it. Count an actor either individually or in a cohort. Group averages never grant facts to a named actor.

Verify hidden-knowledge isolation, changed beliefs after a scoped event, deterministic promotion and aggregate reconciliation, invitation of a named NPC into an encounter and GM override. [World Core](WORLD_SIMULATION.md)

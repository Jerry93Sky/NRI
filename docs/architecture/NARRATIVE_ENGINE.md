# Narrative and Event Engine

[Adventure Builder](../design/ADVENTURE_BUILDER.md) defines the GM's choice to approve, edit, defer or reject delayed consequences and to select events for world canon.

**Status · PLANNED for V0.6.5.** Consume committed world, encounter and campaign facts. Produce proposed quests, rumors, relationships, crises, threats, opportunities and later consequences through typed rules and templates.

## Facts, proposals and publication

A fact has a stable campaign ID and fact ID, source event and parent references, a game-time coordinate, relevant input/output revisions, source law version and scoped audience. Preserve directed causal ancestry. A hook has its own ID, source fact IDs, template or rule version, proposed audience, typed claims and optional follow-on game commands. Store source facts separately from GM-edited descriptions.

Deduplicate hook generation by campaign, rule version and causal trigger identity. Build proposals from available audience-scoped facts. For conflicting information, distinguish a report, rumor and confirmed fact. Prefer a minimal provenance reference in public output when the full ancestry is private. A hidden NPC or institution cannot be revealed by title, notification, duplicate-key error, export or public trace.

The GM can accept, edit, reject, defer to an explicit tick or publish a permitted summary. Record a versioned decision. A reopened proposal is checked again against current facts and audience. Edit presentation without rewriting committed causes. A proposed state change enters the appropriate command service and goes through its own policy checks.

Optional generated prose may render authorized claims for one audience after review. Structured facts, actions and simulation state come from recorded rules and decisions. The product remains usable with templates alone.

Verify replay deduplication, causal links after restart, secret-safe attribution, intentional GM disclosure, deferral, sandbox and export isolation, and unchanged authoritative world state after rewriting a description. [World Core](WORLD_SIMULATION.md) · [World Rules Studio](WORLD_RULES_STUDIO.md)

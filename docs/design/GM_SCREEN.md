# GM Screen

**Status: PLANNED.** The GM Screen is a future configurable digital workspace. No modules or UI are implemented by this document, and V0.1.1 acceptance remains unchanged.

## Owner-approved requirements

The main area can show a map, illustration, NPC portrait, intro image, or other prepared material. The GM composes the workspace, placing configurable panels at the top, bottom, or sides and tailoring their contents. A quick-action panel is configurable. Tools may be opened in separate windows for multi-monitor use. The workspace is universal: it does not require switching between combat, exploration, or dialogue modes.

The GM can prepare locations for the current session and link additional scenes. Hidden points of interest and triggers can notify the GM as tokens approach; activation is manual or requires GM approval and never forces a scene transition. Trigger areas can be circular or square. The GM chooses which players see a new scene; other players can remain on the previous image when the GM chooses. The first implementation should not require parallel tactical simulations. A Player View helps the GM inspect what one player can see.

Preparation and improv tools include a reusable NPC pool; NPCs and opponents placed on scenes; reserve NPCs and other improv material; prepared combat and non-combat encounters; improvised-event tools; and saving materials created during play into the campaign library. An optional party-stat panel may be shown. A GM notebook supports private marks and cue notes on a map, with free notes or object-linked notes at the GM's choice. Local scalable effects can represent fog, gas, flooding, and similar areas, alongside traps. Built-in procedural generators should work without an external AI service. A user-facing generator builder is a later update. Tools reacting the wider world to player actions are also future work.

## Proposed architectural directions

Player-facing dialogue and the visible attitude indicator belong to the [Player Tabletop](PLAYER_TABLETOP.md). The GM controls the indicator in the planned [Social Relations](../architecture/SOCIAL_RELATIONS.md) flow. Private notes and GM-only reasons for attitude changes remain scoped to the GM.

These are working names for possible boundaries, not existing modules: **Scene Triggers**, **Effects & Hazards**, **NPC/Encounter Pool**, **GM Notebook**, **GM Overlay**, **Party Monitor**, **Quick Actions**, **Fate Engine**, and **World Control**.

Visual effects should remain separate from Rules Engine mechanics. Hidden triggers, notes, and per-player scenes require server-authoritative access control. Secret data must not be sent to unauthorized players through APIs, realtime events, media, or cached projections. These are future constraints, not a request to build these systems now.

All requirements and directions remain `PLANNED`; exact panel catalog, trigger behavior and rollout order need design and release approval.

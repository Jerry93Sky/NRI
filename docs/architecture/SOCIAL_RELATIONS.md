# Social Relations Engine

**Status: PLANNED.** Future architecture for the [Player Tabletop](../design/PLAYER_TABLETOP.md) and [GM Screen](../design/GM_SCREEN.md).

## Owner-approved requirements

NPC attitude applies to the group in the first version. During spoken dialogue the GM can raise or lower it, and players see a scale. One portrait is sufficient initially. A hostile conversation can have lasting consequences. World actions also affect later relationships, for example looting a settlement. A character's origin or ancestry can affect initial attitude in the fictional setting, within rules and campaign settings. Regions and cultures can respond differently. Negative attitude can impose disadvantage, change difficulty or influence social checks in another way defined by the ruleset.

## Proposed architecture

Consider separate short-term mood, persistent group attitude, reputation, regional and cultural context, and a history of significant events. Record what each NPC has reason to know. Witnesses, rumors and information links are later proposals. The GM can manually change attitude. Numeric scales, thresholds, visibility projections, persistence and adjustment rules require design.

Rules Engine can apply the agreed effects to checks. NPC Simulation can consume actor knowledge and attitude. Political Simulation, Economic Simulation and Living World Engine may read contextual outcomes when those modules exist. Keep GM-only causes separate from what players see. There is no AI dialogue generation in the planned core flow.

The planned trading flow can use NPC attitude and social checks to change terms under campaign rules. Pricing and the stock model have their own open design decisions. [Trading](../design/TRADING.md)

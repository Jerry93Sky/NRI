# Player Tabletop

[Master Studio](MASTER_STUDIO.md) and [Adventure Builder](ADVENTURE_BUILDER.md) prepare the materials behind the session. The player workspace receives content after an authorized reveal.

**Status: PLANNED.** Owner-approved direction for a later release. V0.1.1 keeps its existing tabletop.

[Character Studio](CHARACTER_STUDIO.md) supplies the authoritatively saved character sheet and ability references used by the player workspace.

## Interface and actions

An RPG-style interface around a central scene supports a hidden or expandable character card, configurable and resizable panels, saved layouts, secondary windows for multiple monitors, immersion mode, and a manually configured quick-action strip. Automatic population as a character advances is outside the first version. Start with simple dice results. Physical dice animation can be considered later.

A player can move authorized tokens, measure, point, draw and make permitted marks, interact with revealed objects, open doors, inspect the environment and pick up available items. The GM and campaign rules determine interaction availability, including perception and stealth. Secret areas, objects and triggers remain server-side until disclosed. Free spoken roleplay remains the default for unusual actions.

Outside combat, movement is free when permission allows. Combat uses the campaign rules. The GM can restrict movement temporarily for one participant or the group. Players can control permitted pets, elementals, summons and other tokens. Independent multiple player characters are outside the first version. The group shares one discovered-world map.

## Character, dialogue and notifications

The inventory includes character imagery, equipment slots, carried items and recipient-confirmed item transfers. The ruleset determines slot structure. Other characters' statistics, HP and private resources are private by default. Equipment-driven appearance changes are outside the first version. The player's notebook is private by default, including from the GM. The player can share selected entries. [Inventory & Equipment](INVENTORY_EQUIPMENT.md)

The GM plays NPCs in free dialogue. A portrait can appear over the scene, and the GM controls a visible attitude indicator for the group. Prepared response menus and multiple emotional portraits are optional future designs. Important events may show atmospheric notifications, small animations and GM-selected sounds.

## Combat, trade and loot

Combat adapts the player's interface. Rules can check distance, obstacles, visibility, resources and ability requirements before the action commits. The GM chooses the degree of automation. Manual, assisted and automatic modes are a proposal for Rules Engine design. Simple attack and spell animations are the intended starting point.

Trade supports buying, selling, bartering and bargaining. The GM plays the trader. For loot, the GM reveals available items and players normally pick freely. Money is split automatically. [Trading](TRADING.md) · [Loot](LOOT.md)

The server is authoritative for rules, state, outcomes and permissions. The client renders visuals, effects and audio. Quality presets and the option to turn off decorative effects are open design decisions.

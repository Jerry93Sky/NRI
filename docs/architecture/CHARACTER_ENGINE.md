# Character and Creature Engine

**Status · PLANNED for V0.3.** Characters, NPCs and creatures are entity instances of package-defined templates. The same engine supports an inventory-driven explorer, a simple stat block and a sheet with no class or levels.

[Character Studio](../design/CHARACTER_STUDIO.md) records the owner-approved workflow. A reusable personal character template can create independent campaign instances. The rules package, campaign compatibility and admission approval govern the instance.

Campaign character instances consume the planned inventory and equipment model. Item templates, individual items, equipment slots and shared storage have distinct responsibilities. [Inventory & Equipment](../design/INVENTORY_EQUIPMENT.md) · [Loot](../design/LOOT.md)

## State and interfaces

| Model | Responsibilities |
| --- | --- |
| Entity | Stable scoped ID, template reference, exact rules lock, instance revision, ownership and access grants. May appear through multiple tabletop placements. Links to world NPCs preserve separate state ownership |
| Instance inputs | Base values, inventory, equipment, learned abilities, progression, resources, relationships and permanent or temporary effects. Each change records provenance and its valid time or event boundary |
| Derived values | Package formulas and modifier policies. Source ordering, stacking, exclusion, rounding and clamps are declared by the package |
| Sheet | Declarative presentation schema for editable inputs, read-only derived values, localized labels and audience-specific panels |

Provide a scoped entity snapshot to the evaluator and to consumers. Accept versioned typed commands for changing fields, equipment, resources and effects. Tokens own coordinates and presentation. Character instances own their statistics. A future NPC simulation owns world knowledge, opinions and motivations. It may send an authorized proposal to update linked game statistics when a rule explicitly requires the transfer.

## Recalculation and privacy

Compile static field and modifier references to a directed graph. Detect cycles and report their paths before publishing a template. On input or effect changes, invalidate affected nodes and recalculate in stable topological order. Conditional dependencies must declare their possible input edges, so a dynamic path cannot bypass cycle analysis. Elapsed duration uses the package's configured encounter boundary or campaign time.

Trace each value through input revision, definition, applied and suppressed modifiers, operations and rounding. Separate server-only diagnostics from viewer projections. A Player may see a public score without seeing its hidden modifiers only when policy permits that summary. Prevent unauthorized field edits, derived-value inference through errors, hidden linked names through snapshots and leakage through exports or token labels.

V0.3 acceptance uses two original packages, one classless, to create and migrate schema-defined sheets. Test dependency invalidation, cycle reporting, effect expiry, competing edits, links across scenes, owner/GM views and reconnect projection. [Evaluation contract](RULESET_ARCHITECTURE.md)

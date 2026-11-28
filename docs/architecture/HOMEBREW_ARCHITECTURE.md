# Homebrew Studio

**Status · PLANNED for V0.4.2.** Visual authoring writes draft Ruleset Packages through the same validation and licensing gates as imports. Authors can start empty or pin a licensed base version. The preview interpreter uses the same semantics and budgets as live play.

## Authoring model

Typed editors cover characteristics, skills, classes and professions, creatures, abilities, items, progression, sheet layout, formulas, conditions, triggers, reactions and combat policy. Sheets reference stable field IDs, with schema-based input components and explicit visibility. An author can add namespaces and definitions, extend declared slots, or replace a typed target when a base package permits it. A restriction from an upstream rights policy applies to derivative publication.

Campaign authors provide sheets and character creation rules through the same versioned definitions consumed by [Character Studio](../design/CHARACTER_STUDIO.md).

Custom items belong to Homebrew. The planned expanded item editor is a later design step. [Inventory & Equipment](../design/INVENTORY_EQUIPMENT.md)

The effective ruleset is assembled in this order.

1. Resolve the exact base and its immutable dependency graph.
2. Apply enabled extension modules in dependency order, then use the explicitly pinned campaign module order for independent nodes.
3. Apply Homebrew overlays in the authored lock order.
4. Apply campaign overrides to declared setting keys and ranges.

Additive changes merge by stable ID. Replacing definitions requires a typed target and expected input definition digest. Multiple writes to one property require an explicit resolution naming the winning change and the expected predecessor. Unresolved changes, undeclared overrides, circular inheritance and removed definitions still referenced by other definitions are validation errors. Removing or renaming a field on live data additionally requires a migration. Show the effective source of each resulting setting in the editor.

## Safe authoring and publication

- Store typed expression trees and event rules, using a fixed operator table and validated references. Formulas support arithmetic, comparison and bounded collection operations. Policy rules may propose only recognized typed effects. Formula programs have no arbitrary JavaScript, scripts, reflection or I/O, and cannot write directly to storage.
- Validate AST depth, list sizes, dependency graph, static types, references and known event re-entry paths. Cap evaluation steps, allocation, rolls and triggered effects at runtime. Budget failure aborts the proposed transaction and returns a scoped diagnostic.
- Run scenario fixtures in a disposable snapshot. Authors can inspect formula traces, compare effective values and preview migrated sheets. Clear secrets from any exported test fixture unless its audience and rights allow them.
- Publishing creates an immutable successor. The draft may be copied or abandoned. Existing campaigns adopt it through the Registry's exact-pin upgrade process.

Validate ambiguous overlays, same-ID creation, valid intentional overrides, cross-package migration, recursion and budget failures, preview/live result parity and secret fields. [Registry](RULESET_ARCHITECTURE.md) · [Character Engine](CHARACTER_ENGINE.md)

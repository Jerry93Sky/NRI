# Universal Ruleset Architecture and Registry

**Status · PLANNED.** V0.3 introduces the built-in subset required by [Character Studio](../design/CHARACTER_STUDIO.md). V0.4 broadens evaluation. V0.4.1 adds imports, exports and registry workflows.

## Package identity and contents

| Manifest field | Meaning |
| --- | --- |
| `packageId`, `version` | Publisher namespace and stable package name, plus immutable release version. Translations and display changes cannot change identity |
| `formatVersion`, `evaluatorRange` | Supported document format and engine compatibility. The resolved campaign lock also pins exact execution semantics |
| `dependencies` | Package IDs, acceptable version ranges and required capabilities. Resolution produces exact artifact references and a checked acyclic graph |
| `publisher`, `authors`, `license`, `provenance` | Creator metadata, notice, source references, rights scope and per-component attribution for definitions, assets and locales |
| `locales`, `defaultLocale` | Stable message keys and locale bundles. Fallback order is campaign preference, package default, then stable key |
| `entries`, `integrity` | Manifest inventory with canonical relative paths, media types, SHA-256 file digests and canonical manifest digest |
| `migrations`, `fixtures` | Declarative transitions between named versions and compatibility scenarios with pinned inputs and expected results/traces |

Canonicalize the manifest without its own digest using JCS, then hash it with SHA-256. Its file inventory binds the artifact bytes. Reject duplicate keys and ambiguous filenames before canonicalization. A digest checks integrity. Publisher identity and content rights are separate checks. [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html) · [Licensing strategy](../product/RULESET_LICENSING_STRATEGY.md)

Definitions use package-qualified stable IDs and typed cross-references. A package can describe attributes, derived values, skills, classes, professions, ancestry, backgrounds, advancement, inventory, equipment, spells, abilities, checks, damage, immunities, resistances, conditions, resources, modifiers, actions, reactions, periodic effects, turn policies, creature templates and sheets. It can define new entity types with validated fields and display rules. Each campaign declares the capabilities it uses.

Equipment slots, weight, item use and consumable tracking depend on ruleset capabilities and campaign configuration. [Inventory & Equipment](../design/INVENTORY_EQUIPMENT.md)

## Evaluation contract

`Evaluate(programRef, immutableInput, context) → value | typedFailure, trace`. Context supplies package lock, evaluator version, explicit clock where needed, scoped entity inputs, resource budget and RNG handle for roll programs. Results can include proposed typed effects, which an authorized application service may commit. The interpreter has no network, database, host clock or user-code access.

Dice primitives compose bounded draws, grouping, selection, rerolls, success counting and comparisons. This supports single-die thresholds, percentile checks, varied pools, opposed checks and bounded exploding dice. A package chooses ordering, thresholds, tie rules and results. Each loop-like dice operator has a declared ceiling and an explicit failure on exhaustion. Character resources, classes, levels, hit points and initiative are optional. Test the contract with both a classless pool and a separate original percentile fixture.

Use exact bounded integers or explicit fixed-scale decimals for auditable rules. Define rounding and comparison in the evaluator version. Interactive rolls get entropy on the server. Reproducible evaluation uses an explicit versioned RNG algorithm and recorded protected draw state or seed. Store enough context to replay for authorized users, including input revision, package lock, evaluator version and draw order. Public traces expose only the values allowed for that viewer.

## Registry lifecycle

1. **Stage.** Import a private bounded artifact. Validate manifest, byte and entry counts, declared media, paths, digest, schema, references, licenses, dependencies and evaluator compatibility. Validate metadata and fixtures before a version can become selectable. A local draft can be revised. Publishing material to another person requires a separate rights decision.
2. **Resolve and pin.** Resolve dependency ranges once using a specified deterministic tie-break and reject incompatible or cyclic dependencies. Pin each exact package ID, version and digest, plus ordered overlays and evaluator version, in a campaign lock. Multiple versions can coexist across campaigns. A registry update changes availability for new selections.
3. **Plan upgrades.** Use declarative, versioned migrations to map fields, units and references. Render a dry-run report with incompatible actions, lost fields, unmapped records and changed secret visibility. Run fixture and campaign checks on a copy, retain the previous lock and a protected recovery snapshot.
4. **Apply deliberately.** A permitted GM or owner approves the plan. At commit, compare the original campaign lock and affected revisions. Apply migrations and the new lock atomically within a bounded workload or staged maintenance publication for large datasets. On failure retain the old active revision. Preserve historical records with their original interpretation.
5. **Export or retire.** Export an explicit scope and list dependencies rights permit the system to include. Preserve exact pins and provenance. Unknown formats are rejected at import with a diagnostic. Keep old artifacts for authorized replay and restore according to access and retention policy. A delisted version cannot be newly published through discovery.

## Release checks

Use package format fixtures with distinct clocks and dice semantics. Check offset and boundary values, dependency order and cycles, digest mismatch, conflicting releases, deterministic trace, roll ceilings, snapshot recovery, failed upgrades and visibility of trace inputs. Use original fixture data. [Implementation gates](../product/LONG_TERM_IMPLEMENTATION_PLAN.md)

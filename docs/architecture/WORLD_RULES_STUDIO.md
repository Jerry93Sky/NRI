# World Rules Studio

[Adventure Builder](../design/ADVENTURE_BUILDER.md) records optional time advancement and GM review. Advanced condition editing belongs to the later World Rules Studio stage.

**Status · PLANNED for V0.6.4.** The first World Core and specialist modules use reviewed reference laws and bounded text configuration. The Studio later turns the same format into editable forms, expression trees, typed event rules and test scenarios.

## Law and event model

A law has a stable ID, version, enabled flag, event trigger or periodic game-time schedule, phase, priority, declared read/write capabilities, typed conditions, constraints and actions. Actions can propose resource and relationship changes, schedule delayed consequences, publish scoped facts or request an enabled module's typed operation. A probability operation draws from the step's versioned RNG. Each law identifies its input dependencies and the audiences allowed to see its results.

A condition such as food stock below a threshold can request an economic price policy change, a population mood effect and a dated shortage event. The owning modules validate each effect. The GM can edit or disable the law, preview the consequence set and set the approval requirement for a crisis.

## Authoring and execution

- Compute static field and event dependencies, reject unresolved references, illegal same-tick re-entry and cycles in derived formulas. A legitimate feedback loop must cross logical time or a declared later phase under a finite budget.
- Match the shared interpreter's typed numerical semantics. World rules receive world-specific types and capabilities. A character check cannot schedule a world event through the expression evaluator. Both engines use explicit input and resource bounds. [Homebrew Architecture](HOMEBREW_ARCHITECTURE.md)
- Enforce per-step and per-causal-root bounds on evaluation cost, fired rules, event depth, scheduled horizon and total effects. Dedupe scheduled events under a stable key and process in a stable order. On exhaustion return a failed preview and auditable reason. The authoritative clock, queue and RNG remain at the original revision.
- Run test horizons in a private snapshot. Compare ordered event and effect traces, identify conflicting writers and show expected outcomes, inactive dependencies and audience effects. Draft publication creates a new immutable law set. The campaign opts into that set through the World Core, with compatible migrations and a recovery checkpoint.

Validate threshold edges, deterministic probability, recurrent and delayed events, disabled subsystems, mutual trigger limits, effect conflicts and preview/apply parity. [World Core](WORLD_SIMULATION.md)

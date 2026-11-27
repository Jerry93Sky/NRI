# Economic Simulation

**Status · PLANNED for V0.6.3.** The module has a common accounting contract and supports several depths. A world can disable the economy or use named abstract stocks without money.

| Depth | State |
| --- | --- |
| Abstract | Resource balances by settlement or faction, bounded production/consumption, shortage thresholds and optional trade |
| Detailed | Inventories and storage limits, production recipes/workforce, household demand, prices and currencies, logistics, taxes, budgets, trade commitments and delayed deliveries |

Resources define units, precision, allowed accumulation and conversion. Currency is an optional typed unit with declared conversion rules. Use scaled integers, explicit rounding and deterministic allocation for scarce stock or transport. Flows record source and destination, units, quantity, rule/event reference and game tick. Explicit production, consumption, spoilage and costs account for source or sink changes. Negative balances and credit are allowed only where the model declares them.

Each step reads one coherent stock/commitment snapshot. Reserve or allocate jointly when several actions claim a limited balance. Outstanding shipments represent separate in-transit state and settle once on delivery or declared loss. Price policies, shortages, labor shifts, growth and taxes generate typed transactions or consequences. A political law can change tax policy by proposing an effect handled through the World Core.

If food stock falls under a campaign threshold, a law may propose a price change, a social effect and a shortage fact linked to ledger changes. The economic evaluator supplies permitted facts. The configured law and subsequent GM policy determine consequences.

Verify resource and balance reconciliation, rounding, duplicated shipment rejection, competing orders, abstract depth, cyclical production constraints, disabling policy integration and synthetic economies without currency. [World Core](WORLD_SIMULATION.md) · [World Rules Studio](WORLD_RULES_STUDIO.md)

# Political Simulation

**Status · PLANNED for V0.6.2.** A campaign enables only the fictional institutions it needs. A polity can be abstract. A world may also have no polities at all.

Definitions describe jurisdictions, forms of government, offices, governing bodies, succession and elections, laws, groups, parties, estates, guilds, religious organizations and secret societies. Relationship models may include influence, legitimacy, allegiances, alliances, treaties, claims and conflict state. The rules define authority, valid transitions and consequences, including reforms, revolts, political crises and declarations of in-game war.

## State and rules

- Separate an institution from its officeholders and from the territory in which authority applies. A policy can permit overlapping jurisdiction, joint control or no owner. Keep claims separate from control.
- Each political event has eligibility, applicable authority, effective tick, effects and optional GM approval. A campaign declares how simultaneous decisions, elections, succession, treaty changes and overlapping laws are resolved. A deterministic rule resolves or escalates ambiguity.
- `EvaluatePolitics(worldSnapshot, politicalPolicy, dueEvents) → typedProposals, facts`. The module consumes authorized actor intentions or aggregate inputs and emits proposals for political state. It can request an economic effect through the World Core. It cannot write inventory or population directly.
- Visibility follows the institution and event. Public offices or enacted laws can have published summaries. Hidden affiliations, deliberations and claims may require narrower audiences. Public effects must not expose private event inputs in their trace.

Verify incompatible appointment and treaty changes, authority while an office is vacant, inactive optional economic integration, private affiliations, reproducible transitions and institution-free campaigns. [World Core](WORLD_SIMULATION.md) · [NPC Simulation](NPC_SIMULATION.md)

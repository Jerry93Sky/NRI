# Product vision

## Purpose

NRI Platform is a commercial, internationally usable platform for tabletop role-playing games. It aims to combine a welcoming virtual table with flexible campaign tools and, over time, an original rules workbench and a deterministic living-world simulator.

The product is inspired by broad usability patterns in virtual tabletops; it does not copy another product's source code, interface, or commercial content. It remains independent of any specific game system.

## Product principles

1. **Easy first session:** a GM should be able to create a campaign, add a map, place tokens, and invite players without extensive setup.
2. **System neutral:** rules, character properties, checks, classes, and damage systems will be configurable data, not assumptions in the tabletop core.
3. **Modular monolith first:** cohesive modules and stable boundaries, without premature microservices.
4. **Server authority:** the server determines membership, permissions, dice results, and persisted state.
5. **Confidentiality by construction:** secret GM content is excluded from unauthorized API responses, realtime messages, downloads, logs, and exports.
6. **Durability:** refreshes, restarts, reconnects, retries, and concurrent changes must not silently lose campaign state.
7. **AI independent:** core play works without external AI services.
8. **Commercially adaptable:** future tiers, storage limits, self-hosting, localization, import/export, and creator distribution must fit without embedding prices into core logic.
9. **Rights aware:** no unlicensed books, game text, maps, or art. No project-wide code license until the owner decides.

## Product directions

- Virtual Tabletop
- Character Studio
- Universal Rules Engine
- Campaign Studio
- Living World Engine
- Map Studio
- Community Hub
- Marketplace

Only the first direction and its foundation are in V0.1. Future directions are roadmap entries, not implied existing features.

## Living World concept

The future Living World Engine should advance a campaign world between sessions using explicit software rules: time and calendars; territories and settlements; factions, resources, goals, and relationships; NPC goals and ties; autonomous actions; events and causal chains; and simulation-generated hooks. The GM must be able to preview, approve, edit, or cancel results. Procedural rules are primary; generated prose is optional. Prior work called London may be considered a conceptual reference, but NRI must have no direct technical dependency on that repository.

# Adventure Atlas

**Status** `PLANNED` · Architecture concept for linked campaign maps and exploration.

## Maps, links and travel

GMs can import maps and place points of interest. An authorized point can connect to another map, a complete prepared scene, location images, NPCs, documents or reference entries. GMs can hide points, reveal them manually, control fog, follow a link and return to the previous map in one action. A transition can select a sound profile or atmosphere. Later Map Studio work can author settlement, dungeon and world maps using the V0.2 geometry contract.

Discovery and scene activation are separate commands. Discovering a point grants the intended audience visibility of the point and selected links. Activating a linked scene moves the table under the existing one-active-scene campaign contract. Showing a destination does not activate it. A future server-owned participant/location model can support individual exploration or split parties once scene access, presence, invitations and reconnect are defined for simultaneous locations.

## Privacy and raster fog

The server projects each atlas snapshot and event using current discovery and access state. Before discovery, hidden names, coordinates, links, images, descriptors and asset identifiers are excluded. Parent and child maps apply their own gates, and discovering a point does not automatically authorize a secret destination or document. Tests must exercise direct references, foreign campaigns, stale subscriptions, cache keys and reconnect.

A client mask may render fog for presentation. Private raster pixels must be withheld server-side. Keep the original raster in GM storage and serve authorized derived chunks or a server-composited redacted image. Generate and authorize by campaign, map revision, audience and reveal revision. A tile straddling the boundary must redact hidden pixels before delivery. Apply matching checks to thumbnails, ranges and export, and keep restricted derivatives out of shared public caches. Verify by decoding player responses and checking the pixels and tile inventory, including their boundaries. Previously received pixels cannot be revoked.

Proposed placement is a read-only linked-map and discovery slice after V0.2 spatial/privacy and V0.5 campaign tools, with authoring and round-trips in V0.7 Map Studio. Split-party navigation and reactive atmosphere follow separately measured session and simulation work. This does not change the V0.1.1 scene contract.

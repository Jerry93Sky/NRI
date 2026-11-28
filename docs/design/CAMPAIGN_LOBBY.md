# Campaign Lobby

[Master Studio](MASTER_STUDIO.md) supplies prepared materials. [Adventure Builder](ADVENTURE_BUILDER.md) governs campaign setup, the optional player questionnaire and access after archival.

**Status: PLANNED.** This records owner-approved product requirements and proposed architecture separately. It does not authorize implementation or change V0.1.1 acceptance.

## Owner-approved product requirements

The Campaign Lobby is a pre-session waiting space built around a realistic top-down table. A side panel shows participant avatars and names and lets a player select a previously created character. The GM places prepared widgets and materials on the table; a subtle snap grid supports layout, and the GM can save multiple lobby templates. Materials can include maps, books, letters, handouts, a chronicle of earlier adventures, trophies, and commemorative illustrations. Some decorative objects can be interactive locally for one participant. Synchronized mini-games such as chess or dice are a later lobby capability.

The lobby supports shared text chat, private text messages, and multiple simultaneous audio tracks. One multitrack-audio concept should serve both the lobby and game scenes. Participants set individual readiness, but the GM can start regardless of every player's status. Starting can go directly to play, include GM remarks, or show a prepared intro. A late participant enters the lobby; the GM admits them to the active scene. Between sessions, players may read materials the GM has published to them. The lobby returns after a session. Once the campaign is fully completed, player access to its lobby closes. Keepsakes from completed campaigns may later appear in Personal Haven.

The lobby is not the primary world editor. NPCs, maps, scenes, plots, and other campaign materials are prepared in the GM's Master Studio and brought into the lobby as prepared materials and widgets. A future Master Studio toolset may vary by subscription; commercial terms are undecided and no billing is approved.

## Adventure Chronicle

**Approved product requirement:** the owner wants the chronicle to be populated automatically from significant events and encountered NPCs, subject to GM review before players see the published version.

**Proposed architecture, not approved implementation:** record structured significant play events; draft chronicle entries from those facts; allow manual entries for spoken roleplay; let the GM edit/review and publish an audience-specific version. Generative AI is not required. Event visibility and source facts must be filtered server-side; secret events must not enter player drafts, snapshots, or publication by default.

## Open decisions

- Final visual treatment and exact snap-grid dimensions.
- Widget catalog and synchronized mini-game rules.
- Audio track and resource limits.
- Subscription packaging for future Master Studio tools.
- Reconnect behavior for a player previously admitted to an active scene.

All items remain `PLANNED`; the last item is specifically a proposal for future owner review.

# EVERDOOR brand vision

**Status: PLANNED.** This document records the owner's approved direction and separates it from design choices that remain open. It does not authorize a frontend redesign or change V0.1.1 acceptance criteria. “NRI Platform” remains the temporary technical name of the existing project; repository, package, environment, Docker, database, and code identifiers remain unchanged.

## Owner-approved direction

| Decision | Approved direction |
| --- | --- |
| Product name | **EVERDOOR** |
| Tagline | **Every door, a new adventure** |
| Primary symbol | A stylized opening door, usable across tabletop genres; an ordinary polyhedral die is not the primary brand symbol |
| Logo status | The artistic execution is not yet approved |
| Base theme | Working name **Hearth**: a welcoming place from which larger adventures begin |
| Visual character | Warm pastels, wood, copper and bronze, tactile large-scale textures, a cozy hearth, and anticipation of travel; combine a usable professional interface with RPG atmosphere |
| Genre scope | Do not constrain the identity to medieval fantasy |
| Motion and sound | Avoid excess decoration; keep animation polished and cost-bounded with an option to disable decorative effects. Do not require a door-opening animation on the landing page and do not autoplay landing-page music. A short door-opening transition is planned when entering the campaign lobby. |
| Main journey | Landing → Campaign Doors → Campaign Lobby → Adventure |
| GM and Player priorities | GM: preparation, creation, and campaign operation. Player: immersion, atmosphere, adventure, and convenient play actions. |

## Planned experience concepts

### Landing and Campaign Doors

The landing may use a classic game menu or a themed site. Campaign Doors use a responsive grid of large, individually illustrated doors, presented like folders in Windows rather than a 3D corridor. Show each campaign title and a one- or two-line description beneath its door. Hover may crack the door open and reveal colored light; title hover shows a short story phrase, title click opens full details, and door click transitions into the campaign lobby. A separate crooked, plain door is captioned «Создать новое приключение». See [Campaign Doors](CAMPAIGN_DOORS.md) for the approved direction and open choices.

### Campaign Lobby

The lobby is a pre-session top-down table with a participant sidebar, selected characters, GM-placed prepared materials, saved layouts, readiness, chat, and a route into the session. It returns after play and supports published read-only material between sessions. The owner-approved requirements and unresolved choices are recorded in [Campaign Lobby](CAMPAIGN_LOBBY.md). Its exact artwork and widget catalog remain open. A single future multitrack audio concept should span the lobby and play scenes; see [Sound & Atmosphere](../architecture/SCENE_AUDIO.md).

### Themes and Personal Haven

Manual campaign theme selection is a future concept; a theme is not inferred from the game system. Possible settings include cozy adventure fantasy, dark fantasy, Victorian, cyberpunk, science fiction, and post-apocalypse. Alternative themes are a possible later expanded offering. Do not add a theme subscription, shop, or theme marketplace now.

Personal Haven is a future personal room or study for both GMs and Players, potentially including interior choices, decorations, bookshelves, trophies, and campaign mementos. The commercial shape and customization limits remain open.

### Community

Player and GM discovery, campaign listings, friends, and social interaction are late-stage concepts and are not part of current implementation.

## Open design questions

- Final logo artwork, proportions, typography, and icon family.
- Landing-page structure and campaign-door layout, filters, and interaction model.
- Lobby composition, interaction set, audio controls, accessibility, and performance budget.
- Hearth palette tokens, material treatment, and the balance between atmosphere and dense GM workflows.
- Theme catalog, if any, and how users preview themes before a campaign chooses one.
- Personal Haven scope, privacy, customization inventory, and commercial packaging.
- Name, domain, and trademark clearance before commercial launch.

## Delivery boundaries

All concepts in this document are `PLANNED`. The brand decision records direction, not final visual assets or implementation. Campaign Doors, Door Studio, Campaign Lobby, GM Screen, Adventure Keys, and marketplace are later concepts. Existing UI stays as-is in V0.1.1. Subscription packaging, theme store, community features, audio engine, and commercial rights remain undecided. Revisit the experience through owner-reviewed design artifacts before scheduling implementation.


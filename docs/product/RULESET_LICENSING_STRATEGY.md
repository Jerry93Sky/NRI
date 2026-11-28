# Ruleset licensing strategy

**Status · PLANNED.** Rules compatibility, the right to copy or adapt specific material, permission to redistribute it, and the right to use a mark are separate decisions. Every edition has its own evidence. An extensible engine can support a family's mechanics while a content package for that family still awaits rights review.

## Sourcing paths

| Path | Intake rule |
| --- | --- |
| Original NRI or creator-authored | Record contributor, authorship and media provenance. Fixtures use original material or separately documented grants |
| Open reference material | Identify exact title, version, source and allowed portion. Maintain version-specific attribution, change notices and applicable downstream terms |
| Publisher or creator agreement | Record rights holder, licensed edition, channels, territory, duration, commercial use, adaptation, assets and branding scope |
| User-provided private package | Apply the private intake policy and obtain evidence that the intended use is permitted. A private upload, invitation or campaign copy grants no platform publication rights |

Wizards publishes specific D&D SRDs. Treat SRD 5.1 and 5.2.1 as separate sources with edition-specific attribution and artifact manifests. CC BY 4.0 includes attribution duties, including license and change information, and does not grant trademark rights. Review the exact licensed reference, commercial branding separately and all non-SRD material by its own provenance. [Wizards SRD catalogue](https://www.dndbeyond.com/srd) · [SRD 5.1](https://media.wizards.com/2023/downloads/dnd/SRD_CC_v5.1.pdf) · [SRD 5.2.1](https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.1.pdf) · [CC BY 4.0 legal code](https://creativecommons.org/licenses/by/4.0/legalcode.en)

Evaluate Pathfinder material by edition and designated Licensed Material. For an ORC release, inspect its notice, excluded or reserved material and downstream obligations. Treat any older license and any compatibility mark as separate grants. [ORC license text](https://downloads.paizo.com/ORC_LicenseFINAL.pdf) · [Paizo compatibility FAQ](https://paizo.com/licenses/compatibility/faq)

GURPS, Call of Cthulhu, Cyberpunk, Warhammer, Vampire: The Masquerade, Savage Worlds, Shadowrun, Fate and other editions or brands are evaluation candidates. Verify publisher, exact source, terms and intended channel before any distribution decision. Track books, illustrations, setting text, logos and translations separately. First-party engine tests use original systems, with no need for licensed game data.

## Registry, sharing and export gates

1. Retain a private review record for each component, including origin URI, artifact digest, edition, license text/version, author, permitted uses, obligations, notices and verification decision. Record dependency and derivative provenance through Homebrew, translations and updates. Missing or incompatible evidence blocks the affected distribution path.
2. Validate three separate paths for private use, campaign sharing and public or commercial publication, including downloadable export. Export only cleared files and include declared pinned dependencies and notices where redistribution permits it. When only references may be shared, report unresolved imports before a recipient can use the package.
3. Resolve restrictions at component and combined-package level. Propagate relevant obligations, stop incompatible composition before publication and require a fresh rights check when the artifact, distribution channel or rights grant changes.
4. Provide review history, takedown, delisting and appeal handling for community publishing. Separate disabling discovery and future downloads from privately retaining authorized records under governing policy. Protected operator backups are distinct from shareable package exports.

Technical validation checks manifest completeness, digest, attribution inventory, dependency composition and matching permissions for derivatives, copies and export. Human review of the applicable rights gate is required for public catalog and commercial content. A project-wide source license remains a separate owner decision. [Registry design](../architecture/RULESET_ARCHITECTURE.md)

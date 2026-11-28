# Demo Asset Provenance

| Asset set | Source | License / rights |
| --- | --- | --- |
| Copper Kettle, Blueglass Lane, and Tollkeeper’s Vault maps | Procedurally composed SVG authored in `apps/server/src/demoArt.ts`, rasterized to PNG by Sharp during the local seed | Original project-created work; no third-party images, fonts, textures, or generated provider assets are embedded. |
| Nine character and creature token portraits | Procedural SVG shapes and color palettes authored in `apps/server/src/demoArt.ts`, rasterized to PNG by Sharp during the local seed | Original project-created work; no third-party images, fonts, textures, or generated provider assets are embedded. |

The seed stores generated PNG files under the configured local upload directory and writes SHA-256 checksums to the asset records. Each newly created campaign asset has a fresh storage key. Re-running the seed is a no-op after the campaign exists. The Owner/GM copy workflow copies source bytes to fresh storage keys and validates the source file size and checksum before committing a campaign copy.

This file records provenance for the V0.1.1 playable demo. It does not establish a project-wide source-code license.

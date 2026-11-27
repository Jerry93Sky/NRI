# Sound & Atmosphere Engine

**Status** `PLANNED` · Architecture concept for a later campaign and scene release.

## First playable scope

The owner-approved direction is one multitrack-audio concept shared by Campaign Lobby and game scenes. The implementation proposal is for GMs to upload audio to the campaign library, reuse tracks, and assign ambient beds, background music and cues. A scene or lobby layout can point to a reusable profile of multiple layers. Each layer can define looping, level, fade-in/out and transition behavior. The GM can start, pause, resume, transition or stop audio. Scene activation may start its default profile, with an explicit way to suppress automatic playback. Each player controls local volume and mute. Exact simultaneous-track and resource limits remain open. The browser may require a prior user gesture to start audio, so current state and a pending playback indication must recover when playback is enabled.

The server authorizes scene/profile and asset metadata, playback cues, manifests and byte/range requests by the recipient's campaign and current scene access. Future scene titles, private track names, asset IDs and URLs must stay out of player snapshots, event payloads, caches and errors before disclosure. Scope media links or streams to authorized requests. Document upload quotas, accepted formats and rights. Keep the composition reusable by stable ID while allowing scene-specific mixing. A cue can carry an authoritative started-at time and current playback intent, while mixing, device choice and volume are local.

## Later extensions

After the V0.2 spatial contract and server-authorized scene access exist, evaluate spatial sources and attenuation. Rules Engine and World Simulation may send authorized requests to select a sound cue. Playback and local mute remain independent of simulation progression. Review transport drift, reconnection, bounded decoder costs and rollback of cue changes with multiple clients.

Proposed placement is an optional Campaign Studio V0.5 follow-up after the V0.2 scene privacy gates. Spatial and reactive profiles follow their respective geometry, Rules Engine and World Simulation dependencies. No V0.1.1 acceptance gate depends on audio.

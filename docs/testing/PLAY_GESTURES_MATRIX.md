# PLAY-GESTURES verification matrix

Roles are campaign scoped. A manager is an Owner or GM. Pointer interruption discards the preview. A rejected history command reloads the authorized scene snapshot. The client does not retry the write with a newer version.

| Action | Roles | Coverage | Cancellation and limits |
| --- | --- | --- | --- |
| Token drag | Managers and Player owners of movable tokens on the active scene | GM movement in `campaign-privacy.spec.ts`. Owner drag, foreign and locked denial, conflict and interrupted pointer in `token-move-conflict.spec.ts` | Escape, pointer cancellation, lost capture and release outside the canvas discard the preview |
| Group token selection and movement | Managers | Select all and drag two tokens in `token-move-conflict.spec.ts`. Atomic movement regressions and multiplayer smoke | Group conflicts are atomic. Box selection is an existing canvas tool |
| Object drag and resize | Managers on an editable layer | Rectangle drag/resize and saved coordinates in `token-move-conflict.spec.ts`. Locked/hidden-layer checks in `campaign-privacy.spec.ts` | Object and layer locks apply server-side. Real touch handles need owner review |
| Multi-object selection, copy and paste | Managers | Clipboard tests in `campaign-privacy.spec.ts` | Group clipboard and lifecycle are atomic. Group movement of scene objects is `NOT_SUPPORTED` |
| Freehand | Managers and players with drawing permission on the active scene | Player draws and deletes in `campaign-privacy.spec.ts`, denied writes in object regressions | Cancellation leaves the stroke uncommitted |
| Line editing | Managers on editable layers | Existing line and layer checks in `campaign-privacy.spec.ts` | Pointer resize regression uses a rectangle. Line geometry at real-device zoom remains open |
| Grid calibration, ruler and pointer | Calibration for managers. Ruler and pointer for authorized participants | Grid/ruler units, mapped calibration and pointer delivery in `campaign-privacy.spec.ts` | Visual pointer expiry and touch use need owner review |
| Undo/Redo and lifecycle | Managers in the current workspace | Group clipboard, create, delete, restore and history in `campaign-privacy.spec.ts`. Resize then another writer in `token-move-conflict.spec.ts` | The competing version survives a rejected Undo and the authorized workspace is refreshed |
| Focus and shortcuts | Current participant, subject to command authorization | Chat focus isolates Ctrl+Z and Delete. Scene creation focuses the name. Escape returns focus to the opener | Hotkeys ignore editable fields. Global Delete is `NOT_SUPPORTED`. Other dialogs and assistive technology are `MANUAL_ACCEPTANCE_PENDING` |
| Context and viewport | All authorized participants | Existing 1366×768, 1920×1080 and 2560×1440 snapshots and layout checks. Held drag during role changes and removal | Changes of scene, campaign, identity, role or connection cancel the preview. Network interruption and scene-switch drag still need dedicated reproductions |

See Draft PR #1 for the exact Playwright result on the published commit and the [operations handoff](../operations/PERF_GPU_OPS_HANDOFF.md) for owner device acceptance.

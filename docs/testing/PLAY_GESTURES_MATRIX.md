# PLAY-GESTURES verification matrix

Roles are campaign scoped. A manager is an Owner or GM. Pointer interruption discards the preview. A rejected history command reloads the authorized scene snapshot. The client does not retry the write with a newer version.

| Action | Status | Roles | Coverage | Cancellation, conflict and remaining checks |
| --- | --- | --- | --- | --- |
| Token drag | PASS | Managers and Player owners of movable tokens on the active scene | GM movement in `campaign-privacy.spec.ts`. Owner drag, foreign and locked denial, stale version and interrupted pointer in `token-move-conflict.spec.ts` | Escape, pointer cancellation, lost capture and release outside the canvas discard the preview. A stale version retains the server position |
| Group token selection and movement | PASS | Managers | Box-select two tokens and drag in `token-move-conflict.spec.ts`. Atomic PostgreSQL movement regressions and multiplayer smoke | Cancellation preserves canonical positions. Group conflicts are atomic |
| Object drag and resize | PASS | Managers on an editable layer | Rectangle drag/resize and saved coordinates in `token-move-conflict.spec.ts` | Escape and pointer interruptions discard the preview. Locks apply server-side. Touch handles need owner review |
| Layer selection, locked and hidden layers | PASS | Managers edit. Players receive visible layers | Locked layer drag in `token-move-conflict.spec.ts`. Selection, hidden data and delivery in `campaign-privacy.spec.ts` | A locked layer rejects writes. Layer versions and permissions remain authoritative |
| Multi-object selection, copy and paste | PASS | Managers | Clipboard and lifecycle in `campaign-privacy.spec.ts` | Group clipboard writes are atomic |
| Group movement of scene objects | NOT_SUPPORTED | — | Group movement applies to tokens. Scene objects support multi-select and clipboard | — |
| Freehand | PASS | Managers and players allowed to draw on the active scene | Player draws and deletes in `campaign-privacy.spec.ts`. Denied writes in object regressions | Cancellation leaves the stroke uncommitted |
| Line movement and resize | PASS | Managers on editable layers | Line move and resize under wheel zoom in `token-move-conflict.spec.ts`, including persisted endpoints and keyboard Undo/Redo | Resizing scales stored path points with the bounds. Line handles at different zooms need device review |
| Grid calibration, ruler and pointer | PASS | Calibration for managers. Ruler and pointer for authorized participants | Grid/ruler units, map calibration and pointer delivery in `campaign-privacy.spec.ts` | Escape exits tools. Visual pointer expiry and touch use need owner review |
| Undo/Redo, delete and restore | PASS | Managers in the current workspace | Creation, clipboard, delete/restore and history in `campaign-privacy.spec.ts`. Resize then another writer in `token-move-conflict.spec.ts` | The competing version survives a rejected Undo and the authorized workspace is refreshed. History is scoped to the current workspace |
| Focus and shortcuts | PASS | Current participant, subject to command authorization | Chat, token name, GM note and asset search isolate ruler, Undo/Redo and Delete. Scene creation focuses the name. Escape returns focus to its opener | Hotkeys ignore editable fields |
| Global tabletop Delete | NOT_SUPPORTED | — | Delete/restore use explicit controls | — |
| Context and viewport | PASS | All authorized participants | Layout and visibility at 1366×768, 1920×1080 and 2560×1440. Held drag during scene switch, reconnect, role change and removal | Changes of scene, campaign, identity, role or connection cancel the preview |
| Device and dialog usability | MANUAL_ACCEPTANCE_PENDING | Managers and Players | Device input, touch resize, other modal flows and assistive technology | QA-OWNER exercises a real session |

See Draft PR #1 for the exact Playwright result on the published commit and the [operations handoff](../operations/PERF_GPU_OPS_HANDOFF.md) for owner device acceptance.

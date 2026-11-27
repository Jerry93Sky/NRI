# Next finite package: SEC-OPS + PLAY-GESTURES

This document records the preparation checklist for the SEC-OPS and PLAY-GESTURES pass. Current results and remaining environment checks are recorded in the [acceptance report](V0.1.1_ACCEPTANCE_REPORT.md) and [closure plan](V0.1.1_CLOSURE_PLAN.md).

## SEC-OPS evidence package

### Sensitive log review

Exercise these actions while collecting API stdout/stderr and application logs: login/session rotation and logout; invitation creation/acceptance/revocation; public and private chat; hidden dice; GM-only notes; malformed/denied API requests; upload decode, staging, rename, SQL and compensation failures. Inspect request URLs, structured fields, exception messages, stack traces, access logs, browser console, and container logs for cookies/session values, invitation bearer strings, private chat bodies, hidden dice details, GM notes, image bytes, and filesystem paths that reveal protected content. Save redacted representative samples and the source route/log configuration reviewed. Do not put secret values in artifacts.

### Parallel upload memory profile

Use the existing Compose profile and test-only media fixtures. Run the maximum supported set of valid, bounded images concurrently, with mixed PNG/JPEG/WebP near the current per-file and per-request limits. Record fixture dimensions and compressed bytes, concurrency, API/Node/Sharp versions, container memory limit, start/end RSS, peak RSS sampled at a fixed interval, CPU time, decoded pixel bounds, response status, and post-run ordinary chat/scene traffic. Confirm that failed/aborted cases leave no committed rows or unexpected media files. Report whether the configured resource envelope survives the profile; do not infer production capacity from loopback.

## PLAY-GESTURES checklist

Run the already supported gestures as GM and Player in independent browser contexts: single-token drag and resize; locked token and locked layer; selected group move/edit; scene object drag, resize and supported line/freehand editing; keyboard focus and shortcuts; undo/redo of the latest own operation; conflict after another user's edit; visibility changes; scene/campaign switch; reconnect while a gesture or save is pending. Record browser, viewport, role, gesture, persisted before/after state, conflict/recovery response and screenshot for each failure. Keep scope inside gestures already present in V0.1.1.

## Required follow-up for PERF-GPU

Request a named GPU/driver/browser target and map dimensions before the run. Capture viewport and rendering mode, frame-time P50/P95, GPU and process memory where available, texture/object counts, 30–60 minute editing/reconnect session, texture release on scene switch, and recovery after context loss. The current hostless Pixi preview is not hardware acceptance.

## Exit reporting

Attach exact SHA, environment, commands, raw measurement files, log samples after redaction, test outcome and unresolved risk. Update only the corresponding closure-plan rows with evidence. This preparation does not close SEC-OPS, PLAY-GESTURES or PERF-GPU.

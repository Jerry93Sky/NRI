# Threat model

## Assets and trust boundaries

Assets include account credentials and sessions, campaign data, hidden GM material, private messages, invite links, uploaded files, dice/initiative outcomes, and audit history. The browser and all client payloads are untrusted. Trust boundaries are HTTP, Socket.IO, database, media storage, and operator configuration.

## Principal threats and controls

| Threat | Required control |
|---|---|
| Account takeover | Modern password hashing, generic login errors, rate limiting, session rotation on login, expiry and revocation, secure cookie settings |
| Cross-campaign access / IDOR | Check membership and campaign scope on every API, socket command, snapshot, and media read; test direct-ID access |
| Role forgery | Resolve role server-side; role belongs to the specific campaign; audit changes |
| Secret leakage | Construct role-filtered projections before transport; protect reconnect, logs, files, exports, and error details |
| Token theft / CSRF | HttpOnly, Secure in production, SameSite cookies, origin and CSRF protections appropriate to the deployment |
| Malicious uploads | Size/type allowlist, inspect decoded content, random storage keys, no executable serving, authorization on reads |
| XSS / injection | Render user text as text, validate and bound inputs, safe image handling, parameterized ORM queries |
| Replay / duplicate mutation | Command IDs, idempotency, version checks, rate limits, atomic transactions |
| Dice manipulation | Parse bounded grammar and generate result only on server using cryptographic randomness |
| Data loss / corruption | PostgreSQL constraints, transactions, optimistic versions, backups of database and media, isolated restore drills |
| Resource exhaustion | Request/body limits, upload caps, bounded dice expressions, socket and auth rate limits, performance observation |

## Operational requirements

Do not commit secrets or bake development credentials into production configuration. Restrict database binding to localhost/internal compose network by default. Redact logs, rotate operator secrets, and define backup retention and restore ownership. Protect invite tokens by storing hashes, use sufficiently random tokens, and honor expiry/revocation. Keep audit data useful without copying private content.

## V0.1 security verification

Verify unauthorized access, role forgery, cross-campaign IDs, hidden object and message access over HTTP and WebSocket, direct file access, reconnect snapshots, XSS strings, malicious uploads, replay, and secret redaction. Record actual results and unresolved issues in the release report. This document is a design target, not proof of a completed audit.

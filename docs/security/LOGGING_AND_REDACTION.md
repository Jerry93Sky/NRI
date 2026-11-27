# Operational logging and redaction

## Data boundaries

| Channel | Data excluded | Data retained |
| --- | --- | --- |
| Fastify and Pino HTTP request and error records | Raw URL, query, route parameter values, body, headers, Authorization, Cookie, Set-Cookie, password and recovery credentials, client-provided request ID | Server request ID, method, route template on errors, HTTP status, elapsed time, fixed category |
| Realtime and application services | Socket handshake credentials, message and dice data, campaign and GM notes, private token fields, unpublished scene and asset data, request payloads | Fixed messages about publication or operation failures |
| PostgreSQL, startup and shutdown | Raw driver error message, SQL, parameters, causes, storage path and environment credentials | Fixed condition or category, signal, listening port. SQL server logs are a separate operational surface |
| File processing and cleanup | Input filename, storage key, path, media bytes, decoder error text | HTTP result codes and fixed categories such as `FILE_ACCESS` or `FILE_TYPE` |
| Reverse proxy and Compose | Nginx access log is disabled and error output is restricted to critical diagnostics. Review critical messages and container runtime output before transfer | Restricted diagnostic output for the reverse proxy, API and database |
| CI and browser diagnostics | Only synthetic identities and files. Traces can include full network payloads, URLs, cookies and screenshots | Counts, assertions and scoped runner diagnostics. Treat any captured trace as restricted |

Private and public chat text, hidden dice values, owner and GM notes, secret asset references, invitation codes, session credentials and private URL parameters must not appear in operational logs. There is no password reset flow in the current release. Campaign audit records retained in PostgreSQL serve a separate game audit purpose and keep their existing authorization and lifecycle.

## Confirmed finding and regression

An isolated removal fixture induced a real filesystem error after deleting asset metadata. Before the fix the raw error included a synthetic storage path. Asset cleanup now logs fixed categories through the HTTP request logger. Pino serializers strip raw request/response objects and reduce errors to a fixed form. Fastify request IDs come from the server.

`apps/server/scripts/logging-canary.mjs` starts the built API against `nri_sec_ops_test` and scans its captured stdout/stderr. It drives login, failed login, logout, invitations, private and public chat, hidden and public rolls, token notes and ownership, draft access, invalid payload/image, asset rollback and failed cleanup, and access changes. It checks plain, encoded and JSON-escaped values and verifies safe log metadata remains. The log capture is held in memory and the test prints only labels on failure.

The regression observes application streams. The production PostgreSQL Compose service uses terse error logging, suppresses statements below PANIC and disables parameter logging. It can still record primary database messages. Review those messages, proxy critical logs and retained traces on the deployment host. Avoid verbose Socket.IO debug in the deployment environment and restrict access to operational logs and artifacts.

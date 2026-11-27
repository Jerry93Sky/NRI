# CMD-ACL local profile

**Date:** 2026-11-27  
**Status:** local baseline only; not production capacity evidence.  
**Source:** dedicated `command-authorization.mjs` profile run on the task branch.

## Environment and method

- Windows x64 development host, Node.js `v24.13.0`, 12 logical CPUs, 32 GiB host memory.
- Isolated Docker PostgreSQL `16.15` on Linux x86_64; API, browser-independent client and database used local loopback networking.
- One client at a time, five HTTP samples per operation, 1×1 PNG upload payload of 68 bytes. No competing users or production-scale content.
- P50 and P95 are nearest-rank values from five client-observed elapsed durations. Token event latency is measured from request start to client receipt of the committed `token:created` packet; it is not a pure server enqueue duration.

## Results

| Operation | Workload | Samples | P50 | P95 |
| --- | --- | ---: | ---: | ---: |
| Token create | One token per request | 5 | 22.71 ms | 30.66 ms |
| Token create event delivery | Request start to matching Socket.IO packet | 5 | 17.47 ms | 22.62 ms |
| Group token duplicate | 3 source tokens per request | 5 | 18.98 ms | 20.73 ms |
| Resource adjustment | One token, current version per request | 5 | 15.66 ms | 18.15 ms |
| Scene duplicate | Existing scene, default layers and fixture tokens | 5 | 24.03 ms | 29.02 ms |
| Campaign duplicate | Campaign with one 68-byte image and its scene/token fixture | 5 | 181.73 ms | 185.28 ms |
| Protected original read | One 68-byte PNG | 5 | 21.34 ms | 23.06 ms |
| Asset upload | One 68-byte PNG; decode + thumbnail + staged file | 5 | 24.22 ms | 26.23 ms |

## Limits and next measurement

The local PostgreSQL image does not have `pg_stat_statements`, so per-operation SQL statement counts were not recorded. The run did not sample process RSS during upload, database lock hold time, event queue delay under concurrency, larger images/groups, or cold-cache behavior. The figures are loopback development measurements and must not be used to set production SLOs. A representative hosted profile should add SQL statement instrumentation, 1 MiB and near-limit media fixtures, batch sizes 1/10/50, concurrent sessions, process memory sampling, and lock timing before CMD-ACL performance acceptance.


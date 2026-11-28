# Scene-content realtime profile

**Baseline** `7fd3d6be` · The [object lifecycle profile](../releases/V0.1.1_ACCEPTANCE_REPORT.md#sql-and-delivery-measurement) is retained separately. It measured a different mutation, with 11 write statements and six publication statements for groups of 1 and 10. Its four-socket median last packet after HTTP was 5.86 ms and 7.78 ms. It is a reference for query shape and local cost.

## Method

Windows API and clients on loopback, Docker PostgreSQL 16.15, Node.js/pnpm from the repository toolchain, 20 operations per configuration after setup. The probe snapshots `pg_stat_statements` before and after each run and waits for the publisher to release its transaction. SQL counts exclude `BEGIN` and `COMMIT`. Two boundary statements occur without a recipient and four with recipients. Mix of Owner/GM and Player sockets, including separate tabs of the same sessions at eight sockets. The one-socket case is Owner. Objects are small text fixtures. Bytes are UTF-8 JSON event and payload for one recipient over the whole command, before Socket.IO/WebSocket framing. HTTP and receipt timings use the same client clock. Last packet is the last expected packet across connected sockets. All timing columns are nearest-rank P50/P95 in milliseconds.

Run the API against a dedicated migrated loopback `nri_realtime_test` database with `pg_stat_statements` preloaded, the extension installed and utility tracking enabled. Use `NODE_ENV=test`, set `NRI_API_URL` to that API and run `corepack pnpm@12.23.0 --filter @nri/server test:realtime --profile`. The profiling command makes disposable fixture campaigns and objects.

| Operation / objects | Sockets | SQL per command | HTTP P50/P95 | Last packet P50/P95 from request | Last packet P50/P95 after HTTP | GM / Player JSON bytes |
| --- | ---: | ---: | --- | --- | --- | --- |
| Copy / 1 | 0 | 11 | 15.516 / 17.073 | — | — | — |
| Copy / 10 | 0 | 11 | 21.434 / 25.881 | — | — | — |
| Copy / 50 | 0 | 11 | 30.628 / 35.445 | — | — | — |
| Copy / 1 | 1 | 17 | 14.040 / 15.860 | 18.961 / 21.375 | 5.005 / 5.582 | 442 / — |
| Copy / 10 | 1 | 17 | 16.976 / 17.567 | 22.798 / 24.950 | 5.624 / 6.762 | 4,420 / — |
| Copy / 50 | 1 | 17 | 27.734 / 34.538 | 34.655 / 42.377 | 6.859 / 7.724 | 22,100 / — |
| Copy / 1 | 4 | 17 | 13.909 / 16.123 | 19.177 / 21.654 | 5.250 / 5.846 | 442 / 409 |
| Copy / 10 | 4 | 17 | 16.965 / 18.699 | 23.636 / 25.751 | 6.437 / 7.387 | 4,420 / 4,090 |
| Copy / 50 | 4 | 17 | 28.493 / 30.573 | 38.515 / 41.148 | 9.591 / 11.431 | 22,100 / 20,450 |
| Copy / 1 | 8 | 17 | 16.078 / 21.071 | 22.572 / 45.831 | 6.030 / 13.177 | 442 / 409 |
| Copy / 10 | 8 | 17 | 19.990 / 22.211 | 27.782 / 31.166 | 8.171 / 9.253 | 4,420 / 4,090 |
| Copy / 50 | 8 | 17 | 29.966 / 34.647 | 42.150 / 46.858 | 12.202 / 12.916 | 22,100 / 20,450 |
| Create / 1 | 0 | 9 | 12.720 / 14.505 | — | — | — |
| Create / 1 | 4 | 15 | 12.327 / 15.374 | 17.821 / 20.356 | 5.280 / 5.810 | 442 / 409 |
| Edit / 1 | 0 | 11 | 13.952 / 15.256 | — | — | — |
| Edit / 1 | 4 | 17 | 14.753 / 23.455 | 19.908 / 29.067 | 5.205 / 6.385 | 444 / 411 |
| Layer rename | 0 | 10 | 12.558 / 13.604 | — | — | — |
| Layer rename | 4 | 15 | 13.737 / 16.677 | 18.663 / 21.718 | 4.831 / 5.229 | Both 286 P50 / 287 P95 |

Except where indicated, payload byte P50 and P95 matched. SQL stayed flat across group size and sockets. Object publication uses six queries, and a former-public removal can add one batched location lookup. Layer rename publication uses five. The bounded retry for a new layer observed while locking was outside this microbenchmark.

## Projection cost

Twenty samples, 500 projection loops per sample after warm-up, using the production projection function. Each value covers one batch in microseconds. JSON encoding, Socket.IO enqueue and transport are accounted for in receipt timings above.

| Objects | GM P50/P95 | Player P50/P95 |
| ---: | --- | --- |
| 1 | 0.280 / 0.423 | 0.667 / 1.493 |
| 10 | 3.564 / 5.096 | 6.830 / 14.565 |
| 50 | 14.915 / 26.312 | 28.445 / 37.101 |

Wire volume and fanout grow with eligible object–socket pairs. The outlying eight-socket one-object P95 occurred in this 20-operation run. These local samples leave WAN latency, sustained load, large freehand payloads, cold caches and congested sessions open. A follow-up profile should measure snapshot traffic and high fanout with large strokes before changing delivery batching.

## Ephemeral pointer profile

The RT-ACL pointer path was measured separately after moving sender and recipient checks into one `withSceneAudience` transaction. One, four and eight Owner sender sockets posted while a Player receiver recorded eligible packets. Each sender waited for the ACK before its next update and then paced at 55 ms, approximating the existing 20/s per-socket cap. The run lasted about three seconds per configuration. P50/P95 values use nearest rank; receive time is measured from each sender's call to the Player's packet. SQL counts come from `pg_stat_statements`; they include additional chat/dice SQL in the eight-sender mixed run. CPU is process CPU percent over the sample window. RSS records API process values at the two endpoints, not peak memory.

| Senders | Attempts / accepted / published per second | Dropped by pointer throttle | SQL / transaction-boundary statements per accepted event | ACK P50/P95 ms | Receive P50/P95 ms | API CPU | API RSS before → after MiB |
| ---: | ---: | ---: | ---: | --- | --- | ---: | --- |
| 1 | 10.63 / 10.63 / 10.63 | 0 | 4.00 / 2.00 | 10.338 / 14.429 | 5.555 / 9.314 | 0.49% | 190.0 → 195.5 |
| 4 | 43.59 / 43.59 / 43.59 | 0 | 4.00 / 2.00 | 14.500 / 24.333 | 6.766 / 10.935 | 11.19% | 195.5 → 196.4 |
| 8 | 75.88 / 75.88 / 75.88 | 0 | 4.44 / 2.22* | 18.765 / 60.553 | 11.581 / 30.732 | 23.16% | 196.4 → 104.0 |

\* Eight-sender run included public chat and dice commands about every 0.5 seconds. Their ACKs in that run were chat 24.755/71.975 ms and dice 15.427/22.254 ms P50/P95. The preceding eight-socket idle-pointer profile's standalone chat ACK was 15.068/18.619 ms and dice was 16.836/32.656 ms. Samples are small, loopback-only and noisy; they do not show a stable performance improvement or a regression for dice. Chat P95 rose in this mixed sample. The drop in endpoint RSS is consistent with allocator/GC behavior and is not a peak-memory measurement. The application does not expose PostgreSQL pool waiters, so queue depth was unavailable. Generator CPU was 0.00%, 2.43% and 3.71%; generator RSS was 69.9, 64.8 and 67.4 MiB respectively.

The accepted pointer rate was about 9.5–10.9 per sender/second in this serial-ACK loop, below the allowed 20/s; no pointer throttle drops occurred. The path performs four SQL statements and one PostgreSQL transaction per accepted pointer, versus the former nested two-transaction authorization shape; no prior pointer timing sample was recorded, so a latency delta against that shape cannot be claimed. Local results do not establish WAN or production capacity. Reproduce on the isolated PostgreSQL service with `NRI_PRIVATE_PERF=1` and `.data/foundation-audit/run-private.ps1 -Label rtacl-profile -Suite private-profile`.

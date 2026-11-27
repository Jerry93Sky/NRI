# SEC-OPS image upload profile

## Limits

Multipart accepts at most 12 files at 12 MiB each. The alpha proxy accepts a 145 MiB request body including multipart overhead. Image headers are checked before full pixel decode. PNG, JPEG and WebP are supported up to 8192 pixels per axis and 16,777,216 pixels in total. The decoded output ceiling is 64 MiB. Animated streams and malformed content are rejected. An explicit MIME declaration must agree with the inspected format. Generic binary declarations are checked from bytes. Thumbnails fit 320×240 and use WebP.

The API admits two asset processing jobs at once, with up to six waiters and ten seconds of queue wait. An exhausted queue returns `503 UPLOAD_BUSY` and `Retry-After`. Busy and interrupted uploads do not reserve a receipt. Permission and commit checks use independent transactions, with no database lock held while waiting for admission or decoding. Uploads and on-demand thumbnail generation share the limit. PostgreSQL and files still have a crash window. The cloud or proxy layer may buffer its own temporary request data independently.

## Method

Use the isolated [Compose stack](../../deploy/testing/compose.sec-ops.yml), the API target from `Dockerfile.production` and `apps/server/scripts/sec-ops-upload-profile.mjs`. The stack binds loopback only, uses temporary PostgreSQL and media stores, and caps the API container at 768 MiB. The client generates PNG fixtures on the host: 512² portrait, 768² token, 2400×1600 map, 3500² large map and 4096² pixel-limit map. They range from 45,577 to 1,117,304 bytes.

The script samples Node PID 1 RSS and cgroup memory inside the container every 50 ms. It samples API admission counters and event-loop percentiles separately. It compares 1/2/4/8 request waves with three iterations each. The last wave of each size uses images at the pixel ceiling. It verifies same-key replay, partial multipart, token movement, chat, dice, initiative, scene update and protected thumbnail read. CI runs the bounded profile with the same method.

## Local Docker Desktop evidence, 2026-11-28

| Parallel HTTP | Before limit peak RSS MiB | After limit baseline / peak / final RSS MiB | After limit HTTP P50 / P95 ms | After limit peak cgroup MiB |
| --- | ---: | ---: | ---: | ---: |
| 1 | 213.7 | 143.4 / 203.0 / 150.2 | 92.97 / 307.79 | 181.4 |
| 2 | 268.4 | 150.2 / 275.6 / 201.1 | 59.96 / 382.52 | 255.8 |
| 4 | 390.2 | 201.1 / 319.6 / 198.4 | 208.76 / 504.94 | 309.2 |
| 8 | 425.0 | 198.4 / 325.5 / 199.3 | 516.34 / 1143.62 | 328.9 |

The measured peak number of active jobs was two. The final loop delay P95 was 20.37 ms at 20 ms sampler resolution. No OOM or restart occurred and all gameplay smoke operations passed. The queue trades request latency for lower peak memory. Results use synthetic PNGs over loopback and omit the production proxy and real device/network conditions.

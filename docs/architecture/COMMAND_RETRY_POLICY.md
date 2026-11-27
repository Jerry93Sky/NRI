# Command retry and safe recovery policy

**Status: IN_PROGRESS.** This policy records the guarantees implemented on the current V0.1.1 branch. A lost HTTP response or Socket.IO ACK does not prove that a transaction rolled back. No network exactly-once guarantee is made.

## Current operation inventory

| Operation | Commit can outlive response | Automatic retry | Manual retry today | Snapshot can prove original outcome | Concurrency / ID | Current guarantee and access boundary |
| --- | --- | --- | --- | --- | --- | --- |
| Public chat | Yes, before the realtime ACK/event arrives | No | Without a client ID, creates another append | History may show similar text, not which request created it | `clientMessageId`, scoped to campaign and sender; unique PostgreSQL key and payload digest | Same ID/payload returns original message after current session, membership, and private recipient checks. Changed body/recipient conflicts. A replay ACK emits no second chat event. |
| Private chat | Yes | No | May create another private message | Only the currently authorized participants can inspect it; history does not identify the pending request | Same as public chat | Same ID returns the original message only while sender and recipient access remain valid; current member roles reapply the existing private-chat policy. |
| Dice roll, public | Yes | No | Runs a new random roll without a request ID | No durable client history for resolving an uncertain request | `requestId`, scoped to campaign and user; PostgreSQL unique key plus transaction-scoped advisory lock and payload digest | Same ID/payload returns the saved result. Changed expression/visibility conflicts. Replay ACK does not broadcast a second result. |
| Dice roll, hidden | Yes | No | Can create a second hidden roll | No public history; the result is not inferable from a snapshot | Same as public dice | Current manager authorization is checked before replay. A demoted or removed manager cannot recover a formerly hidden result. |
| Resource adjustment | Yes | No automatic retry | Retry with old expected version is rejected | Authorized token snapshot/version shows current value, but not which action caused it | Existing optimistic version | On conflict the client reloads an authorized snapshot. No automatic reissue with a new version; the user must choose a new adjustment. The client cannot attribute the observed value to its pending action. |
| Token create / duplicate / group duplicate | Yes | No | Can create extra token(s) | Scene snapshot shows current entities but cannot associate them with a lost request | Existing versions protect sources, not duplicate result recovery; request ID not implemented | Outcome is not safely replayable yet. Inspect an authorized snapshot and make a new explicit decision. |
| Scene object create / copy / group copy | Yes | No | Can create extra object(s) | Scene snapshot shows entities, but not their request lineage | Existing optimistic versions; request ID not implemented | Outcome is not safely replayable yet. |
| Scene create / duplicate | Yes | No | Can create another scene/copy | Authorized scene list shows results, not their request lineage | Request ID not implemented | Outcome is not safely replayable yet. |
| Campaign create / duplicate | Yes | No | Can create another campaign/copy | Campaign list shows results, not their request lineage | Campaign-create scope would need user-level identity before a new campaign ID; request ID not implemented | Outcome is not safely replayable yet. |
| Single / multi-file asset upload | Yes, across the DB/filesystem boundary | No | Can create more assets/files | Library may show committed rows, but does not identify the upload request | Request ID not implemented | Existing staging and compensation remain best-effort across PostgreSQL and filesystem; no filesystem recovery journal or cross-system ACID guarantee. |
| Other mutable REST and realtime commands | Yes | No general automatic retry | Depends on command and expected version | Usually an authorized snapshot can reconcile current state; it cannot always prove authorship | Existing version checks where applicable; no general command envelope | Do not retry non-idempotent actions automatically. Reconcile through the owning authorized snapshot, then ask for a new user decision. |

## Chat and dice request contracts

- IDs are UUIDs generated when the user begins an intention. A deliberate second identical message or roll gets a new UUID.
- Chat identity is `(campaignId, authenticated senderId, clientMessageId)`. Dice identity is `(campaignId, authenticated userId, requestId)`. The IDs are not authorization credentials.
- The request digest covers only operation payload fields that change the result: chat body and recipient; dice expression and hidden flag. Campaign/user scope comes from the authenticated command. Transport fields are excluded.
- The database row and result are committed together. Unique constraints serialize duplicate identities; dice also serializes same-key contenders before generating the persisted roll.
- A matching replay returns the stored row/result without a second audit row or event publication. A different digest returns `CONFLICT`.
- Session, campaign membership, role, recipient policy and current hidden-roll visibility are checked on every replay before the result can be returned.
- There is no time-based expiry for these two keys: they live exactly as long as their underlying message/roll row, currently until campaign deletion. Deleting a campaign cascades the rows and ends the guarantee. This does not create a separate unbounded receipt table.
- A transaction rollback leaves no key reservation, so the same ID can be retried. Network delivery itself remains best-effort.

## Client recovery behavior

Chat and dice keep one pending operation in component memory. A five-second missing ACK is shown as outcome unknown; an explicit next click retries the same ID and payload. No payload or ID is persisted to browser storage. Pending state is cleared when the user or campaign changes. Independent tabs have independent intentions and IDs.

Resource adjustment keeps the existing version check and reload behavior. If its response is lost, the next write with the stale version conflicts and fetches the current authorized token snapshot. The client does not convert that conflict into a fresh decrement/increment. Other creates/copies/uploads still need request IDs and a dedicated recovery affordance; they must not be automatically retried.

## Retention and limits

The chat and dice records are the deduplication records. They are retained with campaign content; campaign deletion removes them. There is no promise after deletion and no separate TTL cleanup job. No request IDs are currently implemented for creates, copies, or uploads, so the remaining rows in the inventory have no deduplication guarantee. This policy must be revised before claiming RT-RETRY complete.

# PostgreSQL and media backup / restore

**Status:** `IN_PROGRESS` — no-overwrite database/media backup with manifest verification is implemented; local create/verify and isolated `nri_test` restore drill passed; coordinated production quiescence and scheduled restore validation remain open.

## What must be captured

Campaign records and uploaded media form one recoverable set. A database dump without the matching `UPLOAD_DIR` contents can leave asset rows pointing at missing files. A media archive without the database cannot restore campaign permissions or references.

For a coherent maintenance backup:

1. Put the server into maintenance by stopping new writes and draining existing requests. Keep PostgreSQL and its persistent volume running.
2. Record the database and media directory names from the active deployment configuration. Never substitute the example development credentials for production configuration.
3. Dump PostgreSQL in custom format. Copy the complete configured `UPLOAD_DIR` to a new, empty staging directory.
4. Create a manifest containing creation time, database name, application revision, archive filenames, byte sizes, and SHA-256 checksums. Do not include credentials.
5. Verify each checksum before publishing the backup directory. Use a new timestamped destination; refuse to overwrite an existing backup.
6. Resume writes only after both the dump and media copy pass verification.

The repository provides backup creation and verification commands. Install the PostgreSQL client tools so `pg_dump` matches the server major version, configure `DATABASE_URL` and `UPLOAD_DIR`, and run from the repository root. The optional name must be a new simple directory name under `.backups`:

```powershell
corepack pnpm@12.23.0 db:backup lantern-vault-before-session
corepack pnpm@12.23.0 db:backup:verify lantern-vault-before-session
```

Without a supplied name, creation picks a timestamped unique name. The command stages under `.backups`, refuses existing destinations, rejects symlinks in media, hashes the database dump and every media file, verifies the complete inventory (including missing or extra files), then atomically renames the verified staging directory. Failed runs remove only their unique staging directory. The verifier checks an already-created named backup without changing it. Neither command stops the API: the operator must stop new writes and drain active requests before starting, then resume only after creation and verification finish. Production use requires the deployment's real database role, media path, and quiescence controls.

## Safe restore

1. Verify the manifest and all archive checksums before restore.
2. Create a fresh, uniquely named restore database. If the name already exists, stop; never drop or overwrite it.
3. Restore the custom dump into that empty database with ownership and ACL restoration disabled unless the target environment explicitly requires them.
4. Restore media into a new empty directory and verify each file checksum. Point an isolated application process at this database and media directory.
5. Confirm row counts and sample references for users, campaigns, memberships, scenes, assets, tokens, scene objects, messages, dice rolls, and initiative.
6. Leave the source database, source media, and existing backups untouched until the isolated restore is accepted.

## Backup command verification

- **Date:** 2026-11-26
- **Source:** isolated local PostgreSQL database `nri_test`; no database rows were changed.
- **Command:** `node scripts/backup.mjs create codex-backup-check-20261126`, followed by `node scripts/backup.mjs verify codex-backup-check-20261126`.
- **Result:** create and independent verification passed for 212 files, including the custom-format database archive and the configured local upload directory. The archive remains in ignored `.backups/codex-backup-check-20261126` as a local verification artifact.
- **No-overwrite check:** a second create attempt with the same name exited before dumping and explicitly refused the existing destination; the original manifest still verified.
- **Limit:** this did not quiesce the application or validate a maintenance-window restore; it is only isolated command and manifest verification evidence.

## Restore drill log

- **Date:** 2026-11-24
- **Source:** disposable local PostgreSQL database `nri_test`; the smoke API process was stopped before capture.
- **Target:** newly created isolated database `nri_restore_20261124195326_8f271f`. The source and existing demo database were not modified.
- **Archive:** PostgreSQL custom dump plus the local uploads directory; a 54-file SHA-256 manifest was generated and verified before restore.
- **Restore:** `pg_restore --exit-on-error --single-transaction --no-owner --no-privileges` into the new empty target.
- **Counts matched (source, restored):** users 20, campaigns 5, memberships 11, scenes 10, assets 10, tokens 50, scene objects 30, chat messages 5, dice rolls 9, initiative trackers 5, initiative entries 10.
- **Media:** all 10 asset references in the restored test DB resolved to copied files whose SHA-256 values matched the database checksums.
- **Limit:** this verifies a local isolated restore, not a production backup schedule or a full maintenance-window drill. The development API remained available during capture, so the operational quiescence procedure has not been exercised end to end.

The release remains `IN_PROGRESS`; do not mark `ACCEPTED` based on this drill alone.

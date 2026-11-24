# PostgreSQL and media backup / restore

**Status:** `IN_PROGRESS` — isolated `nri_test` restore drill passed; coordinated production backup automation and scheduled restore validation remain open.

## What must be captured

Campaign records and uploaded media form one recoverable set. A database dump without the matching `UPLOAD_DIR` contents can leave asset rows pointing at missing files. A media archive without the database cannot restore campaign permissions or references.

For a coherent maintenance backup:

1. Put the server into maintenance by stopping new writes and draining existing requests. Keep PostgreSQL and its persistent volume running.
2. Record the database and media directory names from the active deployment configuration. Never substitute the example development credentials for production configuration.
3. Dump PostgreSQL in custom format. Copy the complete configured `UPLOAD_DIR` to a new, empty staging directory.
4. Create a manifest containing creation time, database name, application revision, archive filenames, byte sizes, and SHA-256 checksums. Do not include credentials.
5. Verify each checksum before publishing the backup directory. Use a new timestamped destination; refuse to overwrite an existing backup.
6. Resume writes only after both the dump and media copy pass verification.

Example for the repository's Docker Compose development database (run from the repository root; use a unique destination):

```powershell
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$destination = Join-Path '.backups' "nri-$stamp"
$staging = "$destination.incomplete"
if ((Test-Path -LiteralPath $destination) -or (Test-Path -LiteralPath $staging)) { throw "Backup destination already exists: $destination" }
New-Item -ItemType Directory -Path $staging | Out-Null
docker compose exec -T db pg_dump -Fc -U nri_dev -d nri_dev --file=/tmp/nri.dump
docker compose cp db:/tmp/nri.dump (Join-Path $staging 'database.dump')
docker compose exec -T db rm -f /tmp/nri.dump
Copy-Item -LiteralPath '.data/uploads' -Destination (Join-Path $staging 'uploads') -Recurse
$root = (Resolve-Path -LiteralPath $staging).Path
$files = Get-ChildItem -LiteralPath $staging -File -Recurse | ForEach-Object {
  [ordered]@{
    path = $_.FullName.Substring($root.Length + 1).Replace('\', '/')
    bytes = $_.Length
    sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}
$manifestPath = Join-Path $staging 'manifest.json'
[ordered]@{ createdUtc = (Get-Date).ToUniversalTime().ToString('o'); database = 'nri_dev'; revision = (git rev-parse HEAD); files = $files } |
  ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 -LiteralPath $manifestPath
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
foreach ($file in $manifest.files) {
  $path = Join-Path $staging ($file.path.Replace('/', '\'))
  if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) { throw "Checksum mismatch: $($file.path)" }
}
Move-Item -LiteralPath $staging -Destination $destination
```

This example assumes API writes have been stopped before it runs. The database dump and media copy are not an atomic cross-system snapshot while uploads/deletions are in progress. The operator must keep the server quiesced until the copy and manifest verification finish. In production, use the deployment's real database role and media mount path.

## Safe restore

1. Verify the manifest and all archive checksums before restore.
2. Create a fresh, uniquely named restore database. If the name already exists, stop; never drop or overwrite it.
3. Restore the custom dump into that empty database with ownership and ACL restoration disabled unless the target environment explicitly requires them.
4. Restore media into a new empty directory and verify each file checksum. Point an isolated application process at this database and media directory.
5. Confirm row counts and sample references for users, campaigns, memberships, scenes, assets, tokens, scene objects, messages, dice rolls, and initiative.
6. Leave the source database, source media, and existing backups untouched until the isolated restore is accepted.

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

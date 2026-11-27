# PERF-GPU and operations acceptance handoff

**Status: PLANNED.** These are the remaining checks for the target deployment. Pick owners and record environment details before a run. Use disposable campaigns and encrypted, access-limited storage for diagnostics.

| Check | Procedure and required evidence | Dependency |
| --- | --- | --- |
| PERF-GPU | Run profiles A/B/C with real maps and textures for 30–60 minutes on a dedicated GPU and two client devices. Capture frame times, texture release on scene changes, resident memory and WebGL context loss recovery | Owner selects real devices and representative maps |
| OPS-DEPLOY | Verify closed HTTPS deployment, certificate and access rules, session/cookie and proxy settings, health checks, operational logs and memory limits | Owner selects infrastructure and private domain or network |
| OPS-RESTORE | Restore a disposable PostgreSQL backup and asset manifest into separate storage. Compare database counts, file hashes and protected reads from GM and player views | Target host, backup credentials, storage and recovery target agreed |
| OPS-RECOVERY | In a test environment rehearse database outage, network drop, API restart and reconnect. Capture process tree, readiness, port owner, exit codes, Socket.IO state and Windows diagnostics | Target network and an isolated Windows/Ubuntu setup |
| Retention and files | Verify logs and backups have an agreed expiry, schedule receipt pruning daily, and check orphan and staging files against the database and a quiesced window | Target host and deployment credentials |
| QA-OWNER | Two participants complete a real tabletop walkthrough using both GM and Player roles and record any usability and permission failures | Owner plus a player, real sessions and hardware |

## Daily REST receipt pruning

On the deployment host use the same scoped Compose project and private environment file as the API. The maintenance image includes the script. A daily systemd timer or equivalent host scheduler should run the command and retain only the exit code and total removed. Enable a persistent timer so missed runs are recovered on host startup. Run a first invocation manually on the approved target and verify the connection and count before enabling scheduling.

```sh
docker compose -f docker-compose.production.yml --profile maintenance run --rm migrate node scripts/prune-operation-receipts.mjs
```

For a source checkout with the selected database URL, use `pnpm --filter @nri/server db:prune-operation-receipts`. PostgreSQL supplies the expiry clock. The job deletes only expired receipts in bounded batches. Locked rows can be skipped and will be picked up in a later run. Chat, dice and game rows have their own retention. Deploying the timer is part of OPS-DEPLOY.

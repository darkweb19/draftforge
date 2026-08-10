# Upgrading projects

Installing a newer CLI does not rewrite existing projects. `status`, `doctor`,
and `handoff` may read a supported older state in memory, but only this command
persists a migration:

```bash
draftforge upgrade
```

Run it from the project root with no worker or reviewer in flight.

## Behavior

The command locks the project, reads the raw schema version, validates the full
candidate and managed paths, then creates a timestamped backup under
`.draftforge/backups/` before its first write. It writes recognized schemas,
then `SESSION.md`, then `.draftforge/state.json` last as the durable commit
marker.

Versions 1 and 2 can upgrade to version 3. Current state plus current schemas is
a no-op. Current state with recognized older schema bytes is refreshed with a
backup.

Exit `2` means refusal before mutation: future/malformed state, downgrade,
in-flight or uncertain work, live processes, modified/unrecognized managed
schemas, recovery artifacts, symlinks, or non-regular/escaped managed paths.
User-authored agent files, phase files, ideas, ADRs, tasks, local config, and run
evidence are never upgrade targets.

## Backup and manual recovery

`upgrade-manifest.json` lists `replaced` paths whose prior bytes are backed up
and `created` paths that did not exist. Exit `1` after backup means the upgrade
failed and prints the recovery directory. There is no automatic rollback.

Stop DraftForge processes, inspect the manifest, restore each `replaced` path
to its project-relative location, and remove each `created` path only after
confirming it still belongs to the failed attempt. Run `draftforge status`, fix
the original cause, and retry. Do not restore unlisted paths, delete all of
`.draftforge/`, or use a broad Git reset. If project files changed after the
failure, preserve and reconcile them instead of overwriting newer work.

See [Troubleshooting](TROUBLESHOOTING.md) for locks and retained worktrees.

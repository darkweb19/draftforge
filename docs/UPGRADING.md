# Upgrading a project

```bash
draftforge upgrade
```

`upgrade` takes no options. Passing any argument is a usage error and exits `2`.

## What it does, and what nothing else does

`draftforge upgrade` is the **only** command that persists a schema migration.

Ordinary reads — `status`, `doctor`, `handoff`, `plan`, `run`, `resume`,
`review` — will migrate a supported older state document *in memory* so they
keep working, but they never write that migration back. An implicit write during
a read would make `status` surprisingly destructive and would leave no
deliberate rollback point. Upgrading is therefore something you choose to do.

What `upgrade` touches:

- `.draftforge/state.json` — the canonical state document (only when the schema
  version actually changes).
- `SESSION.md` — re-rendered from the upgraded state.
- `.draftforge/schema/state.schema.json`, `config.schema.json`,
  `planning.schema.json`, `execution.schema.json` — refreshed to the versions
  shipped with the installed CLI, and only when their current bytes are
  recognizable as a previously shipped DraftForge artifact.

What it never touches: your source files, `idea.md`, `AGENTS.md`, `CLAUDE.md`,
`PHASES.md`, generated task contracts and decision records, run artifacts,
`.draftforge/config.json`, or `.draftforge/config.local.json`.

The whole operation runs under the project lock, so a concurrent `run`,
`resume`, or `review` waits rather than interleaving with it.

## Supported migrations

| From | To | Change |
| --- | --- | --- |
| state schema v1 | v3 | adds a nullable `attempt` and a nullable `review` to every task |
| state schema v2 | v3 | adds a nullable `review` to every task |
| state schema v3 | v3 | no state migration; schemas may still be refreshed |

The migration is deliberately narrow. It upgrades exactly the previously shipped
shapes, then hands the candidate to the strict domain validator. Anything else
is rejected before a single byte is written.

## Dispositions

### Already current — no-op

If nothing would change, the command reports it and writes nothing:

```text
Project is already current at schema version 3; no files changed.
```

Exit `0`. No backup directory is created for a no-op.

### Upgraded

```text
Upgraded project state from schema version 2 to 3.
Backup: .draftforge/backups/20260802T140355123Z-9f2c1ab4
Replaced: .draftforge/state.json, SESSION.md, .draftforge/schema/state.schema.json
Created: .draftforge/schema/execution.schema.json
```

Exit `0`.

When the state schema was already current but a managed schema file needed
refreshing, the first line reads instead:

```text
Refreshed recognized DraftForge schema files.
```

## Write order, and why a retry is safe

Replacements are written in a fixed order:

1. Recognized `.draftforge/schema/*.json` files
2. `SESSION.md`
3. `.draftforge/state.json` — **last**

The canonical state document's `schemaVersion` is the durable commit marker.
Writing it last means that if an earlier write fails, the project's recorded
schema version is still the old one. A later explicit retry therefore re-plans
the entire upgrade from scratch instead of observing a half-written project and
reporting a false "already current".

Do not reorder this by hand, and do not edit `schemaVersion` in
`.draftforge/state.json` to make a failed upgrade look finished.

Every individual write is also re-validated immediately before it happens: the
target's parent must still be a real directory, the target must still exist (or
still be absent) exactly as planning observed, and its current bytes must match
the bytes planning read. Anything that drifted between planning and writing
aborts the upgrade.

## Backups and the upgrade manifest

Before any target is mutated, `upgrade` copies every file it is about to
*replace* into a fresh timestamped directory:

```text
.draftforge/backups/<timestamp>-<random>/
  .draftforge/state.json
  SESSION.md
  .draftforge/schema/state.schema.json
  upgrade-manifest.json
```

The directory name is created exclusively — a name collision fails before target
mutation rather than overwriting recovery evidence. If the backup cannot be
completed, nothing is mutated at all.

`upgrade-manifest.json`:

```json
{
  "schemaVersion": 1,
  "createdAt": "2026-08-02T14:03:55.123Z",
  "replaced": [
    ".draftforge/state.json",
    "SESSION.md",
    ".draftforge/schema/state.schema.json"
  ],
  "created": [
    ".draftforge/schema/execution.schema.json"
  ]
}
```

- `replaced` — files that existed before and whose prior contents are stored in
  this backup directory at the same relative path.
- `created` — files that did **not** exist before. There is nothing to restore
  for these; recovery deletes them.

`.draftforge/backups/` is a local recovery directory. This repository ignores
it; add it to your own project's `.gitignore` too (`init` does not write one).
Backups are never pruned automatically — delete old ones yourself once you are
satisfied with an upgrade.

## Refusals — exit `2`, no backup or target write

A refusal is a precondition you have to clear. It happens before any backup or
target write, so the project is untouched and there is nothing to recover.

**In-flight, live, or uncertain work.**

- A task is `active` or `review`.
- An attempt manifest under `.draftforge/runs/` is not terminal (anything other
  than `blocked` or `integrated`).
- A reviewer lease artifact (`*.review-lease.json`) is still present.
- An attempt's event log records an uncertain worker termination whose process
  is still alive, or whose liveness cannot be determined.

Finish, resume, or block the work first: `draftforge resume`, then
`draftforge review`, then `draftforge status` to confirm nothing is in flight.

**A future schema version.**

```text
Project state schema version 4 is newer than this DraftForge installation (3);
upgrade this CLI instead.
```

The project was last touched by a newer DraftForge. Install a newer CLI; this
one will not downgrade your project. A schema version below `1`, or a state
document with no integer `schemaVersion`, is refused for the same reason —
this installation cannot safely interpret it.

**A user-modified managed schema file.**

```text
Refusing to overwrite modified or unrecognized DraftForge schema:
.draftforge/schema/state.schema.json. Restore a shipped schema or preserve your
change before upgrading.
```

A managed schema is refreshed only when its current bytes are byte-identical to
the installed template or hash-match a previously shipped DraftForge artifact.
If you edited one, either restore the shipped file or move your change
somewhere else, then re-run.

**Symlinked or non-regular managed paths.** Every managed path — `.draftforge`,
`.draftforge/schema`, `.draftforge/backups`, `.draftforge/state.json`,
`SESSION.md`, each managed schema — must be a real directory or a real regular
file. A symbolic link or any other file type is refused rather than followed,
so an upgrade can never be redirected into writing outside the project. The
project root itself is canonicalized once, deliberately, so you may point the
command at a symlinked project root; nothing below it may be a link.

**Orphaned or malformed recovery artifacts.** Under
`.draftforge/runs/<run-id>/attempts/`, an artifact whose manifest is missing or
invalid, a malformed event log, a malformed integration-intent file, a
non-terminal integration intent, or a run/attempt entry that is not a real
directory/regular file all refuse the upgrade. Inspect and clean up the run
directory, or resolve the attempt, before upgrading.

Any option passed to `upgrade` is also a refusal:

```text
upgrade does not accept options.
```

## Operational failures — exit `1`

Exit `1` has two distinct forms. Read the error before deciding whether recovery
is required.

### Backup creation did not complete — no target was mutated

DraftForge must finish copying every replacement and writing
`upgrade-manifest.json` before it mutates a managed target. If that backup step
fails, the command reports:

```text
Unable to create a complete upgrade backup at
.draftforge/backups/<timestamp>-<random>: <cause>
```

Exit `1`. No managed target was changed, so there is no replacement to restore.
The named directory may contain an incomplete backup and is **not** a usable
recovery point without a complete `upgrade-manifest.json`. Fix the underlying
storage or permission problem, inspect the incomplete directory, and retry the
upgrade; do not follow the restore procedure below with an incomplete backup.

### Failure after a complete backup — manual recovery required

After DraftForge has copied every replacement and written the complete
`upgrade-manifest.json`, it begins checking and writing targets in the fixed
order above. A target check or write failure in this phase is reported as an
`UpgradeRecoveryError`:

```text
Upgrade did not complete. Restore replaced files from
.draftforge/backups/<timestamp>-<random> and remove files listed as created in
.draftforge/backups/<timestamp>-<random>/upgrade-manifest.json before retrying: <cause>
```

Exit `1`. Treat the managed targets as potentially partial: the failed check may
have happened before its target changed, but earlier targets in the write order
may already have been replaced. **DraftForge does not roll back automatically,
and it never will.** Use the complete backup and manifest for the operator-driven
manual recovery procedure below — the same principle as integration rollback,
which is also manual.

Post-plan drift is in this category. Each managed target is checked immediately
before its write. If a target appeared, disappeared, or changed after planning,
the command preserves those unexpected bytes, throws `UpgradeRecoveryError`, and
exits `1`. Earlier targets in the fixed write order may already have changed, so
use the complete backup and manifest instead of treating drift as an exit-2
refusal.

### Manual recovery procedure

Let `BACKUP=.draftforge/backups/<timestamp>-<random>` from the error message.

1. Read the manifest and note both lists:

   ```bash
   cat "$BACKUP/upgrade-manifest.json"
   ```

2. Restore **every** path in `replaced` from the backup, preserving relative
   paths. Each backed-up file sits at the same relative path inside `$BACKUP`:

   ```bash
   cp "$BACKUP/.draftforge/state.json" .draftforge/state.json
   cp "$BACKUP/SESSION.md" SESSION.md
   cp "$BACKUP/.draftforge/schema/state.schema.json" .draftforge/schema/state.schema.json
   ```

3. Delete **every** path in `created`. These did not exist before the upgrade:

   ```bash
   rm .draftforge/schema/execution.schema.json
   ```

4. Confirm the project reads cleanly again:

   ```bash
   draftforge status
   ```

5. Fix whatever caused the original failure — the cause is in the error message
   (commonly a full disk, a permission problem, or a file changed underneath the
   command) — then retry:

   ```bash
   draftforge upgrade
   ```

   Because canonical state was written last, the retry re-plans the whole
   upgrade rather than mistaking the partial result for a completed one.

Keep the backup directory until the retry succeeds and `draftforge status`
reports `state`, `config`, and `handoff` all passing.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Upgraded, or already current (no-op). |
| `2` | Pre-write refusal. No backup or managed target was written; clear the precondition. |
| `1` | Operational failure. A complete backup means target processing began and requires manual recovery; an incomplete backup means no managed target was mutated, so fix the backup failure and retry without target recovery. |

## After upgrading

```bash
draftforge status
```

All three project health checks should pass. If `handoff` reports drift, run
`draftforge handoff` to re-render `SESSION.md` from canonical state — canonical
JSON always wins over the generated Markdown.

Commit the upgraded `.draftforge/state.json`, `SESSION.md`, and refreshed
`.draftforge/schema/*.json` together. Do not commit `.draftforge/backups/`.

## Related documentation

- [INSTALLATION.md](INSTALLATION.md) — installing a newer CLI
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — in-flight work, locks, and worktrees
- [PROTOCOL.md](PROTOCOL.md) — attempt lifecycles and safe resume
- [decisions/0011-release-artifact-upgrades-and-provenance.md](decisions/0011-release-artifact-upgrades-and-provenance.md)

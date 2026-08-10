# Troubleshooting

Start in the project root with `draftforge doctor` and `draftforge status`.
Doctor reports `PASS`, `MISSING`, or `FAIL` without credential values or raw
authentication output.

## Authentication

- Codex: ensure `codex` is on `PATH`; run `codex login status`.
- Claude Code: ensure `claude` is on `PATH`; run `claude auth status`.
- API: inject `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` into the current process.
  Do not put the value in config or diagnostics. Doctor checks presence only;
  provider access and model permissions can still fail later.

API adapters are text-only. Set `roles.worker.adapter` to `codex-cli` or
`claude-cli`; otherwise `run`/`resume` exits `2` before state changes.

## Dirty-root integration refusal

Integration requires a clean root. Commit or otherwise resolve intentional
changes, then rerun `draftforge review`. DraftForge never stashes or resets
them. The attempt worktree and rollback point remain available.

## Retained worktrees and resume

Inspect `.draftforge/runs/<run-id>/` and IDs printed by status. Interrupted work
stays in the same worktree. Run `draftforge resume --by operator`; it reconciles
or continues existing attempts and claims no new task. If termination is
uncertain, verify the recorded process is gone before retrying.

## Lock recovery

Concurrent writers wait for a bounded period. Stale locks are recovered only
when liveness is disproved. If `.draftforge/state.lock.recovery` remains after a
crash, first prove no DraftForge process is running. Preserve it for diagnosis;
do not delete locks merely to make a command pass.

## Blocked tasks

Read task status, failure classification, result, and machine evidence.
Verification failures and review rejections may repair within the configured
limit. Scope/secret/contract violations, uncertain timeouts, and integration
conflicts require human inspection. Automation cannot reopen blocked work; do
not hand-edit canonical state.

## Windows command shims

npm and harnesses commonly expose `.cmd`/`.bat` shims. Ensure the npm global bin
and real `codex`/`claude` shim are on `PATH`, open a new terminal, and rerun
doctor. DraftForge invokes shims through escaped `cmd.exe`; never place prompts
or secrets on a command line as a workaround.

## Package installation and PATH

Run `node --version`, `npm list --global --depth=0`, and
`draftforge --version`. Node must be 22+. The public unscoped npm package is
unrelated; use this repository's verified tarball. Locate stale executables with
`where.exe draftforge` on Windows or `which draftforge` on macOS/Linux, then fix
the installation or PATH. Do not delete an unresolved directory.

## Upgrades and safe evidence

Upgrade refusal before backup exits `2` without mutation. Failure after backup
exits `1`; follow [manual recovery](UPGRADING.md#backup-and-manual-recovery).

Record only versions, OS, failing command, redacted output, relevant IDs/status,
locator-only findings, and a synthetic reproduction. Never attach environment
dumps, `.env`, local config, keys, auth caches, raw provider output, entire
worktrees, or unrelated source. Use [private reporting](../SECURITY.md) for a
vulnerability.

# Troubleshooting

Each section is one symptom, its cause, and the fix. Start with:

```bash
draftforge --version
draftforge status
draftforge doctor
```

`status` validates canonical state, configuration, and `SESSION.md`. `doctor`
adds Git plus the adapters behind each configured role. Neither prints a secret
value.

---

## Harness authentication is missing

**Symptom**

```text
[MISSING] worker adapter (claude-cli): command not found on PATH; authentication is missing
[MISSING] architect adapter (codex-cli): command available; authentication is missing
```

Or, at call time:

```text
Required local command "claude" was not found. Install it and authenticate locally.
```

**Cause** — the harness CLI is not installed, is not on `PATH`, or has no
active local login. `doctor` reports both conditions as `missing` and still
exits `0`; `missing` is unfinished setup, not a failure.

**Fix**

- `codex-cli`: install Codex CLI, then `codex login` (ChatGPT subscription
  sign-in is supported). Verify with `codex login status` — that is exactly the
  probe `doctor` runs.
- `claude-cli`: install Claude Code, then complete its login flow. Verify with
  `claude auth status` — the probe `doctor` runs.
- Confirm the command resolves in the same shell that runs `draftforge`:
  `which codex` / `which claude` (POSIX) or `where.exe codex` (Windows).

Then re-run `draftforge doctor`.

---

## API key not set

**Symptom**

```text
[MISSING] reviewer adapter (anthropic-api): ANTHROPIC_API_KEY is not set; authentication is missing
```

Or, at call time:

```text
Missing ANTHROPIC_API_KEY; set it in the environment to use the Anthropic API adapter.
```

**Cause** — the API adapter reads its key from the process environment only.
There is no configuration field for a key, and the strict config validator
rejects unknown properties, so a key cannot be stored in
`.draftforge/config.json`.

**Fix** — export `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in the shell that runs
`draftforge`, then re-run `draftforge doctor`. A `pass` here only means the
variable is present; it is not network-verified.

Do not echo, print, or paste a key value anywhere. Check presence without
revealing the value:

```bash
# prints "set" or "unset" — never the value
[ -n "${ANTHROPIC_API_KEY:-}" ] && echo set || echo unset
```

If the key is present but calls still fail, HTTP 401 and 403 are treated as
terminal authentication errors and are never retried; 429 and 5xx are retried
as transient. A persistent 401 means the key is wrong or revoked, not that
DraftForge failed to send it.

---

## An API adapter is configured as the worker

**Symptom** — `run` or `resume` exits `2` immediately, before anything happens:

```text
The configured worker route is text-only or does not declare workspace access.
Select a workspace-capable codex-cli or claude-cli worker before claiming a task.
```

**Cause** — `openai-api` and `anthropic-api` are text-only. They cannot execute
in the attempt's Git worktree, so they cannot make the changes a worker result
would claim. The refusal happens before any task is claimed.

**Fix** — set `roles.worker.adapter` to `codex-cli` or `claude-cli`. Architect
and reviewer may stay on API adapters. See
[PROVIDERS.md](PROVIDERS.md#workspace-capable-versus-text-only). Nothing needs
cleaning up: exit `2` means state was never touched.

---

## A dirty project root defers integration instead of merging

**Symptom** — `draftforge review` runs the machine checks and the reviewer, but
the task does not reach `done`. Integration aborts and the task blocks, with the
attempt worktree retained.

**Cause** — acceptance requires a clean project working tree. Before merging,
DraftForge re-checks scope and secrets, records the project branch head as a
rollback point, and merges the attempt branch. With uncommitted local edits in
the project root it will not proceed.

**This is deliberate. Do not work around it by stashing.** DraftForge will not
stash-and-merge, and you should not either: a stash-and-merge can silently
combine reviewed work with unreviewed local edits, and a conflict during the
unstash leaves no clean rollback point.

**Fix** — resolve your own working tree first:

```bash
git status --short
```

Commit your local changes on their own, or move them to a separate branch, until
`git status --short` is empty. Then re-run:

```bash
draftforge review --by <actor>
```

If the merge itself conflicts, integration aborts, the worktree is retained, and
the task blocks. Rollback is never automatic: after inspecting, an operator may
choose to revert the recorded integration commit or reset to the recorded
rollback point. `draftforge status` prints both:

```text
Integration T01: rollback=<commit>, commit=<commit-or-none>
```

---

## Worktrees are still there under `.draftforge/runs/`

**Symptom** — `.draftforge/runs/<run-id>/worktrees/<task-id>` directories
accumulate and are not cleaned up.

**Cause** — this is intended. Cleanup is conservative because completion is
often uncertain. An interrupted, timed-out, blocked, or scope-violating attempt
keeps its worktree for inspection and for an explicit resume, and a worktree
tied to a live or indeterminate worker process is never reused by another
worker. Resume reuses the same attempt identity and the same worktree rather
than creating a second attempt for the same work.

**Fix** — most of the time, no fix; continue the work:

```bash
draftforge resume --by <actor>   # continue interrupted attempts only
draftforge status                # see what each task is waiting on
```

`run` reports an interrupted attempt as `in-flight` and leaves it alone; only
`resume` re-dispatches it. An unfinished attempt counts as occupied capacity
against `roles.worker.maxConcurrency` until `resume` continues it.

Read the retained evidence before deciding anything:

```text
.draftforge/runs/<run-id>/attempts/<attempt-id>.json         manifest
.draftforge/runs/<run-id>/attempts/<attempt-id>.result.json  validated outcome
.draftforge/runs/<run-id>/attempts/<attempt-id>.events.jsonl attempt events
.draftforge/runs/<run-id>/events.jsonl                       run-scoped transitions
```

All of it is secret-redacted; raw model text and provider error causes are never
written.

If `run`/`resume` reports `unreconciled` or an orphan attempt, DraftForge is
refusing to guess — for example a result event with no result artifact, or a
manifest in `claimed`/`running` that no task owns. Inspect the listed attempt
manually; do not delete a worktree to make the report go away, and note that
orphaned or malformed recovery artifacts also refuse `draftforge upgrade`.

---

## A command seems to hang, or times out on the project lock

**Symptom**

```text
Timed out after 30000ms waiting for the project lock (operation: <name>).
Another DraftForge process is holding it.
```

**Cause** — filesystem transitions take an exclusive project lock. Contending
commands **wait** with a bounded retry rather than being refused, so a second
`run`, `resume`, `review`, or `upgrade` serializes behind the first. The default
wait budget is 30 seconds. The lock is never held across a worktree operation,
verification command, secret scan, model call, or merge — so a long model call
never blocks another command on the lock.

**Fix** — check whether another DraftForge process is genuinely running, and let
it finish. A short pause during a transition is normal. If the timeout is
reported and nothing is running, a stale lock is detected and broken
automatically on the next attempt.

**Stale-lock recovery note.** While a stale lock is being reclaimed, DraftForge
holds `.draftforge/state.lock.recovery`. If a process crashed during that brief
window, that file can be left behind and every subsequent command will keep
waiting. Before removing it, **verify no DraftForge process is running** — then:

```bash
rm .draftforge/state.lock.recovery
```

Removing it while another process is mid-recovery can corrupt state. Never
delete `.draftforge/state.lock` or `.draftforge/state.lock.recovery` as a
reflex.

---

## A task is blocked and nothing will move it

**Symptom** — `status` or a `run`/`resume` summary lists a task as `blocked`,
and re-running does nothing. Exit code `1`.

**Cause** — blocking is terminal for automation. A detected secret, scope
violation, contract violation, timeout, malformed review envelope, or
integration conflict blocks on first occurrence. Only `verification-failure`
and `review-rejection` are repairable, and repairs are capped by
`limits.maxRepairAttempts`; once exhausted the task stays blocked.

**`blocked -> ready` requires a human actor.** Automation calling that
transition throws — it is not a permission you can configure away. Reopening
blocked work is an explicit human decision.

**Fix**

1. Read why it blocked:

   ```bash
   draftforge status
   ```

   `status` prints each task's repair counter and last classification:

   ```text
   Review T01: repairs=2, classification=verification-failure
   ```

2. Read the attempt's result artifact under `.draftforge/runs/` for the
   authoritative changed paths, scope violations, and failure classification.
   For a secret finding, the record is a locator only — rule id, path, line —
   never the value or surrounding text. Go look at that line yourself.
3. Fix the underlying cause (rotate and remove the credential, correct the
   scope, fix the verification command in the task contract).
4. Reopen deliberately as a human, or start a recorded plan revision:

   ```bash
   draftforge plan --revise --reason "<why>" --by <actor> --reopen <task-id>
   ```

A successor task also stays blocked while its predecessor is `active` or
`review`; only an accepted `done` predecessor releases it. That is not a bug —
check the predecessor before investigating the successor.

---

## Windows: `draftforge` or a harness is not found

**Symptom** — `'draftforge' is not recognized as an internal or external
command`, or a harness adapter reports the command was not found even though it
is installed.

**Cause** — npm installs Node CLIs on Windows as a `.cmd` shim, not a native
executable. The installed entry point is `draftforge.cmd` in the npm prefix
(global install) or in `node_modules\.bin\` (project install). The same is true
of npm-installed harnesses such as `claude`.

**Fix**

```powershell
where.exe draftforge
npm config get prefix
```

If nothing is found, the npm prefix directory is not on `PATH`; add it and open
a new shell. For a project-local install, call it through npm:

```powershell
npx draftforge --version
```

DraftForge handles harness shims itself: it resolves commands with `where.exe`,
preserves PATH order, ignores unsupported extensionless aliases, spawns real
executables directly, and invokes a `.cmd`/`.bat` match through an explicitly
escaped `cmd.exe` boundary. Prompt content always travels on stdin, never as a
command-line argument. If a harness works from your shell but not from
DraftForge, capture the output of `where.exe <command>` — PATH order is the
usual cause.

---

## Package installation problems

**`draftforge --version` prints an unexpected version.**
`package.json` is the sole version authority; runtime output must match the
package you installed. A mismatch means a different installation is winning on
`PATH`. Locate it:

```bash
which -a draftforge     # POSIX
where.exe draftforge    # Windows
npm ls -g --depth=0
```

Uninstall the stale one, or call the project-local binary through `npx`.

**`npm install -g` fails with a permission error.** Do not re-run with `sudo`.
Set a user-writable npm prefix instead, or use a Node version manager, then
reinstall.

**You installed the wrong package.** The unscoped `draftforge` package on the
public npm registry is an **unrelated third-party package**. This CLI is not
published yet; the scoped name `@your-scope/draftforge` is a placeholder locked
in P06-T04. If you installed the registry package, remove it:

```bash
npm uninstall -g draftforge
```

and install from a local tarball instead — see
[INSTALLATION.md](INSTALLATION.md).

**The installed binary exits `0` without doing anything.** That was a real
packaging defect: the entry guard compared the `.bin` symlink URL with the
resolved module URL, so the linked executable ran nothing. It is fixed and
regression-tested through the installed binary. If you see it, you are running
a stale artifact — repack and reinstall:

```bash
npm run check
npm pack
npm run package:smoke -- ./draftforge-<version>.tgz
npm install -g ./draftforge-<version>.tgz
```

**The tarball contains unexpected files, or smoke fails.** `package:smoke`
audits the tarball against the current clean `dist/` and `templates/` file set,
then installs and drives the installed binary. Build before packing, and never
substitute or rebuild the artifact between the audit and the install.

---

## Node.js version problems

**Symptom** — syntax errors, unsupported-API errors, or a startup crash.

**Cause** — two different floors, easy to conflate:

- The installed CLI requires **Node.js 22 or newer** (`engines.node: ">=22"`).
- Developing this repository uses **Node.js 24** (`.nvmrc`).

**Fix** — `node --version`. For running the installed CLI, anything 22+ is
supported. For building from the checkout, switch to the `.nvmrc` version
(`nvm use`) before `npm install` and `npm run check`.

---

## `SESSION.md` has drifted

**Symptom**

```text
[FAIL] handoff: SESSION.md has drifted; run `draftforge handoff`
```

**Cause** — `SESSION.md` is generated from `.draftforge/state.json` and was
edited by hand, or a write was interrupted. Canonical JSON always wins.

**Fix**

```bash
draftforge handoff
```

That re-renders `SESSION.md` from canonical state. Never hand-edit it.

---

## Collecting evidence for a bug report — safely

Everything below is safe to paste into a report. Run it from the project root.

```bash
draftforge --version
node --version
npm --version
git --version
```

```bash
draftforge doctor
```

`doctor` prints only a status and a fixed description per check. It never prints
an environment value and never prints the harness authentication command's
stdout or stderr.

```bash
draftforge status
```

```bash
git status --short
```

```bash
# operating system / architecture
node -p "[process.platform, process.arch, process.version].join(' ')"
```

```bash
# the shape of the run directory — names only, no file contents
ls -R .draftforge/runs
```

Your configuration is safe to share, because it cannot contain a secret — there
is no key field and unknown properties are rejected:

```bash
cat .draftforge/config.json
```

If you use a local override, share it too, after reading it yourself:

```bash
cat .draftforge/config.local.json
```

### What to exclude

Never include any of the following in a report, an issue, a log paste, or a
prompt:

- The value of `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or any other credential.
- The contents of `.env` or any `.env.*` file other than `.env.example`.
- Full environment dumps — do not run `env`, `printenv`, `set`, or
  `node -p "process.env"`. They print every secret you have exported.
- Harness credential files or login token stores from Codex CLI or Claude Code.
- Raw provider request or response bodies captured outside DraftForge.
- The contents of a file that a secret-scan finding pointed at. A finding is a
  locator (rule id, path, line number) precisely so the value never travels;
  quote the locator, not the line.
- Any command whose output would print a secret — including a check that echoes
  a variable back. Report presence as "set"/"unset", never the value.

DraftForge's own artifacts are already redacted: run events, attempt manifests,
result artifacts, and surfaced adapter errors are scrubbed, raw model text and
provider error causes are never persisted, and prompts, completions, and
credentials never enter the usage ledger. Still read anything before you paste
it — an evidence file can quote *your project's* source, which is yours to
protect.

If you believe you have found a security issue rather than a bug, follow the
private reporting path in [../SECURITY.md](../SECURITY.md) instead of opening a
public issue.

---

## Related documentation

- [INSTALLATION.md](INSTALLATION.md) — requirements, install, verify, uninstall
- [PROVIDERS.md](PROVIDERS.md) — adapters, routing, and `doctor` output
- [UPGRADING.md](UPGRADING.md) — upgrade refusals and manual recovery
- [EXAMPLE.md](EXAMPLE.md) — a complete local run
- [PROTOCOL.md](PROTOCOL.md) — states, attempts, resume, and exit codes
- [ARCHITECTURE.md](ARCHITECTURE.md) — layering and boundaries

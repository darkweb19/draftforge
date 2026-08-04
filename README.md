# DraftForge

DraftForge is a local-first CLI that turns a rough Markdown idea into recorded
architecture decisions, an approved task graph, isolated worker execution, and
machine-first review.

> **Release status:** this repository is an unpublished Phase 6 release
> candidate. Phases 0 through 5 and the package/upgrade foundations (P06-T01 and
> P06-T02) are complete. Documentation, cross-platform release evidence, and
> publication are still in progress.

## Install the current release candidate

Requirements: Node.js 22 or newer and Git. Windows, macOS, and Linux are the
release targets; the final three-platform installed-tarball gate has not passed
yet.

The package is still private while an owned npm scope is selected. The unscoped
`draftforge` package on npm belongs to an unrelated project, so do not install
it. Build and verify this repository's tarball instead:

```bash
npm install
npm run package:pack
npm run package:smoke -- ./draftforge-0.0.0.tgz
npm install --global ./draftforge-0.0.0.tgz
draftforge --version
```

The tarball name follows the version in `package.json`. `package:smoke` installs
that exact artifact in a clean temporary project and exercises the npm-generated
binary without a provider or network call.

## Shortest working flow

These are installed-CLI commands. The generated configuration defaults to
Codex CLI for the architect and reviewer and Claude Code for the workspace
worker.

```bash
draftforge init my-app
cd my-app
# Describe the project in idea.md.
draftforge doctor
draftforge plan idea.md
draftforge plan --run
draftforge plan --answer <id>=<text>
draftforge plan --run
draftforge plan --approve --by <actor>
draftforge run --by <actor>
draftforge review --by <actor>
```

The first architect turn returns one batch of questions. Record every blocking
answer, then run the architect again for the plan. Approval materializes the
ADRs, phases, and bounded task contracts. `run` sends ready work to isolated Git
worktrees; `review` runs verification, scope and secret checks, independent
review, bounded repair, and integration. Use `draftforge resume` only for an
interrupted attempt; it does not claim new work.

## Command reference

```text
draftforge --version
draftforge init [directory] [--name <name>] [--force]
draftforge doctor
draftforge status
draftforge plan <idea.md>
draftforge plan --status
draftforge plan --prompt
draftforge plan --run
draftforge plan --submit <response.json>
draftforge plan --answer <id>=<text>
draftforge plan --approve --by <actor>
draftforge plan --revise --reason <text> --by <actor> [--reopen <id>] [--retire <id>]
draftforge run [--by <actor>]
draftforge resume [--by <actor>]
draftforge review [--by <actor>]
draftforge upgrade
draftforge handoff
```

`plan <idea.md>` initializes or resumes `.draftforge/planning.json` without
calling a provider. `plan --run` invokes the configured architect. To use an
external model or inspect every checkpoint, drive the provider-neutral loop
manually:

```text
draftforge plan --prompt
draftforge plan --submit questions.json
draftforge plan --answer <id>=<text>
draftforge plan --prompt
draftforge plan --submit plan.json
draftforge plan --approve --by <actor>
```

Alternatively, `draftforge plan --run` drives exactly one architect turn
through the adapter configured for the architect role and records its response.
Run it once for the question batch, record answers, then run it once for the
draft plan. The manual `--prompt` and `--submit` checkpoints remain unchanged.

The architect returns one JSON envelope per turn — `{"kind":"questions",…}` or
`{"kind":"plan",…}` — and the expected kind is derived from planning state, so an
off-stage or malformed response is rejected rather than partially applied. Phase 3
adapters produce the same envelope through the model-runner port. `plan --approve`
materializes the accepted phases, ADRs, and task files before making active phase
roots runnable.

An approved plan then changes only through a recorded revision:

```text
draftforge plan --revise --reason "Reporting must export CSV" --by sujan
draftforge plan --prompt                    # the revision restates its questions
draftforge plan --submit questions-r2.json  # recorded answers carry forward
draftforge plan --answer Q3="Yes, CSV and text"
draftforge plan --submit plan-r2.json
draftforge plan --approve --by sujan
```

`--revise` records the reason, actor, and predecessor revision, and withdraws
readiness the superseded plan justified before anything else changes. Approving
the revision keeps recorded progress: `done` stays `done` unless `--reopen`
names it, in-flight tasks keep their status, and dropping a started or completed
task is rejected unless `--retire` names it. Re-materialization rewrites only
files DraftForge generated; an edited ADR or task contract blocks approval
instead of being overwritten. A revision is never approved implicitly.

`status` validates canonical state, the discovered configuration, and `SESSION.md`.
`doctor` reports those project checks plus availability and authentication for
each configured role adapter. Missing commands, local logins, and API-key
variables are reported as `missing` and do not fail the command; invalid
configuration or an authentication-status probe error returns a non-zero exit.
Secret values and authentication command output are never printed.

## Delegated execution

```text
draftforge run       # reconcile, claim ready non-conflicting tasks, execute them
draftforge resume    # reconcile and continue interrupted attempts only
draftforge review    # run machine checks, independent review, repair, and integration
```

`run` recomputes readiness, claims up to `roles.worker.maxConcurrency` tasks
whose dependencies are done and whose owned paths do not overlap any active
task, and executes them concurrently. The project lock is held only to claim, to
finalize a result, and to render the handoff — never during a worktree or model
operation.

**Worktree retention.** Each attempt gets a deterministic Git worktree at
`.draftforge/runs/<run-id>/worktrees/<task-id>`. Cleanup is conservative:
interrupted, timed-out, blocked, and scope-violating attempts keep their
worktree for inspection and explicit resume, and a worktree tied to a live or
indeterminate worker process is never reused by another worker.

**Attempt evidence.** Every attempt records a manifest (task, contract hash,
base commit, workspace identity, lifecycle, budget), an attempt event log, and a
validated result artifact holding the authoritative changed paths, scope
violations, and failure classification. All of it is secret-redacted; raw model
text and provider error causes are never persisted. Scope is enforced from a
content-derived diff of the worktree, not from the paths the worker reports.

**Capability limits.** Only workspace-capable harness routes (`codex-cli`,
`claude-cli`) can run workers. An API-backed worker route is refused before any
task state changes, because a text-only transport cannot make the changes it
would claim. An unapproved plan is refused the same way. Both refusals exit `2`
and leave the project untouched.

**Review handoff.** A worker result advances a task only to `review`. Nothing in
`run` or `resume` marks a task `done`; acceptance is an independent reviewer
decision, and a successor stays blocked while its predecessor is `active` or
`review`.

**Safe resume.** `resume` reconciles manifests, worktrees, result artifacts,
events, and canonical state before doing anything else. A persisted valid result
is finalized to `review` or `blocked` *without another model call*; an
interrupted attempt is re-dispatched under its own identity into its own
worktree; `review` and `done` tasks are never redispatched. Acceptance is never
inferred from an event alone — a result event with no result artifact is
reported for inspection instead of being accepted or repeated. Reconciliation is
idempotent, so running it again changes nothing.

`run` and `resume` print one labelled line per outcome class — dispatched,
resumed, reconciled, deferred (with a per-task reason), review-ready, blocked,
orphan attempts, and no-work. Exit `0` means nothing failed, `1` means a task is
blocked or an attempt needs manual inspection, and `2` means the command was
refused before touching state.

## Machine-first review and recovery

`draftforge review` is the only command that can complete a task. It runs the
task contract's verification commands in the retained attempt worktree, checks
the authoritative Git-derived changed paths against the owned paths, scans the
diff and untracked candidate files for secrets, and then asks the independent
reviewer for one strict verdict envelope. A reviewer can reject passing work;
it cannot accept a failed machine check.

Verification is intentionally narrow and shell-free: a task may declare only
`npm run <script>` or `node <relative-path>` with literal arguments. Commands
with a shell operator, redirection, traversal, absolute path, flag, or another
program are a `contract-violation`, not a skipped check. Verification receives
a minimal replacement environment, so provider credentials are not forwarded
to project commands.

The scanner records a locator only: rule ID, repository-relative path, and line
number. It never records the credential value, a substring, or surrounding line
content. A detected secret, scope violation, malformed review envelope, or
integration conflict blocks immediately and retains the worktree for inspection.

Only `verification-failure` and `review-rejection` are repairable. A repair
creates a new durable attempt, reuses the rejected worktree and branch history,
and carries only persisted actionable findings into the worker prompt. The
durable repair counter is capped by `limits.maxRepairAttempts`; once reached,
the task remains blocked until a human reopens it.

Accepted work is re-scanned and re-checked for scope, then merged from a clean
project root. DraftForge records the project branch head immediately before the
merge as the rollback point and records the integration commit only after a
successful merge. It never performs rollback automatically: after inspection,
an operator may choose to revert the recorded integration commit or reset to the
recorded rollback point. A dirty root or merge conflict aborts integration,
preserves the attempt worktree, and blocks the task rather than stashing or
overwriting local changes.

`status` reports each task's repair counter and classification, retained
integration rollback point/commit, and run usage totals. Usage is provider
reported only: harness calls and unpriced models show `unknown`; DraftForge
never estimates tokens or cost from prompt or completion length.

The project lock waits for a bounded interval when another DraftForge command
holds it. This serializes concurrent `run`, `resume`, and review transitions;
it does not hold the lock while a verification command, scan, model call, or
merge is running.

## Initializing a project

```bash
draftforge init my-app
```

`init` needs no provider, login, or API key. It writes canonical state, a default role
configuration, the JSON Schemas, shared harness instructions, and an `idea.md` draft:

```text
my-app/
  .draftforge/state.json     Canonical state (phase-00, no tasks yet)
  .draftforge/config.json    Role routes and limits
  .draftforge/schema/        State, configuration, and planning schemas
  .draftforge/tasks/         Task contracts, created during planning
  .draftforge/runs/          Redacted run events
  AGENTS.md CLAUDE.md PHASES.md SESSION.md idea.md
```

Conflict rules:

- A file that does not exist is created.
- A file whose content already matches is left alone, so re-running is idempotent.
- Any other existing file is reported as a conflict and **nothing is written**. Pass `--force` to approve overwriting.
- Once `.draftforge/state.json` is valid, `init` only restores missing files and never rewrites existing ones.

## Local state and configuration

Task changes follow the protocol state machine and are serialized with a project lock. Every
accepted transition appends a secret-redacted JSON event to
`.draftforge/runs/<run-id>/events.jsonl`, then atomically updates state and its generated handoff.

DraftForge loads `.draftforge/config.json` first and deeply applies the optional ignored
`.draftforge/config.local.json`. The merged result must match the shipped configuration schema;
errors identify the invalid file or field.

## Development

```bash
npm install
npm run check
npm run build
npm run dev -- status
```

Requires Node.js 24 or newer for development. The published CLI target is Node.js 22 or newer.

## Authentication modes

- Subscription mode invokes a locally installed, already authenticated harness such as Codex CLI or Claude Code.
- API mode invokes provider APIs with keys supplied through environment variables.
- DraftForge never stores secret values in project state or configuration.

For Codex, `codex login` supports ChatGPT subscription sign-in, and the adapter
uses `codex exec` non-interactively. The Claude Code adapter similarly uses
`claude --print`. Both send the system and user prompt through stdin instead of
process arguments. Model IDs are configuration, not source-code constants:
`provider-default` omits the model flag so the local harness chooses its
default, while an explicit configured model is forwarded.

The API adapters read `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` from the
environment only; keys are never written to project state, logs, or evidence.
`provider-default` resolves to each provider's current default model inside the
provider layer, so config and domain never pin a volatile model ID. HTTP 401 and
403 are terminal authentication errors, while 429 and 5xx are retried as
transient. No vendor SDK is used — requests go through the runtime `fetch`.

## Provider layer

Architect, worker, and reviewer roles reach models through one model-runner
port. `createModelRunner(config)` (in `src/providers/`) routes each role to its
configured adapter and wraps every call in shared reliability: a per-call
timeout, bounded retry of transient failures only, and secret redaction on the
surfaced error. Adapters expose capability discovery as pure data and classify
failures as transient or terminal; authentication and contract errors are never
retried. The Codex CLI and Claude Code adapters share one injectable
child-process transport, use existing local authentication, and report
capabilities without launching a process or probing the network. The OpenAI and
Anthropic API adapters share one injectable `fetch` transport, authenticate with
environment keys, and map HTTP status onto the same transient/terminal error
contract. Every adapter passes one reusable contract-test suite against a faked
boundary, so tests make no real network or process call.

Live provider smoke tests are disabled during routine checks. Set
`DRAFTFORGE_LIVE_SMOKE=1` to opt in; each test still skips unless its local
harness is authenticated or its provider key is present.

## Repository map

```text
.draftforge/       Canonical development state, schemas, and task contracts
docs/              Product spec, architecture, protocol, and ADRs
prompts/           Versioned role prompts
scripts/           Session rendering and consistency checks
src/               CLI and provider-independent core
templates/         Files and schemas that `init` writes into a new project
test/              Node test-runner tests
AGENTS.md           Shared harness instructions
CLAUDE.md           Claude Code entrypoint to the shared instructions
PHASES.md           Ordered delivery roadmap and phase gates
SESSION.md          Generated cross-harness handoff
```

## Security

Keep secrets in environment variables. Local overrides belong in `.draftforge/config.local.json`, which is ignored. Generated run logs must redact credentials and remain under the ignored `.draftforge/runs/` directory.

## License

MIT

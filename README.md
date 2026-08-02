# DraftForge

DraftForge is a local-first CLI that turns a rough Markdown idea into an
architecture interview, recorded decisions, a phased implementation plan, and an
agent-ready project scaffold.

The lead model decides and delegates. It does not implement. Lower-cost workers
receive bounded task contracts, and an independent reviewer validates their work
before the project advances.

## Status

Phases 0 through 5 are complete: project lifecycle, planning and approval,
provider and harness adapters, delegated execution, and machine-first review and
recovery. **Phase 6 (Release) is in progress.**

DraftForge is **not published to a package registry yet.** Install it from a
locally built tarball, as shown below. The scoped package name is settled later
in Phase 6; documentation uses `@your-scope/draftforge` as a placeholder until
then.

> The unscoped `draftforge` package on the public npm registry is an unrelated
> third-party project. Do not install it expecting this CLI.

Canonical phase and task state lives in `.draftforge/state.json`; `SESSION.md` is
its generated handoff view.

## Requirements

- **Node.js 22 or newer** to run the installed CLI.
- **Git**, which DraftForge uses for per-task workspace isolation.
- A provider only when you want a model to do the work. Initialization, the
  manual planning loop, `status`, `doctor`, `handoff`, and `upgrade` all run with
  no provider, no API key, and no network.

Developing DraftForge itself requires Node.js 24 — see
[Developing DraftForge](#developing-draftforge). Do not confuse the two.

## Install

Until a scoped package is published, build a tarball from a checkout and install
that exact artifact:

```bash
git clone https://github.com/darkweb19/draftforge.git
cd draftforge
npm install
npm run build
npm pack                      # writes draftforge-<version>.tgz

npm install -g ./draftforge-<version>.tgz
draftforge --version
```

`draftforge --version` must print the same version as the tarball. Full
instructions, per-platform notes, and clean uninstall are in
[docs/INSTALLATION.md](docs/INSTALLATION.md).

## Shortest working flow

This sequence needs no provider and no network. It takes an idea to an approved,
materialized plan.

```bash
draftforge init my-app
cd my-app
# describe the project in idea.md

draftforge plan idea.md          # start a planning revision
draftforge plan --prompt         # print the architect prompt
# give that prompt to any model; save its JSON reply as questions.json
draftforge plan --submit questions.json
draftforge plan --answer Q1="Node.js 22"
draftforge plan --answer Q2="Use strict TypeScript"
draftforge plan --prompt
draftforge plan --submit plan.json
draftforge plan --approve --by <actor>

draftforge status
```

Substitute `draftforge plan --run` for the `--prompt` / `--submit` pair to drive
one architect turn through the configured adapter instead of by hand.

A complete worked example with real fixtures and real output is in
[docs/EXAMPLE.md](docs/EXAMPLE.md).

Once the plan is approved and a workspace-capable worker route is configured,
delegated execution begins:

```bash
draftforge run       # claim and execute ready, non-conflicting tasks
draftforge review    # machine checks, independent review, repair, integration
draftforge resume    # continue interrupted attempts only
```

## Commands

These are the commands of the **installed** CLI. Repository development scripts
are separate and listed under [Developing DraftForge](#developing-draftforge).

```text
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

Exit codes for `run`, `resume`, and `review`: `0` means nothing failed, `1` means
a task is blocked or an attempt needs manual inspection, and `2` means the
command was refused before touching task state — bad options, an unapproved
plan, a text-only worker route, or an unsafe upgrade.

## Initializing a project

```bash
draftforge init my-app
```

`init` needs no provider, login, or API key. It writes canonical state, a default
role configuration, the JSON Schemas, shared harness instructions, and an
`idea.md` draft:

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
- Any other existing file is reported as a conflict and **nothing is written**.
  Pass `--force` to approve overwriting.
- Once `.draftforge/state.json` is valid, `init` only restores missing files and
  never rewrites existing ones.

> **`init` does not write a `.gitignore`.** Generated run artifacts, upgrade
> backups, and your local configuration override are not ignored in a new
> project until you ignore them yourself. Add these three entries before your
> first commit:
>
> ```text
> .draftforge/runs/
> .draftforge/backups/
> .draftforge/config.local.json
> ```

## Planning and approval

`plan <idea.md>` initializes or resumes `.draftforge/planning.json` without
calling a provider. The architect returns one JSON envelope per turn —
`{"kind":"questions",…}` or `{"kind":"plan",…}` — and the expected kind is derived
from planning state, so an off-stage or malformed response is rejected rather
than partially applied.

`plan --approve` materializes the accepted phases, ADRs, and task files before
making active phase roots runnable. An approved plan is then immutable in place;
it changes only through a recorded revision:

```bash
draftforge plan --revise --reason "Reporting must export CSV" --by sujan
draftforge plan --prompt                    # the revision restates its questions
draftforge plan --submit questions-r2.json  # recorded answers carry forward
draftforge plan --answer Q3="Yes, CSV and text"
draftforge plan --submit plan-r2.json
draftforge plan --approve --by sujan
```

`--revise` records the reason, actor, and predecessor revision, and withdraws the
readiness the superseded plan justified before anything else changes. Approving
the revision keeps recorded progress: `done` stays `done` unless `--reopen` names
it, in-flight tasks keep their status, and dropping a started or completed task
is rejected unless `--retire` names it. Re-materialization rewrites only files
DraftForge generated; an edited ADR or task contract blocks approval instead of
being overwritten.

## Delegated execution

`run` recomputes readiness, claims up to `roles.worker.maxConcurrency` tasks
whose dependencies are done and whose owned paths do not overlap any active task,
and executes them concurrently. The project lock is held only to claim, to
finalize a result, and to render the handoff — never during a worktree or model
operation.

**Worktree retention.** Each attempt gets a deterministic Git worktree at
`.draftforge/runs/<run-id>/worktrees/<task-id>`. Cleanup is conservative:
interrupted, timed-out, blocked, and scope-violating attempts keep their worktree
for inspection and explicit resume, and a worktree tied to a live or
indeterminate worker process is never reused by another worker.

**Attempt evidence.** Every attempt records a manifest (task, contract hash, base
commit, workspace identity, lifecycle, budget), an attempt event log, and a
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
inferred from an event alone. Reconciliation is idempotent, so running it again
changes nothing.

## Machine-first review and recovery

`draftforge review` is the only command that can complete a task. It runs the
task contract's verification commands in the retained attempt worktree, checks
the authoritative Git-derived changed paths against the owned paths, scans the
diff and untracked candidate files for secrets, and then asks the independent
reviewer for one strict verdict envelope. **A reviewer can reject passing work;
it cannot accept a failed machine check.**

Verification is intentionally narrow and shell-free: a task may declare only
`npm run <script>` or `node <relative-path>` with literal arguments. Commands
with a shell operator, redirection, traversal, absolute path, flag, or another
program are a `contract-violation`, not a skipped check. Verification receives a
minimal replacement environment, so provider credentials are not forwarded to
project commands.

The secret scanner records a locator only: rule ID, repository-relative path, and
line number. It never records the credential value, a substring, or surrounding
line content. A detected secret, scope violation, malformed review envelope, or
integration conflict blocks immediately and retains the worktree for inspection.

Only `verification-failure` and `review-rejection` are repairable. A repair
creates a new durable attempt, reuses the rejected worktree and branch history,
and carries only persisted actionable findings into the worker prompt. The
durable repair counter is capped by `limits.maxRepairAttempts`; once reached, the
task remains blocked until a human reopens it.

Accepted work is re-scanned and re-checked for scope, then merged from a clean
project root. DraftForge records the project branch head immediately before the
merge as the rollback point and records the integration commit only after a
successful merge. **It never performs rollback automatically.** A dirty root or
merge conflict aborts integration, preserves the attempt worktree, and blocks the
task rather than stashing or overwriting local changes.

`status` reports each task's repair counter and classification, retained
integration rollback point and commit, and run usage totals. Usage is provider
reported only: harness calls and unpriced models show `unknown`; DraftForge never
estimates tokens or cost from prompt or completion length.

The project lock waits for a bounded interval when another DraftForge command
holds it. This serializes concurrent `run`, `resume`, and review transitions; it
does not hold the lock while a verification command, scan, model call, or merge
is running.

## Providers and configuration

Architect, worker, and reviewer roles reach models through one model-runner port.
Each role is routed to an adapter in `.draftforge/config.json`:

```json
{
  "roles": {
    "architect": { "adapter": "claude-cli", "model": "provider-default", "reasoning": "high" },
    "worker":    { "adapter": "claude-cli", "model": "provider-default", "reasoning": "medium", "maxConcurrency": 2 },
    "reviewer":  { "adapter": "anthropic-api", "model": "provider-default", "reasoning": "high" }
  },
  "limits": { "maxRepairAttempts": 2, "taskTimeoutMinutes": 30 }
}
```

| Adapter | Transport | Authentication | Can run a worker |
| --- | --- | --- | --- |
| `codex-cli` | Local Codex CLI | Existing `codex` login | Yes |
| `claude-cli` | Local Claude Code | Existing `claude` login | Yes |
| `openai-api` | HTTPS via `fetch` | `OPENAI_API_KEY` | No — text only |
| `anthropic-api` | HTTPS via `fetch` | `ANTHROPIC_API_KEY` | No — text only |

DraftForge loads `.draftforge/config.json` first and deeply applies the optional
`.draftforge/config.local.json`. The merged result must match the shipped
configuration schema. Secret values never belong in either file — API keys are
read from the environment only. Ignore `config.local.json` in your project so a
machine-specific override is never committed.

`doctor` reports availability and authentication per configured role adapter.
Missing commands, logins, and key variables are reported as `missing` and do not
fail the command; invalid configuration or a probe error exits non-zero. Secret
values and authentication command output are never printed.

Setup for each adapter is in [docs/PROVIDERS.md](docs/PROVIDERS.md).

## Upgrading a project

`draftforge upgrade` is the only path that persists a project schema migration.
Ordinary reads may migrate a supported document in memory, but never write it
back. The upgrade validates the whole candidate under the project lock, refuses
unsafe conditions before touching anything, and backs up every replaced file to
`.draftforge/backups/` before writing.

See [docs/UPGRADING.md](docs/UPGRADING.md) for supported migrations, refusal
conditions, and the manual recovery procedure.

## Documentation

| Document | Covers |
| --- | --- |
| [docs/INSTALLATION.md](docs/INSTALLATION.md) | Requirements, tarball install, platforms, uninstall |
| [docs/PROVIDERS.md](docs/PROVIDERS.md) | Adapter setup, routing, environment variables |
| [docs/EXAMPLE.md](docs/EXAMPLE.md) | A complete worked project, provider-free through approval |
| [docs/UPGRADING.md](docs/UPGRADING.md) | Schema migrations, backups, refusals, recovery |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Symptoms, causes, and safe evidence collection |
| [SECURITY.md](SECURITY.md) | Trust boundaries, secret handling, reporting |
| [CHANGELOG.md](CHANGELOG.md) | Release history |
| [docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md) | What DraftForge is for |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Internal structure |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | Task states, contracts, attempts, review rules |
| [docs/decisions/](docs/decisions/) | Architecture decision records |

## Developing DraftForge

These commands operate on **this repository**, not on a DraftForge-managed
project. They are not available from an installed package.

```bash
npm install
npm run check       # typecheck, lint, test, session check, build
npm run build
npm run dev -- status
```

Requires **Node.js 24 or newer for development** (see `.nvmrc`). The published
CLI target is Node.js 22 or newer.

| Script | Purpose |
| --- | --- |
| `npm run check` | Full verification gate |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | oxlint over `src test scripts` |
| `npm test` | Node test runner |
| `npm run build` | Emit `dist/` |
| `npm run dev -- <args>` | Run the CLI from source |
| `npm run session:render` | Regenerate `SESSION.md` from canonical state |
| `npm run session:check` | Verify `SESSION.md` agrees with canonical state |
| `npm run package:pack` | Build the release tarball |
| `npm run package:smoke -- <tarball>` | Audit and install a tarball, then exercise its binary |

Live provider smoke tests are disabled during routine checks. Set
`DRAFTFORGE_LIVE_SMOKE=1` to opt in; each test still skips unless its local
harness is authenticated or its provider key is present.

Contributor rules, role boundaries, and engineering constraints are in
[AGENTS.md](AGENTS.md).

## Repository map

```text
.draftforge/       Canonical development state, schemas, and task contracts
docs/              Product spec, architecture, protocol, guides, and ADRs
examples/          A committed worked example and its recorded fixtures
prompts/           Versioned role prompts
scripts/           Session rendering, consistency checks, and package smoke
src/               CLI and provider-independent core
templates/         Files and schemas that `init` writes into a new project
test/              Node test-runner tests
AGENTS.md           Shared harness instructions
CLAUDE.md           Claude Code entrypoint to the shared instructions
PHASES.md           Ordered delivery roadmap and phase gates
SESSION.md          Generated cross-harness handoff
```

## Security

Keep secrets in environment variables. Local overrides belong in
`.draftforge/config.local.json`. Generated run logs redact credentials and stay
under `.draftforge/runs/`. Neither is ignored automatically in a new project —
add the entries shown under [Initializing a project](#initializing-a-project).

Report vulnerabilities privately — see [SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE).

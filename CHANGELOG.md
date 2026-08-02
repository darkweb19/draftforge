# Changelog

All notable changes to DraftForge are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

DraftForge has not been published to a package registry yet, so every change
below is unreleased. The first entry under a version heading will appear when a
scoped package is published.

## [Unreleased]

### Added

#### Project lifecycle

- `draftforge init [directory]` scaffolds a managed project — canonical state, a
  default role configuration, JSON Schemas, shared harness instructions, and an
  `idea.md` draft. It needs no provider, login, or API key. Re-running is
  idempotent; any other existing file is reported as a conflict and nothing is
  written unless `--force` is passed.
- `draftforge status` reports workflow position, per-task repair counters and
  failure classification, retained integration rollback points, run usage
  totals, and project health.
- `draftforge doctor` reports project health plus availability and
  authentication for each configured role adapter, without printing secret
  values or authentication command output.
- `draftforge handoff` regenerates `SESSION.md` from canonical state.
- Atomic state transitions serialized with a project lock, with a secret-redacted
  append-only event log written before each snapshot.
- Configuration discovery: `.draftforge/config.json` deeply overridden by the
  ignored `.draftforge/config.local.json`, validated against a shipped schema.

#### Planning

- `draftforge plan <idea.md>` starts or resumes a planning revision without
  calling a provider.
- A manual, provider-free planning loop — `plan --prompt`, `plan --submit`,
  `plan --answer`, `plan --status` — so the full interview can be driven by hand.
- `draftforge plan --run` drives exactly one architect turn through the
  configured adapter.
- One strict JSON envelope per architect turn, with the expected kind derived
  from planning state so an off-stage or malformed response is rejected rather
  than partially applied.
- `draftforge plan --approve --by <actor>` materializes accepted phases, ADRs,
  and task contracts, then makes active-phase task roots runnable.
- `draftforge plan --revise` records a reason, actor, and predecessor revision;
  answers carry forward, recorded progress is preserved, and dropping a started
  or completed task requires an explicit `--retire`.

#### Providers

- One model-runner port routing the architect, worker, and reviewer roles to
  configurable adapters, with a per-call timeout, bounded retry of transient
  failures only, and secret redaction on surfaced errors.
- Harness adapters for Codex CLI (`codex-cli`) and Claude Code (`claude-cli`)
  over a shared, injectable, shell-free child-process transport using existing
  local authentication. Prompts are sent on stdin, never in process arguments.
- API adapters for OpenAI (`openai-api`) and Anthropic (`anthropic-api`) over a
  shared injectable `fetch` transport with no vendor SDK. Keys come from the
  environment only. HTTP 401/403 are terminal; 429 and 5xx are retried.
- `provider-default` resolves inside the provider layer, so no volatile model ID
  is pinned in configuration or domain code.
- Live provider smoke tests are opt-in behind `DRAFTFORGE_LIVE_SMOKE=1` and the
  corresponding local authentication, so a routine check never issues a paid
  request.

#### Delegated execution

- `draftforge run` reconciles state, then claims and concurrently executes ready
  tasks whose dependencies are done and whose owned paths do not overlap any
  active task.
- `draftforge resume` reconciles interrupted attempts and continues them in
  their own worktrees without claiming new work. A persisted valid result is
  finalized without another model call.
- Durable execution attempts: a stable attempt reference in canonical state plus
  a schema-validated manifest recording task, contract hash, base commit,
  workspace identity, lifecycle, and budget.
- Per-attempt Git worktree isolation under `.draftforge/runs/`, with
  conservative cleanup that retains interrupted, timed-out, blocked, and
  scope-violating workspaces for inspection.
- Scope enforcement derived from a content-derived Git diff rather than the
  paths a worker reports.
- Fail-closed Git inspection for worker-mutable control surfaces — executable
  filters, mutable hooks or fsmonitor, tracked submodules, and line-ending
  overrides.

#### Review and recovery

- `draftforge review` — the only command that can complete a task. It runs the
  contract's verification commands in the retained worktree, checks changed
  paths against owned paths, scans for secrets, and then asks an independent
  reviewer for one strict verdict. A reviewer can reject passing work but can
  never accept a failed machine check.
- Shell-free verification restricted to `npm run <script>` and
  `node <relative-path>` with literal arguments, run with a minimal replacement
  environment. Any other shape is a `contract-violation` that blocks.
- Secret scanning that records only rule ID, path, and line number.
- A closed failure taxonomy stored durably on the task. Only
  `verification-failure` and `review-rejection` are repairable.
- A bounded repair loop capped by `limits.maxRepairAttempts`, reusing the
  rejected worktree and carrying persisted findings into the worker prompt.
- Integration of accepted work from a clean project root, with the pre-merge
  branch head recorded as a rollback point and the integration commit recorded
  only after a successful merge.
- Provider-reported usage accounting. Harness calls and unpriced models record
  `unknown`; token counts and cost are never estimated.

#### Release

- A portable npm artifact with a pinned file set, exercised through the
  package manager's installed binary rather than direct `dist` execution.
- `draftforge upgrade` — the only path that persists a schema migration. It
  validates the complete candidate under the project lock, refuses unsafe
  conditions before any write, copies every replaced file to a timestamped
  backup under the ignored `.draftforge/backups/`, and treats the canonical
  state version as the final commit marker so a partial failure can be retried.
- Installation, provider setup, upgrade, troubleshooting, example, and security
  documentation grounded in the built artifact.

### Changed

- The project lock now waits for a bounded interval instead of refusing
  immediately, so two concurrent `draftforge run` processes serialize rather
  than one failing. Stale locks are still broken immediately.

### Security

- Credentials are read from the environment only and are never written to
  project state, configuration, event logs, or evidence.
- Secret detections record a locator only — rule ID, path, and line number —
  never the value or surrounding content.
- Model output is validated before it can reach domain state, and worker claims
  about changed paths are never trusted over the Git-derived diff.

See [SECURITY.md](SECURITY.md) for the full policy and reporting process.

[Unreleased]: https://github.com/darkweb19/draftforge/commits/main

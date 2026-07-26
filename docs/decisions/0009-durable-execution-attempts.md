# ADR 0009: Durable execution attempts and resumable isolated workspaces

Status: accepted

## Decision

Every worker dispatch is represented by a stable execution attempt before any
workspace or model side effect begins. Canonical task state stores the active
attempt reference; the detailed, schema-validated attempt manifest and redacted
evidence live under `.draftforge/runs/<run-id>/`. A claim is made while holding
the project lock, but workspace creation and model execution happen after the
lock is released.

The task contract named by `TaskState.taskFile` is the execution input. DraftForge
parses and validates its generated sections, records a content hash in the
attempt manifest, and blocks resume if the contract changes underneath an
in-flight attempt. Owned paths are normalized as repository-relative paths.
Ancestor/descendant ownership conflicts, platform case behavior, active
attempts, and `roles.worker.maxConcurrency` all participate in scheduling.
Orchestration control files under `.draftforge/runs/`, canonical state, and the
generated handoff are scheduler-owned rather than worker-owned.

`TaskState` gains a nullable attempt reference and the state schema advances
with an explicit migration. Detailed manifests record the task, run, attempt,
contract hash, base commit, deterministic workspace identity, lifecycle state,
and evidence pointers. `workflow.currentTask` remains a compatibility/display
pointer; task statuses plus attempt references are the authoritative set of
concurrent work.

Git worktrees are created at deterministic paths below
`.draftforge/runs/<run-id>/worktrees/` and retained whenever completion is
uncertain. Resume reuses the same attempt and worktree. A validated result is
written atomically before the locked `active -> review` or `active -> blocked`
transition, so a crash after the model returns can be reconciled without a
second worker call. Worker invocations that can mutate a workspace are not
transparently retried; a further call is an explicit resume of the same
attempt.

Harness adapters may receive a worktree working directory and are the Phase 4
workspace-capable worker transports. API adapters remain text-only and are
rejected before a worker claim instead of being allowed to report changes they
could not make. Adding a safe patch/tool execution protocol for API workers
requires a separate decision.

A worker result can advance only to `review`, never `done`. Phase 4 tests may
use the existing trusted transition seam to simulate reviewer acceptance and
prove dependency release, but automatic reviewer decisions, repairs, merges,
rollback, secret scanning, and usage accounting remain Phase 5.

## Why

Task status alone cannot distinguish a live worker from a crashed process, find
its worktree, or prevent a restart from dispatching the same work again.
Durable attempt identity makes each crash boundary reconcilable while keeping
the project lock short enough for real concurrency.

Using the task file already referenced by canonical state keeps hand-authored
and generated DraftForge projects executable through one contract. Checking the
Git diff rather than trusting a worker's changed-path claims enforces scope at
the repository boundary.

Stopping at review preserves the independent-review invariant. Treating API
models as workspace-capable without a patch or tool protocol would create false
success and unsafe file application.

## Consequences

- Phase 4 must ship task-contract parsing, an execution-manifest schema, state
  migration, attempt reconciliation, and deterministic worktree recovery.
- Multiple tasks may be active while `workflow.currentTask` names only the
  display-preferred task.
- Interrupted or timed-out worktrees remain for inspection and explicit resume;
  cleanup is conservative.
- Per-task time budgets are enforced, while token/cost declarations are carried
  into prompts and evidence for Phase 5 accounting.
- API-backed architect and reviewer calls remain supported, but API-backed
  workers fail with an actionable capability error until a safe mutation
  protocol is designed.

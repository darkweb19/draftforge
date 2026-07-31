# Orchestration protocol

## Task states

```text
backlog -> ready -> active -> review -> done
                     |          |
                     +-> blocked+
```

Transitions are validated and recorded. `done` is terminal unless a plan revision explicitly reopens the task.

## Task contract

Every task must declare:

- Stable ID and objective.
- Dependency IDs.
- Owned paths.
- Required context and relevant ADRs.
- Acceptance criteria.
- Verification commands.
- Explicit exclusions.
- Optional token, cost, and time budgets.

## Execution attempts

Every worker dispatch is a durable *attempt* created before any workspace or
model side effect. Canonical task state stores a small `{runId, attemptId}`
reference; the detailed manifest, event log, and result artifact live under
`.draftforge/runs/<run-id>/`.

- The project lock is held only to claim an attempt, to finalize a result, and
  to render the handoff. Worktree creation and model calls always run with the
  lock released, which is what makes concurrency safe.
- Lock contention waits with a bounded retry. A second `run`, `resume`, or
  `review` serializes behind the first transition instead of being refused;
  command execution, scanning, reviewer calls, and merges remain outside it.
- `roles.worker.maxConcurrency` caps the number of simultaneously `active`
  tasks. Attempts that are already active count toward that cap.
- Two ready tasks are never dispatched together when their owned paths overlap,
  including ancestor/descendant overlap (`src/app` versus `src/app/child.ts`).
- Scope is enforced from a content-derived diff of the attempt worktree, not
  from the paths a worker claims to have changed.

## Concurrency and worktrees

Each attempt gets a deterministic Git worktree at
`.draftforge/runs/<run-id>/worktrees/<task-id>` on branch
`draftforge/<run-id>/<task-id>/<attempt-id>`.

- Worktrees are **retained** whenever completion is uncertain: an interrupted,
  timed-out, blocked, or scope-violating attempt keeps its worktree for
  inspection and for an explicit resume.
- Resume reuses the same attempt identity and the same worktree. It never
  creates a second attempt for the same interrupted work.
- A worktree associated with a live or indeterminate worker process is never
  reused by another worker.

## Attempt evidence

For each attempt DraftForge persists:

- `attempts/<attempt-id>.json` — the manifest: task, contract hash, base commit,
  workspace identity, lifecycle, budget, and evidence pointers.
- `attempts/<attempt-id>.result.json` — the validated outcome, authoritative
  changed paths, scope violations, and failure classification.
- `attempts/<attempt-id>.events.jsonl` — attempt-scoped events.
- `events.jsonl` — run-scoped task transitions.

All of it is secret-redacted, and raw model text and provider error causes are
never written.

## Safe resume

`draftforge resume` reconciles before it does anything else, and each durable
crash boundary has one deterministic resolution:

| Observed state | Resolution |
| --- | --- |
| Claimed, no worktree | Re-dispatch the same attempt; create its worktree. |
| Worktree created or modified, no result | Re-dispatch the same attempt into the existing worktree. |
| Valid result persisted, task still `active` | Finalize to `review` or `blocked` **without another model call**. |
| Result and event persisted, task still `active` | Same finalization; the event append is idempotent. |
| Task already `review`/`blocked`, manifest trailing | Resynchronize the manifest lifecycle only. |
| Task and manifest consistent | No work. |
| Result *event* present but result artifact missing | Refuse: neither accept nor re-dispatch; report for inspection. |
| Manifest in `claimed`/`running` that no task owns | Report as an orphan attempt; never dispatch it. |
| Task contract changed under an in-flight attempt | Refuse to resume; the attempt is preserved. |
| Uncertain worker termination, process alive or unknown | Refuse to re-dispatch; preserve the attempt and worktree. |

Acceptance is never inferred from an event alone, and reconciliation is
idempotent: repeating it produces the same summary and changes nothing further.

`run` reconciles too, but it only claims new work; an unfinished attempt counts
as occupied capacity until `resume` continues it.

## Capability limits

Workspace-capable harness adapters (`codex-cli`, `claude-cli`) are the only
Phase 4 worker transports. API adapters are text-only: they cannot execute
against a worktree, so `run` and `resume` refuse an API-backed worker route
before any task state changes, rather than accepting changes the worker could
not have made. `run` and `resume` also refuse an unapproved plan before
changing state.

## Command outcomes

`run` and `resume` report each outcome class on its own line — dispatched,
resumed, reconciled, deferred, review-ready, blocked, orphan attempts, and
no-work — with a deferral reason per task (`dependency`, `owned-path-conflict`,
`capacity`, `in-flight`, `worker-process-live`, `run-required`,
`unreconciled`).

Exit codes:

- `0` — nothing failed, including a deferred or no-work invocation.
- `1` — a task is blocked, or an attempt needs manual inspection.
- `2` — refused before touching task state: bad options, an unapproved plan, or
  a non-workspace-capable worker route.

## Review handoff

A worker result advances a task only to `review`, never to `done`. Acceptance is
a separate reviewer decision (Phase 5). Nothing in `run` or `resume` marks a
task `done`, and a successor task stays blocked while its predecessor is
`active` or `review`; only an accepted `done` predecessor releases it.

## Review, repair, and integration

`review` is machine-first. For every review attempt it persists the task
contract's allowlisted verification result, authoritative scope result, and
secret scan before a reviewer verdict is used for a transition. The only
executable verification forms are `npm run <script>` and `node <relative-path>`
with literal arguments. Shell syntax, redirects, pipes, command substitution,
flags, absolute/traversing paths, and other programs are contract violations.
Verification runs in the attempt worktree through the shell-free process
boundary with a minimal environment that excludes provider credentials.

Secret findings are locators only: `{ruleId, path, line}`. The matched value,
its substrings, and surrounding line text are never written to state, events,
or evidence. A secret detection, scope violation, contract violation, timeout,
or integration conflict is terminal for automation.

Only `verification-failure` and `review-rejection` can repair. The transition
is `review -> active` for a new durable attempt that keeps the rejected
worktree; its prompt contains only persisted actionable findings. The task's
repair counter is durable and bounded by `limits.maxRepairAttempts`; exhausted
work remains blocked until a human explicitly reopens it.

Before accepting, DraftForge repeats the scope and secret checks, requires a
clean project root, records its branch head as the rollback point, and merges
the attempt branch. The manifest records the integration commit before the task
becomes `done`. A dirty root or conflict aborts the merge and blocks while
retaining the workspace. Rollback is intentionally manual: use the surfaced
rollback point or integration commit only after operator review; DraftForge
never resets or reverts automatically.

Usage is reported, not estimated. The run ledger aggregates provider-reported
tokens and derived cost only for known prices. Harness calls and unpriced models
remain `unknown`; prompts, completions, and credentials never enter the ledger.

## Architect rules

- Ask all material follow-up questions in one batch.
- State assumptions and alternatives briefly.
- Decide naming, structure, stack, and phase boundaries unless the user constrained them.
- Produce tasks small enough for isolated workers.
- Never edit implementation paths.

## Worker rules

- Work only on the assigned task and paths.
- Preserve unrelated changes.
- Stop on an architecture conflict rather than inventing a new direction.
- Run stated checks and report exact evidence.
- Never mark its own task accepted.

## Reviewer rules

- Compare output to the task, not to unstated preferences.
- Reject scope expansion, missing checks, unsafe behavior, or state drift.
- Return a minimal repair contract when repair is safe.
- Escalate after the configured repair limit.

## Handoff rules

After an accepted task:

1. Mark the task `done`.
2. Recompute ready tasks.
3. Set current and next task fields.
4. Append the redacted event.
5. Render `SESSION.md`.
6. Commit state with the task changes.

The handoff contains no chat transcript and no secret. It records decisions, evidence, blockers, and the exact next action.

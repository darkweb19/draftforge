# ADR 0010: Machine-first review, bounded repair, and accepted-work integration

Status: accepted

## Decision

Review is machine-first. Before any reviewer model call, DraftForge itself
produces the review facts for an attempt: the authoritative content-derived diff
from the retained worktree, an owned-path scope check, a deterministic secret
scan, and the exit status of the verification commands declared in the task
contract. Those facts are persisted as redacted evidence beside the attempt. A
reviewer model reads them; it may reject work that machine evidence passed, but
it can never accept work that machine evidence failed. Acceptance requires both
signals.

Verification commands come from the task contract's `## Verification` section
and run inside the attempt worktree through the existing shell-free process
boundary. Only an allowlisted command shape is executable — `npm run <script>`
and `node <path>` with literal arguments — and any command carrying shell
metacharacters, redirection, or an unlisted program is a contract violation that
blocks the task rather than silently skipping the check. Command timeouts derive
from `limits.taskTimeoutMinutes`; transcripts are captured redacted and
truncated.

Secret scanning runs over the diff and over untracked candidate files in the
worktree before a verdict is formed and again immediately before integration. A
detection records only a locator — rule id, path, and line number — never the
matched value, never a partial value, and never enough surrounding context to
reconstruct it. A detection is terminal for the attempt: it blocks, and the
worktree is retained for human inspection.

Every non-acceptance is classified from a closed taxonomy recorded in canonical
state: `contract-violation`, `scope-violation`, `verification-failure`,
`review-rejection`, `secret-detected`, `integration-conflict`,
`harness-failure`, `timeout`, and `unknown`. Classification is what routes
recovery, so it is durable rather than re-derived by scanning events. Repairable
classifications are `verification-failure` and `review-rejection`; everything
else is terminal for automation.

A reviewer `block` verdict over otherwise passing machine evidence maps to
`unknown`. Unlike `reject`, `block` does not assert an actionable review defect;
it says the reviewer cannot safely decide. Keeping that terminal uncertainty in
the existing closed taxonomy is more accurate than inventing a release-only
classification, and avoids a schema migration with no new recovery behavior.

Repair is bounded and durable. A repairable rejection returns the task from
`review` to `active` for a new attempt against the same worktree, carrying the
findings into the worker prompt, and increments a repair counter stored on the
task in canonical state. When the counter reaches `limits.maxRepairAttempts` the
task moves to `blocked` with its classification and evidence intact. The task
transition graph therefore gains exactly one edge, `review -> active`, plus an
explicitly recorded `blocked -> ready` reopen that only a human or architect
action performs. Automation never leaves `blocked` on its own.

Acceptance integrates the work. On accept, DraftForge re-checks scope, re-runs
the secret scan, records the project branch's current head as the attempt's
rollback point, and merges the attempt branch into the project branch from the
project root, which must be clean. A conflict or a dirty project tree is
`integration-conflict`: the merge is aborted, the worktree is retained, and the
task blocks. Only after a recorded successful integration does the task reach
`done`. Rollback stays guidance rather than automation: the pre-integration head
and the integration commit are both recorded in the attempt manifest and
surfaced by `status`, so reverting is a documented one-command operation the
operator chooses to run.

Usage accounting is reported, not estimated. Adapters that receive token counts
from a provider surface them; the runner aggregates per call into a run-level
ledger under `.draftforge/runs/<run-id>/usage.json` and into the attempt
manifest. Harness adapters that report nothing record `unknown`, which is never
replaced by an estimate. Declared `tokenLimit` and `costLimitUsd` budgets are
enforced before a call is issued and recorded after it returns; an exceeded
budget blocks with `harness-failure` rather than truncating work mid-flight.

Two Phase 4 debts are repaid as the foundation of this phase rather than carried
further. `withProjectLock` waits with a bounded retry instead of refusing
contention, which makes `DispatchGate` in `src/application/execution.ts`
unnecessary and it is deleted. The worker execution seam accepts a `running`
attempt manifest directly, which removes resume's rewind of an interrupted
manifest back to `claimed` with a null base commit.

## Why

A model asked to review its own ecosystem's output is the weakest possible gate,
and Phase 5 exists precisely to stop weak output from advancing. Running the
contract's own verification commands and the diff check ourselves means the
strongest evidence is the evidence DraftForge produced, and the model's role
narrows to judgment that machines cannot supply — whether the change actually
satisfies the objective. Allowing a model verdict to override a failed command
would reintroduce exactly the false-success path ADR 0009 refused for API
workers.

Integration belongs in this phase because worktrees fork from project `HEAD`. If
accepted work never lands on the project branch, a dependent task's worktree is
created from a commit that lacks its predecessor's code, and the dependency edges
in the task DAG stop meaning anything. `done` has to mean integrated.

Storing classification and the repair counter on the task keeps recovery routing
readable from canonical state alone, which is the same reason attempt references
live there. Deriving either by replaying the event log would make crash recovery
depend on log completeness that the append-then-write ordering does not promise.

Secret locators without values are the only shape that is safe to persist. The
event log and attempt evidence are ordinary files that get committed, shared in
handoffs, and pasted into issues; a scanner that records what it found would
itself become the leak.

## Consequences

- Canonical state advances to schema version 3 with a migration from both 1 and
  2. `TaskState` gains a nullable review record holding the repair counter, the
  last classification, and the last review attempt reference.
- The attempt manifest gains verification, scan, verdict, usage, and integration
  sections, and its lifecycle gains `verifying`, `reviewing`, `repairing`, and
  `integrated`.
- A task contract with no `## Verification` section, or one whose commands are
  not allowlisted, cannot be accepted. Existing contracts in this repository
  already declare runnable commands.
- Integration requires a clean project worktree, so a run started with local
  edits in progress will defer acceptance rather than merge over them.
- The reviewer role is a text-only call and works on API adapters as well as
  harness adapters, unlike the worker role.
- Cost figures are only as good as provider-reported usage; a project run
  entirely through harness adapters will show an honest `unknown` rather than a
  fabricated total.
- Deleting `DispatchGate` changes concurrency behavior for two simultaneous
  `draftforge run` processes from a refusal to a wait, which is a behavior change
  worth calling out in the CLI documentation.

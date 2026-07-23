# ADR 0007: Recorded plan revision

Status: accepted

## Decision

An approved plan changes only through a recorded revision. `plan --revise`
requires a reason and an actor, increments the planning revision, clears the
plan and its approval, and appends an immutable record to
`.draftforge/planning.json`:

```json
{
  "revision": 2,
  "previousRevision": 1,
  "reason": "…",
  "requestedBy": "…",
  "requestedAt": "…",
  "reopenedTasks": [],
  "retiredTasks": []
}
```

Starting a revision immediately withdraws readiness in
`.draftforge/state.json`: every `ready` task returns to `backlog`, `nextTask`
clears, and the stage returns to `planning`. In-flight work is untouched. The
canonical state is written before the new planning revision, so no worker can
pick up a task the superseded plan justified.

A revision reopens the interview. The carried question batch keeps its
originating revision number, which is how planning state records that the new
revision has not stated its own questions yet; `architectStage` therefore asks
for `questions` first. The architect may add or reword questions, but every
recorded answer carries forward, and dropping an answered question is rejected.

Approval of a revision reconciles the new task graph against recorded progress
instead of resetting it:

- A `done` task stays `done` unless the revision record reopens it.
- `active`, `review`, and `blocked` tasks keep their status.
- A `backlog` task is recomputed against the new dependency graph.
- Removing a task that is `active`, `review`, or `done` is rejected unless the
  revision retired it by ID.
- Reopening a task that is not `done`, or that the new plan does not contain, is
  rejected.

The active phase is the first phase that still has unfinished work, so a
revision cannot silently move the project backwards through completed phases.

Approval is unchanged otherwise: the P02-T01 gate still applies, and a revision
is never approved implicitly.

Re-materialization keeps the last approved plan in `supersededPlan`. A generated
file may be rewritten only when its content still matches what DraftForge wrote
for this plan or the plan it supersedes, comparing without `Status:` lines
because those drift with recorded progress. Any other content is treated as a
user edit and blocks approval before consent is recorded.

## Why

Plans change after work has started. Rewriting the task graph from scratch would
discard evidence of completed work, and silently keeping approval across an
edit would let unreviewed structure become runnable.

Recording the reason, actor, predecessor, and every deliberate reopen or
retirement makes a plan change auditable from the artifact alone, without a
provider transcript. Requiring the architect to restate the question batch keeps
one derived expected response kind per turn, and carrying answers forward keeps
the interview resumable across revisions.

## Consequences

Each revision costs one extra architect turn for the restated question batch.

`.draftforge/planning.json` retains one superseded plan, bounding growth while
still distinguishing generated files from user edits. Files a revision no longer
plans — a retired task contract, a dropped ADR — are left on disk rather than
deleted; canonical state, not the filesystem, decides what is runnable.

A revision interrupted between the state write and the planning write leaves
readiness withdrawn and the previous revision intact; re-running `plan --revise`
is the recovery, and it appends a fresh record rather than resuming the lost one.

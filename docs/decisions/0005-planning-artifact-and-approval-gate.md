# ADR 0005: Separate planning artifact with an explicit approval gate

Status: accepted

## Decision

Store the resumable architecture interview, current plan draft, and approval
record in `.draftforge/planning.json`. Keep `.draftforge/state.json`
authoritative for workflow position and runnable task state.

The planning artifact is provider-neutral structured data. It records a positive
revision number, the source draft, one complete question batch with persisted
answers, the current plan, and an optional approval. Provider conversation IDs
or vendor-specific response shapes are not required to resume planning.

No implementation task becomes runnable from a draft. Only explicit user
approval of a valid planning revision may materialize its dependency-free task
roots into `.draftforge/state.json` as `ready`. Approval is recorded against the
same revision as the plan.

An approved plan is immutable in this checkpoint. A later revision operation
must increment the revision, replace the prior draft, clear approval, and
withdraw superseded readiness before the new plan can affect runnable state.

Planning writes use the same recoverable project lock and per-file atomic
persistence approach as other canonical snapshots. Approval validates output
conflicts, writes the approved planning artifact, materializes phase, ADR, and
task files, then writes workflow state and the generated handoff. The operation
is retryable and serialized against other writers. A reader may briefly observe
an approved plan or materialized files before runnable roots appear, but it
must never observe runnable roots before the approval record and task files.

## Why

Interview answers and draft plans must survive interrupted sessions, but they
are not workflow state until the user accepts them. Separating the artifacts
keeps draft changes reviewable without weakening `.draftforge/state.json` as
the single authority for execution.

Revision-bound approval prevents stale consent from carrying across plan edits.
Provider-neutral data preserves portability between supported harnesses, and
atomic persistence protects the approval boundary from partial filesystem
writes.

## Consequences

Planning commands must validate `.draftforge/planning.json` before use and
enforce that blocking questions are answered before approval. Dependency
validation, including cycle detection, remains a runtime invariant because JSON
Schema cannot express the complete task graph rules.

The approval operation must validate matching revisions, persist the approval,
and materialize only runnable roots from the active phase under the project
lock. Repeating the same approval must safely reconcile an interrupted write
without resetting task progress. Revision editing remains a separate Phase 2
task and cannot silently retain readiness from the superseded plan.

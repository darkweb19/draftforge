# Architecture

## Shape

DraftForge is a single Node.js CLI with a provider-independent core and replaceable adapters.

```text
CLI commands
    |
Application services: initialize, interview, plan, schedule, review, handoff
    |
Domain: state machine, task DAG, role policy, validation
    |
Ports: model runner, workspace, clock, event log, approval
    |
Adapters: Codex CLI | Claude Code | OpenAI API | Anthropic API | filesystem | Git
```

## Boundaries

- `src/domain/`: pure types, invariants, and state transitions.
- `src/application/`: use cases and orchestration. It can import domain and ports.
- `src/providers/`: harness and API implementations of the model-runner port.
- `src/state/`: filesystem persistence, schemas, locks, and migrations.
- `src/commands/`: CLI parsing and presentation only.

Provider packages may not be imported by domain or application code. Structured model output is parsed at the adapter boundary and validated before it enters the domain.

## Runtime state

`.draftforge/state.json` is a versioned snapshot. Each accepted transition also appends a redacted event under `.draftforge/runs/<run-id>/events.jsonl`. The snapshot makes startup fast; the event trail explains what happened and supports recovery.

Filesystem transitions take an exclusive project lock so concurrent writers cannot lose an update. Event records are appended before the atomic snapshot and generated handoff writes, preserving a replayable trail if snapshot persistence is interrupted.

`SESSION.md` is derived from state. Agents read it for orientation, but software reads JSON. If they disagree, JSON wins and `draftforge handoff` regenerates the Markdown file.

## Planning contract

The architect returns structured data in two checkpoints:

1. Questions: a complete batch of unresolved, material decisions.
2. Plan: assumptions, ADRs, phases, a dependency graph, task contracts, risks, and verification commands.

The plan is immutable after approval except through a recorded revision. The architect receives read-only project access during planning and review.

## Execution contract

The scheduler selects tasks whose dependencies are `done`, ensures path ownership does not conflict, and assigns each task a fresh worker context. A task prompt contains the approved task contract, relevant ADRs, permitted paths, repository rules, and verification commands.

Workers return a result envelope containing status, summary, changed paths, commands run, evidence, risks, and follow-up suggestions. Suggestions do not expand the current task automatically.

## Review contract

The reviewer checks the task contract, diff, test evidence, scope, and policy compliance. It may accept, reject with a bounded repair request, or block with a reason. Only acceptance advances the task to `done`.

## Process isolation

Version 1 uses separate child processes and Git worktrees for concurrent workers. Sequential runs may use the primary working tree. The scheduler never assigns overlapping owned paths concurrently.

## Configuration

Role routes are explicit:

- Architect: strongest available reasoning model.
- Worker: lower-cost model appropriate to the task.
- Reviewer: strong model, independently invoked.

Each route selects an adapter, model string, reasoning level, timeout, and budget. `provider-default` lets an authenticated harness select its recommended current model.

`.draftforge/config.local.json` is an optional deep override of `.draftforge/config.json`. DraftForge validates the merged configuration against the same contract shipped to initialized projects.

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

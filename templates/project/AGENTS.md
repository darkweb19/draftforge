# {{projectName}} — agent instructions

This project is managed by DraftForge. Every harness (Codex CLI, Claude Code, or an
API-backed agent) follows the same rules.

## Start every session

1. Read `SESSION.md`.
2. Read `.draftforge/state.json`; it is the canonical project state.
3. Read `PHASES.md` and the active task file named in state.
4. Read relevant ADRs under `docs/decisions/` before changing architecture.
5. Check `git status` and preserve unrelated user changes.

## Source of truth

- `.draftforge/state.json` is authoritative for phase, stage, task, and blockers.
- `SESSION.md` is a generated mirror. Regenerate it with `draftforge handoff`.
- A task moves to `done` only after its acceptance checks pass.
- Update state and regenerate `SESSION.md` in the same commit as completed work.

## Role boundaries

- Architect: interview, decide, record ADRs, define the task DAG, and review. Does not implement product source files.
- Worker: changes only the paths granted by the active task contract. Does not alter architecture or expand scope silently.
- Reviewer: inspects the task diff and evidence. Does not rewrite the implementation unless assigned a repair task.
- If no role is assigned, act as the lead maintainer of this repository.

## Rules

- Never read, print, persist, or commit secret values.
- Never disable safety checks to make a task pass.
- Prefer the smallest implementation that satisfies the active task.
- Stop on an architecture conflict rather than inventing a new direction.
- The main thread is the intelligent lead engineer and system architect: it owns
  final design decisions, architectural direction, task decomposition, and
  cross-task integration. Subagents may investigate and implement bounded work,
  but must not make unreviewed architectural decisions.
- Use an agentic delegation workflow for coding: the lead thread owns planning,
  task assignment, review, verification, and state transitions; bounded
  subagents perform implementation-heavy work.

## Done means

- Acceptance criteria in the active task pass.
- The project's own checks pass.
- Relevant documentation and ADRs are current.
- `.draftforge/state.json` and `SESSION.md` agree.
- No secrets or generated run artifacts are staged.

# Product specification

## Problem

Rough project ideas lack the decisions, sequencing, and durable state needed for coding agents to work consistently. Switching between Codex and Claude Code makes this worse when each harness relies on its own conversation history.

## Product

DraftForge is a local-first CLI. It reads a Markdown idea, runs a structured architecture interview, records decisions, creates a phased task graph, scaffolds the target project, delegates implementation to cheaper workers, and preserves enough file-backed state for another harness to resume safely.

## Primary workflow

1. The user writes `idea.md`.
2. `draftforge init` creates the project control files without contacting a model.
3. `draftforge plan idea.md` assigns an architect model.
4. The architect asks one complete batch of blocking questions.
5. The user answers; the architect records ADRs, phases, tasks, dependencies, and acceptance checks.
6. The user approves the plan.
7. `draftforge run` dispatches ready tasks to configured worker models.
8. A reviewer verifies task output and evidence.
9. State and `SESSION.md` update after every accepted task.
10. `draftforge resume` continues from the canonical state regardless of which supported harness invokes it.

## Functional requirements

- Support local Codex CLI and Claude Code authentication sessions.
- Support OpenAI and Anthropic API keys through environment variables.
- Route architect, worker, and reviewer roles independently.
- Keep model identifiers configurable.
- Ask architecture questions before generating an approved plan.
- Enforce that the architect role cannot implement product source files.
- Express work as a dependency graph of bounded task contracts.
- Resume safely after interruption.
- Produce `AGENTS.md`, `CLAUDE.md`, `SESSION.md`, state, phase, task, ADR, and verification files in generated projects.
- Redact secrets from logs and never store key values.

## Non-goals for version 1

- A graphical interface.
- A hosted control plane.
- Training or fine-tuning models.
- Supporting every provider through one lowest-common-denominator prompt.
- Autonomous production deployment.
- Replacing Git as the change history.

## Success criteria

- A new project can be planned and scaffolded from one Markdown draft.
- Work can switch from Codex to Claude Code, or back, using repository files only.
- The next task, its dependencies, owned paths, and verification steps are unambiguous.
- An interrupted run resumes without repeating accepted tasks.
- A worker cannot silently broaden its assigned scope.

## Policy decisions

- The CLI may recommend a default route but must not assume a specific model is available.
- The CLI must stop before worker execution until the user approves the architecture plan.
- File-backed state is portable; provider conversation IDs are optional metadata, never the source of truth.

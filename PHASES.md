# Delivery phases

Only one phase is active at a time. A phase closes only when its exit gate passes and the state plus `SESSION.md` are updated.

## Phase 0 — Foundation

Goal: make the repository unambiguous to humans, Codex, and Claude Code.

Deliverables:

- Product spec, architecture, execution protocol, and ADRs.
- Strict TypeScript CLI skeleton.
- Canonical state schema, task contract, session renderer, and consistency check.
- Shared `AGENTS.md` and `CLAUDE.md` startup rules.

Exit gate: install, typecheck, tests, build, and session check pass.

## Phase 1 — Local project lifecycle

Goal: create and maintain a DraftForge-managed target without any model call.

Deliverables:

- `init`, `status`, `doctor`, and `handoff` commands.
- Atomic state transitions and append-only event records.
- Config discovery and JSON Schema validation.
- Fixtures for fresh, resumed, and corrupted projects.

Exit gate: a clean temporary directory can be initialized, resumed, and handed between harnesses without manual file edits.

## Phase 2 — Architecture interview and planning

Goal: convert `idea.md` into decisions and a reviewable task graph.

Deliverables:

- Architect prompt and structured response contract.
- One-batch follow-up interview with resumable answers.
- ADR generation, phase planning, dependency validation, and task contracts.
- Explicit user approval checkpoint before implementation tasks become runnable.

Exit gate: deterministic fixtures produce schema-valid decisions and an acyclic task graph; no worker runs before approval.

## Phase 3 — Provider and harness adapters

Goal: support subscription-backed and API-backed model calls through one port.

Deliverables:

- Codex CLI and Claude Code adapters using existing local authentication.
- OpenAI and Anthropic API adapters using environment keys.
- Capability discovery, model-role routing, timeouts, retries, and redaction.
- `doctor` checks for command presence, authentication status, and missing variables without exposing values.

Exit gate: contract tests pass for every adapter; live smoke tests pass for each locally available auth mode.

## Phase 4 — Delegated execution

Goal: let the architect dispatch bounded implementation tasks to workers.

Deliverables:

- Dependency-aware scheduler with configurable concurrency.
- Per-task workspace isolation, path ownership, budgets, and evidence capture.
- Worker prompts that include only the approved task context.
- Resume behavior after interruption or partial completion.

Exit gate: a sample project completes independent tasks in parallel, blocks dependent tasks correctly, and resumes without duplicate work.

## Phase 5 — Review and recovery

Goal: prevent weak or unsafe worker output from advancing the project.

Deliverables:

- Reviewer role, verification commands, and bounded repair loops.
- Diff checks, secret scanning integration, failure classification, and rollback guidance.
- Cost and token accounting for API runs.

Exit gate: injected failures are rejected, recorded, repaired or blocked, and never silently marked done.

## Phase 6 — Release

Goal: publish a portable CLI suitable for real projects.

Deliverables:

- Cross-platform package, executable smoke tests, and upgrade/migration strategy.
- GitHub Actions for checks and package provenance.
- Installation, provider setup, examples, troubleshooting, and security documentation.

Exit gate: clean-machine smoke tests pass on Windows, macOS, and Linux; the package can scaffold and resume an example project.

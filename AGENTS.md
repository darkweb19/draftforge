# DraftForge agent instructions

## Start every session

1. Read `SESSION.md`.
2. Read `.draftforge/state.json`; it is the canonical project state.
3. Read `PHASES.md` and the active task file named in state.
4. Read relevant ADRs before changing architecture.
5. Check `git status` and preserve unrelated user changes.

## Source of truth

- `.draftforge/state.json` is authoritative for phase, stage, task, and blockers.
- `SESSION.md` is a generated human-readable mirror. Run `npm run session:render` after state changes.
- A task moves to `done` only after its acceptance checks pass.
- Update state and render `SESSION.md` in the same commit as completed work.

## Role boundaries

- Architect: interview, decide, record ADRs, define the task DAG, and review. Do not implement product source files.
- Worker: change only the paths granted by the active task contract. Do not alter architecture or expand scope silently.
- Reviewer: inspect the task diff and evidence. Do not rewrite the implementation unless assigned a repair task.
- If no role is assigned, act as the lead maintainer of this repository.

## Engineering rules

- TypeScript strict; no `any` without a documented boundary reason.
- Keep provider-specific code under `src/providers/`.
- Core orchestration depends on provider interfaces, never vendor SDKs.
- Never read, print, persist, or commit secret values.
- Never disable safety checks to make a task pass.
- Prefer the smallest implementation that satisfies the active task.
- The main thread is the intelligent lead engineer and system architect: it owns
  final design decisions, architectural direction, task decomposition, and
  cross-task integration. Subagents may investigate and implement bounded work,
  but must not make unreviewed architectural decisions.
- Use an agentic delegation workflow for coding: the lead thread owns planning,
  task assignment, review, verification, and state transitions; bounded
  subagents perform implementation-heavy work. Apply this rule both while
  building DraftForge and in every project DraftForge manages.

## Commands

- Install: `npm install`
- Typecheck: `npm run typecheck`
- Test: `npm test`
- Full verification: `npm run check`
- Build: `npm run build`
- Render handoff: `npm run session:render`
- Validate handoff: `npm run session:check`

## Release operations

- Pushes to branches, including `main`, and pull requests run CI only. They
  never publish packages.
- The normal release trigger is an intentional pushed `vX.Y.Z` tag. The tag
  version must exactly match the version in `package.json`.
- Publication remains gated until the Node.js 22 checks and installed-artifact
  tests pass on Ubuntu, macOS, and Windows.
- npmjs is canonical at `@draftforge-dev/draftforge`. It publishes through the
  configured GitHub Actions trusted publisher using OIDC and provenance; do not
  add or use an `NPM_TOKEN`.
- `@darkweb19/draftforge` on GitHub Packages and the GitHub Release are separate
  downstream surfaces. Verify each surface independently and do not report the
  whole release complete because only one succeeded.
- The manual `v0.1.0` recovery job is exceptional and idempotent. It is not a
  general release path and must not be described as deployment from `main`.

## Done means

- Acceptance criteria in the active task pass.
- Typecheck and tests pass.
- Relevant documentation and ADRs are current.
- `.draftforge/state.json` and `SESSION.md` agree.
- No secrets or generated run artifacts are staged.

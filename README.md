# DraftForge

DraftForge is a local-first CLI that turns a rough Markdown idea into an architecture interview, recorded decisions, a phased implementation plan, and an agent-ready project scaffold.

The lead model decides and delegates. It does not implement. Lower-cost workers receive bounded task contracts, and a reviewer validates their work before the project advances.

## Status

Phase 1 is complete. Phase 2 now has provider-independent planning contracts,
resumable interview state, DAG validation, and an explicit approval gate.
Provider-backed architect execution is intentionally deferred. See `PHASES.md`
and `SESSION.md`.

## Core commands

```text
draftforge init [directory] [--name <name>] [--force]
draftforge doctor
draftforge status
draftforge plan <idea.md>
draftforge plan --status
draftforge plan --approve --by <actor>
draftforge run
draftforge resume
draftforge handoff
```

`init`, `doctor`, `status`, `handoff`, and the provider-neutral planning
checkpoint are wired. `run` and `resume` fail clearly until delegated execution
is implemented.

`plan <idea.md>` initializes or resumes `.draftforge/planning.json` without
calling a provider. Architect adapters will submit the one-batch interview and
structured plan through the same contracts in Phase 3. `plan --approve`
materializes the accepted phases, ADRs, and task files before making active
phase roots runnable.

`status` validates canonical state, the discovered configuration, and `SESSION.md`. `doctor`
reports those project checks alongside local harness and environment availability. Missing
provider credentials are informational in Phase 1; invalid project files return a non-zero exit.

## Initializing a project

```bash
draftforge init my-app
```

`init` needs no provider, login, or API key. It writes canonical state, a default role
configuration, the JSON Schemas, shared harness instructions, and an `idea.md` draft:

```text
my-app/
  .draftforge/state.json     Canonical state (phase-00, no tasks yet)
  .draftforge/config.json    Role routes and limits
  .draftforge/schema/        State, configuration, and planning schemas
  .draftforge/tasks/         Task contracts, created during planning
  .draftforge/runs/          Redacted run events
  AGENTS.md CLAUDE.md PHASES.md SESSION.md idea.md
```

Conflict rules:

- A file that does not exist is created.
- A file whose content already matches is left alone, so re-running is idempotent.
- Any other existing file is reported as a conflict and **nothing is written**. Pass `--force` to approve overwriting.
- Once `.draftforge/state.json` is valid, `init` only restores missing files and never rewrites existing ones.

## Local state and configuration

Task changes follow the protocol state machine and are serialized with a project lock. Every
accepted transition appends a secret-redacted JSON event to
`.draftforge/runs/<run-id>/events.jsonl`, then atomically updates state and its generated handoff.

DraftForge loads `.draftforge/config.json` first and deeply applies the optional ignored
`.draftforge/config.local.json`. The merged result must match the shipped configuration schema;
errors identify the invalid file or field.

## Development

```bash
npm install
npm run check
npm run build
npm run dev -- status
```

Requires Node.js 24 or newer for development. The published CLI target is Node.js 22 or newer.

## Authentication modes

- Subscription mode invokes a locally installed, already authenticated harness such as Codex CLI or Claude Code.
- API mode invokes provider APIs with keys supplied through environment variables.
- DraftForge never stores secret values in project state or configuration.

For Codex, `codex login` supports ChatGPT subscription sign-in, and `codex exec` is the stable non-interactive surface used by the future adapter. Model IDs are configuration, not source-code constants.

## Repository map

```text
.draftforge/       Canonical development state, schemas, and task contracts
docs/              Product spec, architecture, protocol, and ADRs
prompts/           Versioned role prompts
scripts/           Session rendering and consistency checks
src/               CLI and provider-independent core
templates/         Files and schemas that `init` writes into a new project
test/              Node test-runner tests
AGENTS.md           Shared harness instructions
CLAUDE.md           Claude Code entrypoint to the shared instructions
PHASES.md           Ordered delivery roadmap and phase gates
SESSION.md          Generated cross-harness handoff
```

## Security

Keep secrets in environment variables. Local overrides belong in `.draftforge/config.local.json`, which is ignored. Generated run logs must redact credentials and remain under the ignored `.draftforge/runs/` directory.

## License

MIT

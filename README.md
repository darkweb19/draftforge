# DraftForge

DraftForge is a local-first CLI that turns a rough Markdown idea into an architecture interview, recorded decisions, a phased implementation plan, and an agent-ready project scaffold.

The lead model decides and delegates. It does not implement. Lower-cost workers receive bounded task contracts, and a reviewer validates their work before the project advances.

## Status

Phase 0 foundation scaffold. Provider-backed orchestration is intentionally not implemented yet. See `PHASES.md` and `SESSION.md`.

## Core commands

```text
draftforge init [directory]
draftforge doctor
draftforge status
draftforge plan <idea.md>
draftforge run
draftforge resume
draftforge handoff
```

Only `doctor`, `status`, and `handoff` are wired in the Phase 0 skeleton. Other commands fail clearly until their owning phase is implemented.

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

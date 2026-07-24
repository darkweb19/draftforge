# DraftForge

DraftForge is a local-first CLI that turns a rough Markdown idea into an architecture interview, recorded decisions, a phased implementation plan, and an agent-ready project scaffold.

The lead model decides and delegates. It does not implement. Lower-cost workers receive bounded task contracts, and a reviewer validates their work before the project advances.

## Status

Phase 1 is complete. Phase 2 has provider-independent planning contracts,
resumable interview state, DAG validation, an explicit approval gate, a
recorded architect loop you can drive by hand, and recorded plan revision.
Phase 3 is underway: a role-routed model-runner factory and shared adapter
reliability (timeout, bounded retry, secret redaction) sit behind the
model-runner port. Codex CLI and Claude Code are available through local
subscription-backed authentication, and the OpenAI and Anthropic API transports
are available through environment-supplied keys. `doctor` authentication checks
and a one-turn, runner-backed planning path are implemented; the Phase 3 exit
gate remains authoritative in `SESSION.md`.

## Core commands

```text
draftforge init [directory] [--name <name>] [--force]
draftforge doctor
draftforge status
draftforge plan <idea.md>
draftforge plan --status
draftforge plan --prompt
draftforge plan --run
draftforge plan --submit <response.json>
draftforge plan --answer <id>=<text>
draftforge plan --approve --by <actor>
draftforge plan --revise --reason <text> --by <actor> [--reopen <id>] [--retire <id>]
draftforge run
draftforge resume
draftforge handoff
```

`init`, `doctor`, `status`, `handoff`, and the provider-neutral planning
checkpoint are wired. `run` and `resume` fail clearly until delegated execution
is implemented.

`plan <idea.md>` initializes or resumes `.draftforge/planning.json` without
calling a provider. The planning loop can be driven manually without any
adapter:

```text
draftforge plan idea.md                     # start or resume a revision
draftforge plan --prompt                    # print the architect prompt
draftforge plan --submit questions.json     # apply the one-batch interview
draftforge plan --answer Q1="Node.js 22"    # record answers, repeatable
draftforge plan --prompt
draftforge plan --submit plan.json          # apply the structured plan
draftforge plan --approve --by <actor>
```

Alternatively, `draftforge plan --run` drives exactly one architect turn
through the adapter configured for the architect role and records its response.
Run it once for the question batch, record answers, then run it once for the
draft plan. The manual `--prompt` and `--submit` checkpoints remain unchanged.

The architect returns one JSON envelope per turn — `{"kind":"questions",…}` or
`{"kind":"plan",…}` — and the expected kind is derived from planning state, so an
off-stage or malformed response is rejected rather than partially applied. Phase 3
adapters produce the same envelope through the model-runner port. `plan --approve`
materializes the accepted phases, ADRs, and task files before making active phase
roots runnable.

An approved plan then changes only through a recorded revision:

```text
draftforge plan --revise --reason "Reporting must export CSV" --by sujan
draftforge plan --prompt                    # the revision restates its questions
draftforge plan --submit questions-r2.json  # recorded answers carry forward
draftforge plan --answer Q3="Yes, CSV and text"
draftforge plan --submit plan-r2.json
draftforge plan --approve --by sujan
```

`--revise` records the reason, actor, and predecessor revision, and withdraws
readiness the superseded plan justified before anything else changes. Approving
the revision keeps recorded progress: `done` stays `done` unless `--reopen`
names it, in-flight tasks keep their status, and dropping a started or completed
task is rejected unless `--retire` names it. Re-materialization rewrites only
files DraftForge generated; an edited ADR or task contract blocks approval
instead of being overwritten. A revision is never approved implicitly.

`status` validates canonical state, the discovered configuration, and `SESSION.md`.
`doctor` reports those project checks plus availability and authentication for
each configured role adapter. Missing commands, local logins, and API-key
variables are reported as `missing` and do not fail the command; invalid
configuration or an authentication-status probe error returns a non-zero exit.
Secret values and authentication command output are never printed.

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

For Codex, `codex login` supports ChatGPT subscription sign-in, and the adapter
uses `codex exec` non-interactively. The Claude Code adapter similarly uses
`claude --print`. Both send the system and user prompt through stdin instead of
process arguments. Model IDs are configuration, not source-code constants:
`provider-default` omits the model flag so the local harness chooses its
default, while an explicit configured model is forwarded.

The API adapters read `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` from the
environment only; keys are never written to project state, logs, or evidence.
`provider-default` resolves to each provider's current default model inside the
provider layer, so config and domain never pin a volatile model ID. HTTP 401 and
403 are terminal authentication errors, while 429 and 5xx are retried as
transient. No vendor SDK is used — requests go through the runtime `fetch`.

## Provider layer

Architect, worker, and reviewer roles reach models through one model-runner
port. `createModelRunner(config)` (in `src/providers/`) routes each role to its
configured adapter and wraps every call in shared reliability: a per-call
timeout, bounded retry of transient failures only, and secret redaction on the
surfaced error. Adapters expose capability discovery as pure data and classify
failures as transient or terminal; authentication and contract errors are never
retried. The Codex CLI and Claude Code adapters share one injectable
child-process transport, use existing local authentication, and report
capabilities without launching a process or probing the network. The OpenAI and
Anthropic API adapters share one injectable `fetch` transport, authenticate with
environment keys, and map HTTP status onto the same transient/terminal error
contract. Every adapter passes one reusable contract-test suite against a faked
boundary, so tests make no real network or process call.

Live provider smoke tests are disabled during routine checks. Set
`DRAFTFORGE_LIVE_SMOKE=1` to opt in; each test still skips unless its local
harness is authenticated or its provider key is present.

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

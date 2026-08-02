# Provider setup

DraftForge routes three roles — architect, worker, and reviewer — independently
through one model-runner port. Each role names an adapter, a model, and a
reasoning level in `.draftforge/config.json`. Four adapters ship:

| Adapter | Transport | Authentication | Workspace-capable | Can run a worker |
| --- | --- | --- | --- | --- |
| `codex-cli` | local harness process | local CLI login | yes | yes |
| `claude-cli` | local harness process | local CLI login | yes | yes |
| `openai-api` | HTTPS via runtime `fetch` | `OPENAI_API_KEY` | no | no |
| `anthropic-api` | HTTPS via runtime `fetch` | `ANTHROPIC_API_KEY` | no | no |

No vendor SDK is used. API adapters call the provider's HTTP endpoint through
the runtime `fetch`; harness adapters spawn the local CLI with the prompt on
stdin.

## Workspace-capable versus text-only

This distinction decides which adapters can run a worker, and it is enforced
before any state changes.

**Workspace-capable** (`codex-cli`, `claude-cli`) — these are local harnesses
that honor a working directory. A worker attempt runs inside an isolated Git
worktree at `.draftforge/runs/<run-id>/worktrees/<task-id>`, so only an adapter
that can execute in that directory can do worker work.

**Text-only** (`openai-api`, `anthropic-api`) — these adapters exchange text.
They cannot execute in a local workspace, so they cannot make the file changes a
worker result would claim. They are fully usable for the **architect** and
**reviewer** roles, which are text-only by nature: the architect produces a
question batch or a plan envelope, and the reviewer reads persisted machine
evidence and returns a verdict.

If `roles.worker.adapter` is an API adapter, `draftforge run` and
`draftforge resume` refuse the command **before claiming any task**, exit `2`,
and change nothing:

```text
The configured worker route is text-only or does not declare workspace access.
Select a workspace-capable codex-cli or claude-cli worker before claiming a task.
```

Exit `2` from `run`/`resume` always means "refused before touching task state" —
the same class as bad options or an unapproved plan. Nothing needs cleaning up.

## Configuration file

`init` writes `.draftforge/config.json`. Its full shape:

```json
{
  "$schema": "./schema/config.schema.json",
  "roles": {
    "architect": { "adapter": "codex-cli", "model": "provider-default", "reasoning": "high" },
    "worker": { "adapter": "claude-cli", "model": "provider-default", "reasoning": "medium", "maxConcurrency": 2 },
    "reviewer": { "adapter": "codex-cli", "model": "provider-default", "reasoning": "high" }
  },
  "limits": {
    "maxRepairAttempts": 2,
    "taskTimeoutMinutes": 30
  }
}
```

Rules the validator enforces:

- `adapter` must be one of `codex-cli`, `claude-cli`, `openai-api`,
  `anthropic-api`.
- `model` must be a non-empty string.
- `reasoning` must be one of `low`, `medium`, `high`, `xhigh`.
- `maxConcurrency` exists only on `worker`, and must be an integer 1–16.
- `maxRepairAttempts` must be an integer 0–10; `taskTimeoutMinutes` must be a
  positive integer. `taskTimeoutMinutes` is also the default per-model-call
  timeout.
- Unknown properties are rejected, at every level.

`draftforge status` and `draftforge doctor` both report a `config` check and
fail if the merged configuration is invalid.

## `provider-default` versus an explicit model id

`"model": "provider-default"` means "let the provider decide". It is resolved in
the provider layer, never in configuration or domain code:

- `codex-cli` omits the `--model` flag from `codex exec`, so the harness uses
  its own current default.
- `claude-cli` omits the `--model` flag from `claude --print`, same effect.
- `openai-api` substitutes the default model constant in
  `src/providers/api/openai-api.ts`.
- `anthropic-api` substitutes the default model constant in
  `src/providers/api/anthropic-api.ts`.

Any other string is forwarded verbatim as the model id. Use an explicit id when
you need a pinned, reproducible route; use `provider-default` when you would
rather track the provider's moving default without editing configuration.

Reasoning level maps per adapter: `codex-cli` and `claude-cli` receive it as
routing metadata only; `openai-api` sends `reasoning_effort` and collapses
`xhigh` to `high`; `anthropic-api` enables extended thinking with a token budget
at `high` and `xhigh` and stays on the fast non-thinking path at `low` and
`medium`.

## Copyable configurations

### Claude Code harness (`claude-cli`) — worker-capable

The recommended worked example. Claude Code runs the worker inside the attempt
worktree, and the Anthropic API handles the two text-only roles.

```json
{
  "$schema": "./schema/config.schema.json",
  "roles": {
    "architect": { "adapter": "claude-cli", "model": "provider-default", "reasoning": "high" },
    "worker": { "adapter": "claude-cli", "model": "provider-default", "reasoning": "medium", "maxConcurrency": 2 },
    "reviewer": { "adapter": "claude-cli", "model": "provider-default", "reasoning": "high" }
  },
  "limits": { "maxRepairAttempts": 2, "taskTimeoutMinutes": 30 }
}
```

Requires the `claude` command on `PATH` and an active local login. The adapter
invokes `claude --print --output-format text` and writes the prompt to stdin.

### Codex CLI harness (`codex-cli`) — worker-capable

```json
{
  "$schema": "./schema/config.schema.json",
  "roles": {
    "architect": { "adapter": "codex-cli", "model": "provider-default", "reasoning": "high" },
    "worker": { "adapter": "codex-cli", "model": "provider-default", "reasoning": "medium", "maxConcurrency": 2 },
    "reviewer": { "adapter": "codex-cli", "model": "provider-default", "reasoning": "high" }
  },
  "limits": { "maxRepairAttempts": 2, "taskTimeoutMinutes": 30 }
}
```

Requires the `codex` command on `PATH` and an active local login. The adapter
invokes `codex exec -` and writes the prompt to stdin.

### Anthropic API (`anthropic-api`) — text-only roles

Automation example: Claude Code does the workspace work, the Anthropic API does
the reading and judging.

```json
{
  "$schema": "./schema/config.schema.json",
  "roles": {
    "architect": { "adapter": "anthropic-api", "model": "provider-default", "reasoning": "high" },
    "worker": { "adapter": "claude-cli", "model": "provider-default", "reasoning": "medium", "maxConcurrency": 2 },
    "reviewer": { "adapter": "anthropic-api", "model": "provider-default", "reasoning": "high" }
  },
  "limits": { "maxRepairAttempts": 2, "taskTimeoutMinutes": 30 }
}
```

Requires `ANTHROPIC_API_KEY` in the environment. Setting `anthropic-api` on
`roles.worker` is a configuration error in practice: it validates, but `run`
and `resume` refuse it at exit `2`.

### OpenAI API (`openai-api`) — text-only roles

```json
{
  "$schema": "./schema/config.schema.json",
  "roles": {
    "architect": { "adapter": "openai-api", "model": "provider-default", "reasoning": "high" },
    "worker": { "adapter": "codex-cli", "model": "provider-default", "reasoning": "medium", "maxConcurrency": 2 },
    "reviewer": { "adapter": "openai-api", "model": "provider-default", "reasoning": "high" }
  },
  "limits": { "maxRepairAttempts": 2, "taskTimeoutMinutes": 30 }
}
```

Requires `OPENAI_API_KEY` in the environment.

### Pinning explicit model ids

Any of the blocks above accepts a concrete id instead of `provider-default`:

```json
{
  "roles": {
    "reviewer": { "adapter": "anthropic-api", "model": "claude-sonnet-5", "reasoning": "high" }
  }
}
```

DraftForge does not validate that a model id exists; a wrong id surfaces as a
provider error at call time.

## Local overrides: `.draftforge/config.local.json`

`.draftforge/config.local.json` is an optional deep override of
`.draftforge/config.json`. DraftForge loads the base file, deeply merges the
local file over it, and validates the **merged** result against the same schema.
An error message names which file made the configuration invalid.

Use it for machine-specific routes you do not want to commit — for example,
running everything through Claude Code on a laptop where Codex CLI is not
installed:

```json
{
  "roles": {
    "architect": { "adapter": "claude-cli", "model": "provider-default", "reasoning": "high" },
    "reviewer": { "adapter": "claude-cli", "model": "provider-default", "reasoning": "high" }
  }
}
```

Note: `init` does not write a `.gitignore` into a new project. This repository
ignores `.draftforge/config.local.json`, `.draftforge/runs/`, and
`.draftforge/backups/`; add the same three entries to your own project's
`.gitignore` so a local override and generated run artifacts are never
committed.

## Environment variables

DraftForge reads exactly two secret variables, by name only:

- `OPENAI_API_KEY` — required by the `openai-api` adapter.
- `ANTHROPIC_API_KEY` — required by the `anthropic-api` adapter.

Both are read from the process environment. They are never written to project
state, configuration, logs, evidence, or events, and the shared redactor scrubs
them from surfaced error text. Do not put a key in `.draftforge/config.json` or
`.draftforge/config.local.json` — there is no configuration field for one, and
the strict validator rejects unknown properties.

The repository ships `.env.example` with both names and no values. Never commit
a filled-in `.env`, and never paste a key value into an issue, a log, or a
prompt.

Harness adapters (`codex-cli`, `claude-cli`) use whatever local login the CLI
already holds. DraftForge does not read, store, or forward those credentials.
Verification commands run with a minimal replacement environment that
deliberately excludes provider credentials, so a task's own commands never see
your keys.

## What `draftforge doctor` reports

```bash
draftforge doctor
```

`doctor` checks Git plus the adapter behind each configured role, and then the
project health checks. Duplicate adapter routes are probed once and reused.
Output is one line per check:

```text
[PASS] Git: command available
[PASS] architect adapter (codex-cli): command available; authentication is active
[MISSING] worker adapter (claude-cli): command not found on PATH; authentication is missing
[PASS] reviewer adapter (codex-cli): command available; authentication is active
[PASS] state: .draftforge/state.json is valid
[PASS] config: configuration is valid
[PASS] handoff: SESSION.md matches canonical state
```

Statuses:

- **`pass`** — for a harness: the command is on `PATH` and its authentication
  probe succeeded. For an API adapter: the key variable is set and non-empty.
  An API `pass` is *not* network-verified; it only means the variable is
  present.
- **`missing`** — the harness command is not on `PATH`, the harness reports it
  is not logged in, or the API key variable is unset or empty. `missing` **does
  not fail the command**; `doctor` still exits `0`. It is a statement about
  setup you have not done yet, not an error.
- **`fail`** — something is wrong rather than absent: availability could not be
  checked, the authentication probe could not be run or interpreted, the
  authentication configuration is invalid, or a project health check
  (`state`, `config`, `handoff`) failed. Any `fail` makes `doctor` exit `1`.

Per adapter:

| Adapter | `doctor` probes | `missing` means |
| --- | --- | --- |
| `codex-cli` | `codex` on `PATH`, then `codex login status` | `codex` not installed, or not logged in |
| `claude-cli` | `claude` on `PATH`, then `claude auth status` | `claude` not installed, or not logged in |
| `openai-api` | `OPENAI_API_KEY` present and non-empty | variable unset or empty |
| `anthropic-api` | `ANTHROPIC_API_KEY` present and non-empty | variable unset or empty |

`doctor` never prints an environment value and never prints the harness
authentication command's stdout or stderr. It only classifies the outcome.

Capability discovery itself performs no I/O — deciding whether a route is
workspace-capable never launches a process or touches the network.

## Fixing a `missing` adapter

- `codex-cli`: install Codex CLI and run `codex login` (ChatGPT subscription
  sign-in is supported). Re-check with `codex login status`.
- `claude-cli`: install Claude Code and complete its login flow, then re-check
  with `claude auth status`.
- `openai-api` / `anthropic-api`: export the named variable in the shell that
  will run `draftforge`. Do not echo it back.

Then re-run `draftforge doctor`.

## Usage accounting

Usage is reported, never estimated. The run ledger aggregates provider-reported
token counts and derives cost only for models with a known price. Harness calls
and unpriced models record `unknown`. Prompts, completions, and credentials
never enter the ledger. `draftforge status` surfaces the per-run totals.

## Related documentation

- [INSTALLATION.md](INSTALLATION.md) — installing the CLI
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — authentication and lock symptoms
- [EXAMPLE.md](EXAMPLE.md) — an end-to-end local run
- [PROTOCOL.md](PROTOCOL.md) — capability limits and command outcomes
- [decisions/0002-provider-port-and-role-routing.md](decisions/0002-provider-port-and-role-routing.md)
- [decisions/0008-provider-adapter-contract.md](decisions/0008-provider-adapter-contract.md)

# Provider setup

Roles are routed independently in `.draftforge/config.json`, with optional local
overrides in `.draftforge/config.local.json`. Initialization does not create
`.gitignore`; the operator must add this override to ignore rules. Ignored files
are not encrypted or safe to share.

| Adapter | Authentication | Architect/reviewer | Workspace worker |
| --- | --- | --- | --- |
| `codex-cli` | Local Codex CLI login | Yes | Yes |
| `claude-cli` | Local Claude Code login | Yes | Yes |
| `openai-api` | `OPENAI_API_KEY` | Yes | No |
| `anthropic-api` | `ANTHROPIC_API_KEY` | Yes | No |

API adapters are text-only. `run` and `resume` refuse an API worker before
changing state. After a routing change, run `draftforge doctor`. It checks Git,
command/auth status, or key presence without printing values or auth output;
key presence is not a network authentication test.

## Codex CLI

Install and authenticate Codex CLI through its official instructions; confirm
`codex login status` succeeds.

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

## Claude Code

Install and authenticate Claude Code through its official instructions; confirm
`claude auth status` succeeds. This all-Claude configuration supports workspace
automation:

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

## OpenAI API

Inject `OPENAI_API_KEY` through the shell, secret manager, or CI environment;
never store its value in config. Pair this text-only route with a local worker:

```json
{
  "$schema": "./schema/config.schema.json",
  "roles": {
    "architect": { "adapter": "openai-api", "model": "provider-default", "reasoning": "high" },
    "worker": { "adapter": "claude-cli", "model": "provider-default", "reasoning": "medium", "maxConcurrency": 2 },
    "reviewer": { "adapter": "openai-api", "model": "provider-default", "reasoning": "high" }
  },
  "limits": { "maxRepairAttempts": 2, "taskTimeoutMinutes": 30 }
}
```

## Anthropic API

Inject `ANTHROPIC_API_KEY` without storing it in the project. This example uses
Anthropic for architecture/review and Claude Code for workspace automation:

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

`provider-default` lets each adapter select its current default. Use a non-empty
provider-supported model string to pin one. New projects default to Codex CLI
for architect/reviewer and Claude Code for worker. See
[Troubleshooting](TROUBLESHOOTING.md) for auth and shim failures.

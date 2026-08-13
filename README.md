# DraftForge

DraftForge is a local-first CLI that turns a rough Markdown idea into recorded
architecture decisions, an approved task graph, isolated worker execution, and
machine-first review.

> **Release identity:** `@draftforge-dev/draftforge@0.1.0` is the initial public
> CLI version. Check the [npm package](https://www.npmjs.com/package/@draftforge-dev/draftforge)
> and [GitHub releases](https://github.com/darkweb19/draftforge/releases) for
> current availability and release records.

## Install

Requirements: Node.js 22 or newer and Git. Windows, macOS, and Linux are the
supported release targets.

The public package identity is `@draftforge-dev/draftforge`, with npmjs as its
canonical registry. The unscoped `draftforge` package on npm belongs to an
unrelated project.

```bash
npm install --global @draftforge-dev/draftforge
draftforge --version
```

Repository developers can build and verify the local `0.1.0` tarball instead:

```bash
npm install
npm run package:pack
npm run package:smoke -- ./draftforge-dev-draftforge-0.1.0.tgz
npm install --global ./draftforge-dev-draftforge-0.1.0.tgz
draftforge --version
```

The tarball name follows the version in `package.json`. `package:smoke` installs
that exact artifact in a clean temporary project and exercises the npm-generated
binary without a provider or network call. Remove the globally installed package
with `npm uninstall --global @draftforge-dev/draftforge`.

Release automation targets GitHub Packages as a repository-linked mirror of the
same tested tarball; it is not the default install source and requires explicit
GitHub registry configuration.

See [Installation](https://github.com/darkweb19/draftforge/blob/main/docs/INSTALLATION.md)
for registry status, initialization, upgrades, and uninstall details.

## Shortest working flow

These are installed-CLI commands. The generated configuration defaults to
Codex CLI for the architect and reviewer and Claude Code for the workspace
worker.

```text
draftforge init my-app
cd my-app
git init
# Describe the project in idea.md.
# Add the DraftForge ignore entries shown below to .gitignore.
git add AGENTS.md CLAUDE.md PHASES.md SESSION.md idea.md .gitignore .draftforge/config.json .draftforge/schema .draftforge/state.json .draftforge/tasks/.gitkeep .draftforge/runs/.gitkeep
git commit -m "chore: initialize project"
draftforge doctor
draftforge plan idea.md
draftforge plan --run
draftforge plan --answer <id>=<text>
draftforge plan --run
draftforge plan --approve --by <actor>
git add .draftforge/planning.json .draftforge/state.json .draftforge/tasks PHASES.md SESSION.md docs/decisions
git commit -m "chore: approve DraftForge plan"
draftforge run --by <actor>
draftforge review --by <actor>
```

The first architect turn returns one batch of questions. Record every blocking
answer, then run the architect again for the plan. Approval materializes the
ADRs, phases, and bounded task contracts. `run` sends ready work to isolated Git
worktrees; `review` runs verification, scope and secret checks, independent
review, bounded repair, and integration. Use `draftforge resume` only for an
interrupted attempt; it does not claim new work.

`init` does not create `.gitignore`. Before the first commit, add these entries
yourself so local credentials and generated run/backup artifacts do not make the
project root dirty:

```gitignore
.draftforge/config.local.json
.draftforge/runs/*
!.draftforge/runs/.gitkeep
.draftforge/backups/
```

Ignored files are not encrypted or safe to share. The explicit `git add` lists
above avoid staging unrelated files. `<id>`, `<text>`, and `<actor>` are
placeholders that must be replaced.

## Providers

Each role is routed independently in `.draftforge/config.json` or the optional
`.draftforge/config.local.json` override. Add the local override to the target
project's `.gitignore`; initialization does not do that for you.

| Adapter | Authentication | Architect/reviewer | Workspace worker |
| --- | --- | --- | --- |
| `codex-cli` | Existing local Codex CLI login | Yes | Yes |
| `claude-cli` | Existing local Claude Code login | Yes | Yes |
| `openai-api` | `OPENAI_API_KEY` in the environment | Yes | No |
| `anthropic-api` | `ANTHROPIC_API_KEY` in the environment | Yes | No |

API adapters are text-only. Configuring one as the worker makes `run` and
`resume` refuse before task state changes. `draftforge doctor` checks the
configured routes using `codex login status`, `claude auth status`, or API-key
presence without printing credential values or authentication command output.

This is a valid hybrid configuration:

```json
{
  "$schema": "./schema/config.schema.json",
  "roles": {
    "architect": {
      "adapter": "openai-api",
      "model": "provider-default",
      "reasoning": "high"
    },
    "worker": {
      "adapter": "claude-cli",
      "model": "provider-default",
      "reasoning": "medium",
      "maxConcurrency": 2
    },
    "reviewer": {
      "adapter": "anthropic-api",
      "model": "provider-default",
      "reasoning": "high"
    }
  },
  "limits": {
    "maxRepairAttempts": 2,
    "taskTimeoutMinutes": 30
  }
}
```

For harness adapters, `provider-default` lets the configured Codex or Claude
harness choose its default model. API adapters resolve it inside their provider
layer. Set an explicit model string when a role must use a specific model.

See [Provider setup](https://github.com/darkweb19/draftforge/blob/main/docs/PROVIDERS.md)
for copyable configurations for all four adapters and their authentication
boundaries.

## Planning checkpoints

`draftforge plan <idea.md>` initializes or resumes
`.draftforge/planning.json` without calling a provider. `plan --run` invokes the
configured architect. To use an external model or inspect each checkpoint, use
the provider-neutral loop:

```text
draftforge plan --prompt
draftforge plan --submit questions.json
draftforge plan --answer <id>=<text>
draftforge plan --prompt
draftforge plan --submit plan.json
draftforge plan --approve --by <actor>
```

An approved plan changes only through `plan --revise`; revisions preserve
recorded progress unless completed tasks are explicitly reopened or retired.
DraftForge refuses to overwrite edited generated ADRs or task contracts during
re-materialization.

## Execution, review, and recovery

Task states follow `backlog -> ready -> active -> review -> done`, with unsafe
or exhausted work moving to `blocked`. `.draftforge/state.json` is canonical;
`SESSION.md` is generated from it.

- `run` reconciles state, then claims ready non-conflicting tasks up to
  `roles.worker.maxConcurrency`.
- `resume` continues interrupted attempts in their existing worktrees and never
  claims new tasks.
- `review` runs the task's allowlisted verification, checks scope, scans for
  secrets, asks an independent reviewer, runs bounded repairs when allowed, and
  integrates accepted work.

Attempt manifests, events, results, and worktrees live under
`.draftforge/runs/`. Interrupted, uncertain, blocked, or invalid work is retained
for inspection. Add `.draftforge/runs/*` plus the `.gitkeep` exception shown in
the quickstart to `.gitignore`; initialized targets do not receive that rule
automatically. Worktrees isolate Git changes; they are not security sandboxes.

Verification accepts only `npm run <script>` and `node <relative-path>` with
literal arguments. It does not allow shell operators, redirection, absolute
paths, traversal, flags, or arbitrary programs. Allowed repository scripts
still execute project code. Secret findings store only a rule ID, relative path,
and line number, but no scanner can guarantee that every possible secret is
detected.

Integration requires a clean project root. DraftForge records the pre-merge
head as a rollback point, retains the worktree on failure, and never stashes,
resets, or rolls back automatically. Inspect the recorded commits before doing
any manual recovery.

## Project upgrades

`draftforge upgrade` is the only command that persists a state-schema migration.
It upgrades supported v1 or v2 projects to v3, refreshes only recognized
DraftForge-managed schemas, regenerates `SESSION.md`, and writes canonical state
last. A current project with current schemas is a no-op.

Before replacing anything, the command creates a timestamped directory under
`.draftforge/backups/`. Its `upgrade-manifest.json` lists every replaced and
created path. DraftForge does not promise automatic rollback: after a failed
upgrade, restore each replaced path and remove each created path listed in that
manifest before retrying.

Upgrade refuses unsafe conditions before mutation, including future or malformed
state, in-flight or uncertain execution/review work, modified managed schemas,
unrecognized recovery artifacts, and symlinked or non-regular managed paths. If
a target drifts after planning, the operation fails with a completed backup and
requires the same manifest-based recovery before retrying.

Read the full [upgrade and recovery guide](https://github.com/darkweb19/draftforge/blob/main/docs/UPGRADING.md)
before changing a project with retained work.

## Command reference

```text
draftforge --version
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
draftforge run [--by <actor>]
draftforge resume [--by <actor>]
draftforge review [--by <actor>]
draftforge upgrade
draftforge handoff
```

`status` validates canonical state, configuration, and the generated handoff.
`handoff` regenerates `SESSION.md` from canonical state. For `run` and `resume`,
exit `0` means nothing failed, `1` means blocked work or manual inspection, and
`2` means refusal before task-state mutation. `review` uses `2` for invalid
options. `upgrade` uses `2` for an unsafe refusal and `1` for a failure that
already created a recovery backup. Other commands report their own outcomes.

## Repository development

These commands run from the DraftForge source repository, not from an installed
project:

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run check
npm run build
npm run dev -- status
```

Development and the packaged CLI both require Node.js 22 or newer. Live provider
smoke tests are opt-in with `DRAFTFORGE_LIVE_SMOKE=1` and still require the
corresponding local login or API-key variable. Routine checks do not make paid
provider calls.

## Release records

`package.json` is the version authority. The npm package and GitHub release
records show which versions are currently published. Each release is built and
tested as one exact tarball across Ubuntu, macOS, and Windows before registry
publication; a local smoke result alone is not release evidence.

## Security boundaries

Keep credentials in environment variables. Add machine-specific
`.draftforge/config.local.json` to `.gitignore` yourself; never commit secrets.
Local harness workers can access their assigned workspace, while API providers
receive the prompt and context sent to them.

Retained worktrees and run artifacts may contain project data. They are ignored
only after the operator adds the rules shown above. Ignored means Git does not
stage them by default; it does not mean encrypted, deleted, or safe to share.
Review retained artifacts before collecting diagnostics and never attach
environment files, credentials, raw provider output, or unrelated source.

Do not put sensitive vulnerability details in a public issue. Use the security
policy to find the current private-reporting path or its safe fallback.

Read the [security policy](https://github.com/darkweb19/draftforge/blob/main/SECURITY.md)
for the private-reporting fallback, evidence rules, worktree risks, and provider
boundaries.

## Repository map

- [Product specification](https://github.com/darkweb19/draftforge/blob/main/docs/PRODUCT_SPEC.md)
- [Architecture](https://github.com/darkweb19/draftforge/blob/main/docs/ARCHITECTURE.md)
- [Execution and review protocol](https://github.com/darkweb19/draftforge/blob/main/docs/PROTOCOL.md)
- [Installation](https://github.com/darkweb19/draftforge/blob/main/docs/INSTALLATION.md)
- [Provider setup](https://github.com/darkweb19/draftforge/blob/main/docs/PROVIDERS.md)
- [Complete example](https://github.com/darkweb19/draftforge/blob/main/docs/EXAMPLE.md)
- [Project upgrades](https://github.com/darkweb19/draftforge/blob/main/docs/UPGRADING.md)
- [Troubleshooting](https://github.com/darkweb19/draftforge/blob/main/docs/TROUBLESHOOTING.md)
- [Security policy](https://github.com/darkweb19/draftforge/blob/main/SECURITY.md)
- [Changelog](https://github.com/darkweb19/draftforge/blob/main/CHANGELOG.md)
- [Release artifact and upgrade ADR](https://github.com/darkweb19/draftforge/blob/main/docs/decisions/0011-release-artifact-upgrades-and-provenance.md)
- [Example idea](https://github.com/darkweb19/draftforge/blob/main/examples/local-notes/idea.md)
- [Delivery phases](https://github.com/darkweb19/draftforge/blob/main/PHASES.md)
- [Generated session handoff](https://github.com/darkweb19/draftforge/blob/main/SESSION.md)

Values such as `my-app`, `<id>`, `<text>`, `<actor>`, `example-operator`, and
response filenames are placeholders for the examples above.

## License

MIT

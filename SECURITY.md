# Security policy

DraftForge runs models against your source tree and executes commands those
models produce. This document states what it defends, what it does not, and how
to report a vulnerability.

## Supported releases

DraftForge has not been published to a package registry. The package is marked
`private` and carries a pre-release version, so there is no supported released
version yet.

During the pre-release period, only the current `main` branch and the most
recent release-candidate tarball receive fixes. Once a scoped package is
published, this section will name the supported version range.

The unscoped `draftforge` name on the public npm registry belongs to an
unrelated third-party project. It is not this software, it is not maintained by
this project, and installing it will not give you this CLI. Report nothing about
it here.

## Reporting a vulnerability

Report privately by email to [hi@sujanshrestha.ca](mailto:hi@sujanshrestha.ca),
the repository owner's existing contact address. There is no dedicated security
inbox, and GitHub private vulnerability reporting is not currently enabled for
this repository.

Do not open a public issue, pull request, or discussion for a suspected
vulnerability. Please include the affected version or commit, the platform, and
a minimal reproduction.

**Do not include credentials in a report.** If a report requires evidence from
your project, follow the safe evidence-collection steps in
[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) and redact anything you have
not verified is safe to share.

Expect an acknowledgement within a few days. There is no paid bounty program.

## Secret handling

DraftForge treats credentials as values it must never observe more than
transiently.

- API keys are read from the environment only — `OPENAI_API_KEY` and
  `ANTHROPIC_API_KEY`. They are never written to project state, configuration,
  event logs, attempt evidence, or generated documentation.
- Harness routes (`codex-cli`, `claude-cli`) use the harness's own existing
  local login. DraftForge does not read, copy, or relay those credentials.
- `doctor` reports authentication as `pass`, `missing`, or `fail`. It never
  prints an environment value or the output of an authentication command.
- Every recorded event and evidence artifact is secret-redacted before it is
  written. Raw model text and provider error causes are not persisted.
- Local configuration overrides belong in `.draftforge/config.local.json`. Never
  put a secret in `.draftforge/config.json`.
- Verification commands run with a minimal replacement environment, so provider
  credentials are not forwarded into project-supplied commands.

### Secret scanning is a safety net, not a guarantee

Before work is accepted, DraftForge scans the attempt diff and untracked
candidate files for credentials. A detection records **only** a rule ID, a
repository-relative path, and a line number — never the value, a substring of
it, or surrounding line content, because evidence files get committed and
shared.

This scanner uses pattern rules. It will miss credential formats it does not
recognize. Do not treat a clean scan as proof that no secret was introduced, and
do not rely on it in place of a pre-commit secret scanner or server-side push
protection.

## Worktree and run-artifact risks

Each execution attempt gets its own Git worktree under
`.draftforge/runs/<run-id>/worktrees/<task-id>`, and cleanup is deliberately
conservative: interrupted, timed-out, blocked, and scope-violating attempts keep
their worktree for inspection.

That means **model-produced content persists on disk after a failure**, and it
has not necessarily passed review. Treat these directories as untrusted
material:

- `.draftforge/runs/` and `.draftforge/backups/` must be ignored by Git.
  **`init` does not write a `.gitignore`, so a new project does not ignore them
  until you do.** Add those entries plus `.draftforge/config.local.json` before
  your first commit. Do not attach these directories wholesale to a bug report.
- Inspect a retained worktree before reusing anything from it.
- A worktree tied to a live or indeterminate worker process is never reused by
  another worker; do not force it.
- Upgrade backups under `.draftforge/backups/` contain copies of your previous
  project files. They inherit the sensitivity of whatever they replaced.

## Verification limits

DraftForge runs the verification commands declared in a task contract. That is
code execution, so the shape is constrained rather than trusted:

- Commands are shell-free. Only `npm run <script>` and `node <relative-path>`
  with literal arguments are permitted.
- A shell operator, redirection, path traversal, absolute path, flag, or any
  other program is a `contract-violation` that **blocks** the task. It is not a
  check that gets skipped.
- Commands execute inside the attempt worktree, not the project root.
- The environment is a minimal replacement, not your shell environment.

What this does not do: it does not sandbox the command. `npm run build` in your
own project still runs your own build scripts with your own filesystem access. A
task contract is part of your project, so review contracts you did not write.

## Provider and worker trust boundaries

Model output is untrusted input, and the worker's own claims about its work are
untrusted:

- Architect responses are parsed as raw text in the application layer and
  schema-validated before they can reach domain state. A malformed or off-stage
  envelope is rejected, not partially applied.
- **Scope is enforced from a content-derived Git diff of the worktree, not from
  the paths a worker reports.** A worker that edits outside its owned paths is
  caught regardless of what it says it did.
- Git control surfaces a worker could mutate are treated as untrusted during
  inspection: executable clean/process filters, mutable fsmonitor or hook
  configuration, unsafe index/history/exclusion controls, tracked submodules,
  and line-ending normalization overrides all fail closed.
- Ignored untracked trees are enumerated with hard depth, entry, file, and byte
  caps, and every traversal step is bound to canonical path plus device/inode
  identity, so a symlink swap cannot substitute content mid-scan.
- Review is machine-first. A reviewer may reject work that passed the machine
  checks, but **it can never accept work that failed them.**
- Only workspace-capable harness routes can run a worker. A text-only API route
  is refused before any task state changes.

The models themselves are third-party services under their own terms. Prompts,
task contracts, and the file contents a worker is given leave your machine when
you use an API-backed or harness-backed route. Do not point DraftForge at a
repository whose contents you are not permitted to send to that provider.

## Integration and rollback

Accepted work is re-scanned and re-checked for scope, then merged from a clean
project root. DraftForge records the project branch head immediately before the
merge as a rollback point, and records the integration commit only after the
merge succeeds.

**Rollback is never automatic.** After inspection, an operator may revert the
recorded integration commit or reset to the recorded rollback point. A dirty
project root or a merge conflict aborts integration, preserves the worktree, and
blocks the task rather than stashing or overwriting your local changes.

## Scope

In scope: credential leakage into state, events, evidence, or generated files;
scope enforcement bypass; path traversal or symlink escape in managed paths;
upgrade or integration paths that destroy user data; execution of commands
outside the documented allowlist.

Out of scope: vulnerabilities in third-party model providers or harnesses;
issues that require an already-compromised local machine; the unrelated
unscoped `draftforge` package on npm.

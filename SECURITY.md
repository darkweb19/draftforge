# Security policy

## Supported releases

`@draftforge-dev/draftforge@0.1.0` is the initial release identity. Check the
[npm package](https://www.npmjs.com/package/@draftforge-dev/draftforge) and
[GitHub releases](https://github.com/darkweb19/draftforge/releases) to confirm
which versions are currently published. Security fixes target the current
published release line and the current repository branch; older versions may
require upgrading before a fix is available.

## Report a vulnerability privately

Do not disclose a vulnerability, credential, private source, or run artifact in
a public issue. Use the repository's **Security** tab and choose **Report a
vulnerability** if private reporting is enabled. If that option is absent,
withhold sensitive details and ask the owner through an existing private channel
to enable a private report. This project does not claim an unverified security
email address or external reporting account.

Include the affected version or commit, OS, Node.js version, minimal
reproduction, and impact. Replace real credentials and private source with
synthetic values before attaching evidence.

## Credential and data handling

- API credentials belong in the process environment, never configuration, task
  files, prompts, examples, or Git.
- Initialization does not create `.gitignore`. The operator must add
  `.draftforge/config.local.json`, `.draftforge/runs/*` (while retaining its
  `.gitkeep`), and `.draftforge/backups/` to the target project's ignore rules.
  Ignored files are not encrypted or safe to share.
- Redaction and secret scanning are defense in depth, not proof that an artifact
  is safe. Findings store only a rule ID, relative path, and line number.

## Worktrees, verification, and providers

Workers use retained Git worktrees under `.draftforge/runs/`. Isolation is not
an OS sandbox: a local harness can read and execute files available to its
process. Run artifacts can expose paths, diffs, and generated content. They are
not automatically ignored in initialized projects. Inspect and redact them
before sharing; never attach environment files, auth stores, raw provider
output, or unrelated source.

Verification permits only `npm run <script>` and `node <relative-path>` with
literal arguments, but those commands still execute project code. Scope checks
and the finite-pattern secret scanner are not a sandbox or safety guarantee.

`codex-cli` and `claude-cli` use local authenticated harnesses and can access
workspaces. `openai-api` and `anthropic-api` send supplied prompt/context to a
remote provider and are text-only. Provider retention and account policies are
outside DraftForge; verify them before sending sensitive material.

DraftForge records rollback points but never resets, reverts, or rolls back
automatically. See [provider setup](docs/PROVIDERS.md) and the
[execution protocol](docs/PROTOCOL.md).

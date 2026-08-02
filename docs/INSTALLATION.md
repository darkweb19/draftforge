# Installation

DraftForge is a single ESM Node.js CLI. Installing it gives you one executable,
`draftforge`. It needs no service, no account, and no network access to
initialize a project.

## Requirements

| Requirement | Value |
| --- | --- |
| Node.js (installed CLI) | 22 or newer (`engines.node: ">=22"`) |
| Node.js (repository development) | 24 (`.nvmrc`) |
| Package manager | npm (ships with Node.js) |
| Git | Required for `run`, `resume`, and `review`; optional for `init` |
| Operating systems | Linux, macOS, Windows |

Those two Node.js versions are not interchangeable. **22+** is the supported
floor for anyone running the installed CLI. **24** is what this repository's
`.nvmrc` pins for developing DraftForge itself; use it only when you are
building from the checkout.

Check what you have:

```bash
node --version
npm --version
git --version
```

Windows is supported through the same npm install. DraftForge does not use a
POSIX shell anywhere: it spawns child processes directly and, when a command
resolves to an npm `.cmd`/`.bat` shim, invokes it through an explicitly escaped
`cmd.exe` call. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) if a command is not
found on Windows.

## Package identity

DraftForge is **not published yet**.

- The published package will be scoped. Everywhere in this documentation the
  placeholder `@your-scope/draftforge` stands in for that name. The real scope
  is selected and locked in task P06-T04; until then no registry name is
  correct.
- **Never install the unscoped `draftforge` package from the public npm
  registry.** That name belongs to an unrelated third-party package and has
  nothing to do with this project. Installing it will not give you this CLI.

Until the scope is locked, the only supported install path is a locally packed
tarball built from this repository.

## Install a release candidate from a local tarball

This is the working path today.

### 1. Build the tarball

From a checkout of this repository, on Node.js 24:

```bash
npm install
npm run check
npm pack
```

`npm pack` runs `prepack`, which rebuilds `dist/` first, then writes a tarball
into the current directory. Because `package.json` currently declares version
`0.0.0`, the file is:

```text
draftforge-0.0.0.tgz
```

Substitute the version you actually packed wherever this page writes
`draftforge-<version>.tgz`.

Optionally audit and exercise the exact artifact before installing it:

```bash
npm run package:smoke -- ./draftforge-<version>.tgz
```

That script inspects the tarball's file list, installs it into a clean
temporary project, and drives the *installed* binary through `--version`,
`init`, `status`, and `handoff`. It must run through npm.

### 2a. Install globally

```bash
npm install -g ./draftforge-<version>.tgz
```

The tarball's package name is whatever `package.json` declares — today the
unscoped `draftforge`. That is a purely local name for a file you built
yourself; npm never contacts the registry for a tarball path, so this does not
install the unrelated public package. Once the scope is locked the packed name
becomes `@your-scope/draftforge`.

### 2b. Or install into one project

Global installs are convenient but shared. A project-local install pins the
exact CLI a repository was driven with:

```bash
npm install --save-dev ./draftforge-<version>.tgz
npx draftforge --version
```

With a project-local install, prefix every command on this site with `npx`.

## Verify the install

```bash
draftforge --version
```

The output must be exactly the `version` field of the `package.json` you packed
— `package.json` is the single version authority, and runtime output, tag,
tarball metadata, and published version are all required to agree. If
`draftforge --version` prints something else, you are running a different
installation than you think; see
[TROUBLESHOOTING.md](TROUBLESHOOTING.md#package-installation-problems).

Then confirm the CLI actually runs work:

```bash
draftforge help
draftforge init my-app
cd my-app
draftforge status
draftforge doctor
```

`init` needs no provider, login, or API key. `status` validates canonical state,
the discovered configuration, and `SESSION.md`. `doctor` adds harness
availability and API-key presence for each configured role adapter; see
[PROVIDERS.md](PROVIDERS.md) for how to read its output.

For a full worked run, see [EXAMPLE.md](EXAMPLE.md).

## Windows notes

- npm installs the executable as a shim. On Windows the resolved entry is
  `draftforge.cmd` in the npm prefix (global install) or in
  `node_modules\.bin\` (project install). If `draftforge` is not recognized,
  the npm prefix is not on `PATH`; check it with `npm config get prefix` and
  `where.exe draftforge`.
- The same shim mechanism applies to the provider harnesses DraftForge invokes.
  DraftForge resolves those through `where.exe`, preserves PATH order, and
  routes `.cmd`/`.bat` matches through an escaped `cmd.exe` invocation. Prompts
  always travel on stdin, never as command-line arguments.

## Registry installation (not available yet)

Once an owned scope is locked and the trusted publisher is configured, the
install becomes:

```bash
# NOT AVAILABLE YET — the scope is locked in P06-T04 and nothing is published.
npm install -g @your-scope/draftforge
```

Do not run that command until this page says the package is published. Until
then, use the local tarball.

## Uninstall

Global install:

```bash
npm uninstall -g draftforge     # today's locally packed name
npm uninstall -g @your-scope/draftforge   # after the scope is locked
```

Project-local install:

```bash
npm uninstall draftforge
```

Confirm the executable is gone:

```bash
draftforge --version   # should now fail with "command not found"
```

Uninstalling removes only the CLI. Your projects are untouched: DraftForge is
local-first and every project's state lives in that project's own
`.draftforge/` directory plus its generated `SESSION.md`. To remove a project's
DraftForge data as well, delete `.draftforge/` and `SESSION.md` from that
project. Generated run artifacts under `.draftforge/runs/` and upgrade backups
under `.draftforge/backups/` go with it — check
[UPGRADING.md](UPGRADING.md) before deleting a backup you might still need.

## Related documentation

- [PROVIDERS.md](PROVIDERS.md) — configuring adapters and authentication
- [UPGRADING.md](UPGRADING.md) — `draftforge upgrade`, backups, and recovery
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — symptoms, causes, and fixes
- [PROTOCOL.md](PROTOCOL.md) — task states, attempts, and command outcomes
- [ARCHITECTURE.md](ARCHITECTURE.md) — layering and boundaries
- [../README.md](../README.md) — project overview and repository development

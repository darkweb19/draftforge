# Installation

## Requirements

- Node.js 22 or newer and Git on `PATH`.
- Windows, macOS, or Linux.

The final three-OS gate has not passed, so this is a release candidate.

## Registry status

Do **not** install unscoped `draftforge` from npm; it is an unrelated project.
DraftForge stays private until an owned scope and trusted publisher are proven.
After that decision, this invented placeholder will be replaced:

```bash
npm install --global @YOUR_SCOPE/draftforge
draftforge --version
```

Do not run the placeholder unchanged.

## Install the local release candidate

From a clean DraftForge source checkout:

```bash
npm install
npm run package:pack
npm run package:smoke -- ./draftforge-0.0.0.tgz
npm install --global ./draftforge-0.0.0.tgz
draftforge --version
```

The tarball filename follows `package.json`; replace `0.0.0` when the version
changes. Packing builds first. Smoke audits and installs that exact artifact in
a temporary directory, then invokes its npm-generated binary for `--version`,
`init`, `status`, and `handoff` without a provider or network call. Do not
replace the artifact between smoke, platform testing, and publication.

## Initialize and upgrade

```bash
draftforge init my-project
cd my-project
draftforge status
```

Prefer an empty directory. `--force` explicitly approves replacement of
conflicting initialization files. Continue with the [example](EXAMPLE.md) and
[provider setup](PROVIDERS.md).

After installing a newer CLI, upgrade each managed project explicitly:

```bash
draftforge upgrade
draftforge status
```

Read [Upgrading](UPGRADING.md) first if work is retained or in flight.

## Uninstall

For the current local tarball metadata:

```bash
npm uninstall --global draftforge
```

The future command will be `npm uninstall --global @YOUR_SCOPE/draftforge`
with the verified scope. npm does not remove managed project directories or
`.draftforge/` state. See [PATH troubleshooting](TROUBLESHOOTING.md#package-installation-and-path)
if the command remains available.

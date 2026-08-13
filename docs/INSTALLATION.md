# Installation

## Requirements

- Node.js 22 or newer and Git on `PATH`.
- Windows, macOS, or Linux.

## Registry status

Do **not** install unscoped `draftforge` from npm; it is an unrelated project.
The public identity is `@draftforge-dev/draftforge`; `0.1.0` is the initial
release version, and npmjs is the canonical registry. Check the
[npm package](https://www.npmjs.com/package/@draftforge-dev/draftforge) and
[GitHub releases](https://github.com/darkweb19/draftforge/releases) for current
availability and release records. Install the current npmjs version with:

```bash
npm install --global @draftforge-dev/draftforge
draftforge --version
```

Release automation also publishes `@darkweb19/draftforge@0.1.0` as the public,
repository-linked GitHub Packages mirror. It comes from the same source commit
and exposes the same `draftforge` binary, but its package name and registry
manifest field produce a different tarball and digest. Users should install the
canonical npmjs package with the command above. The mirror is not the default
install source and requires explicit GitHub npm registry configuration.

## Verify a local tarball

Repository developers can build and verify version `0.1.0` from a clean
DraftForge source checkout:

```bash
npm install
npm run package:pack
npm run package:smoke -- ./draftforge-dev-draftforge-0.1.0.tgz
npm install --global ./draftforge-dev-draftforge-0.1.0.tgz
draftforge --version
```

The tarball filename follows the scoped name and version in `package.json`.
Packing builds first. Smoke audits and installs that exact artifact in a
temporary directory, then invokes its npm-generated binary for `--version`,
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

```bash
npm uninstall --global @draftforge-dev/draftforge
```

npm does not remove managed project directories or `.draftforge/` state. See
[PATH troubleshooting](TROUBLESHOOTING.md#package-installation-and-path) if the
command remains available.

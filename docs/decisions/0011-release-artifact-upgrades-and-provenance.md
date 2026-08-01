# ADR 0011: Tested release artifacts, explicit upgrades, and provenance

Status: accepted

## Decision

DraftForge releases one ESM npm CLI for Node.js 22 and newer. The npm tarball is
the release artifact: CI must build it from a clean checkout, install that exact
tarball into a clean temporary project, and invoke the installed `draftforge`
binary rather than `node dist/cli.js`. The smoke path must initialize a project,
validate it, and exercise a deterministic interrupted-work resume. The same
artifact and smoke contract run on Linux, macOS, and Windows.

`package.json` is the sole authority for the package version. Runtime
`--version`, the release tag, the packed metadata, and the published version
must agree with it. Packing builds first, the package uses an explicit files
allowlist, and CI inspects the tarball so ignored local `dist/` output cannot
make a dirty development tree look releasable.

Project upgrades are explicit. Reading an older supported state may continue to
migrate it in memory for compatibility, but only `draftforge upgrade` persists
an upgrade. The command holds the project lock, validates the complete candidate
before mutation, creates a recoverable backup, refreshes only DraftForge-owned
schema files whose provenance is recognized, writes state atomically, and then
renders `SESSION.md`. It refuses future schema versions, downgrades, modified
managed schemas, and projects with in-flight worker or reviewer work. It never
rewrites user-authored project files or generated task/decision documents.

Pull requests and release candidates run the full check plus installed-tarball
smoke tests on Ubuntu, macOS, and Windows, including the Node.js 22 minimum.
Publication is tag-gated: the tag and package version must match, all artifact
checks must pass, and GitHub Actions publishes the already-tested tarball through
npm trusted publishing with provenance and least-privilege OIDC permissions.
DraftForge does not use a long-lived npm token in the workflow.

The public registry identity is deliberately not guessed. The unscoped
`draftforge` name is already owned by an unrelated package, and this repository
has no authenticated npm identity from which an owned scope can be proven. The
package remains private until an owned scope is selected and the matching npm
trusted publisher is configured. That prerequisite blocks publication, not the
portable-package, upgrade, documentation, or CI work that precedes it.

## Why

Running built source directly is weaker evidence than running what users
install. Before this decision, a locally packed tarball installed successfully
while its npm-linked executable exited zero without running because the entry
guard compared the `.bin` symlink path with the resolved module URL. Testing the
installed binary is the smallest gate that catches packaging, shebang, symlink,
Windows shim, template inclusion, and version drift together.

An implicit write during an ordinary read would make `status` or `handoff`
surprisingly destructive and would leave no deliberate rollback point. An
explicit locked upgrade makes compatibility observable and testable while
preserving the local-first rule that existing project files belong to the user.

Publishing from a different build than the one CI tested reopens the clean-tree
gap. Publishing the tested tarball with an identity-bound workflow and
provenance gives the release one auditable path without storing a registry token
in the repository or its settings.

## Consequences

- Phase 6 starts by fixing installed binary execution and making `npm pack`
  deterministic from a clean checkout.
- A separate upgrade task owns persistence, backups, schema refresh, and
  compatibility fixtures; ordinary reads remain non-persisting.
- Documentation and CI can proceed independently after the package foundation.
- The final release gate cannot publish until the user provides an owned npm
  scope and configures its trusted publisher.
- Clean-machine OS-matrix evidence, not platform simulation alone, is required
  before Phase 6 can close.

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

The first public release is version `0.1.0` under the npm identity
`@draftforge-dev/draftforge`. npmjs is the canonical installation registry.
That same already-tested `.tgz`, without a rebuild or repack, is also published
as a public, repository-linked GitHub npm package and attached to published
GitHub Release `v0.1.0` alongside its checksum. The recorded artifact digest must
agree across CI evidence, both registries, and the GitHub Release asset.

These external writes use separate jobs and authorities. The npmjs job receives
`id-token: write` for trusted publishing and provenance; the GitHub Packages job
receives `packages: write`; and the GitHub Release job receives
`contents: write`. Each retains only the minimum read permissions it needs. The
GitHub Packages job uses the repository `GITHUB_TOKEN` when the selected GitHub
namespace and repository linkage support it. Because the npm organization name
does not prove a matching GitHub owner or cross-owner authority, an unsupported
cross-owner publication requires a separately approved least-privilege GitHub
credential; the workflow must not infer or silently provision one.

The public npm identity is now user-confirmed as
`@draftforge-dev/draftforge`; the unscoped `draftforge` name remains owned by an
unrelated package. The package remains private until metadata and the matching
npm trusted publisher are configured. The npm organization does not establish
that a same-named GitHub owner exists or that repository `darkweb19/draftforge`
can publish into that GitHub namespace, so GitHub Packages authority remains a
separate prerequisite. These prerequisites block publication, not the portable
package, upgrade, documentation, or CI work that precedes it.

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
gap. Publishing the tested tarball with identity-bound workflows, registry
provenance, and a matching release checksum gives the release one auditable path
without storing an npm registry token in the repository or its settings.

## Consequences

- Phase 6 starts by fixing installed binary execution and making `npm pack`
  deterministic from a clean checkout.
- A separate upgrade task owns persistence, backups, schema refresh, and
  compatibility fixtures; ordinary reads remain non-persisting.
- Documentation and CI can proceed independently after the package foundation.
- The final release gate cannot publish until the user proves control of
  `@draftforge-dev`, configures its npm trusted publisher, and resolves whether
  the repository `GITHUB_TOKEN` can create and link the matching GitHub npm
  package. Any required cross-owner GitHub credential needs separate approval.
- Clean-machine OS-matrix evidence, not platform simulation alone, is required
  before Phase 6 can close.
- Phase 6 closes only after public `@draftforge-dev/draftforge@0.1.0` exists on
  npmjs, its exact tested tarball is mirrored as a repository-linked GitHub npm
  package, and GitHub Release `v0.1.0` contains that tarball plus its checksum.
- npmjs remains the default installation source; the GitHub package is a mirror,
  not a replacement canonical registry.

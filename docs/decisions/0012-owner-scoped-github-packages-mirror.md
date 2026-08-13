# ADR 0012: Owner-scoped GitHub Packages mirror

Status: accepted

## Decision

DraftForge keeps `@draftforge-dev/draftforge@0.1.0` on npmjs as the canonical
package and default installation source. The GitHub Packages mirror is
`@darkweb19/draftforge@0.1.0`, matching the owner of repository
`darkweb19/draftforge`. Both packages expose the same `draftforge` binary.
Users should install the canonical npmjs package; the mirror exists for release
redundancy and repository-linked distribution, not as a second recommended
installation path.

The release workflow builds both packages from the same tagged source commit.
It first creates and tests the canonical npmjs tarball. It then stages a clean
mirror package from that same commit with only these package-manifest deltas:

- `name` changes from `@draftforge-dev/draftforge` to
  `@darkweb19/draftforge`;
- `publishConfig.registry` changes from `https://registry.npmjs.org/` to
  `https://npm.pkg.github.com/`.

No product source, generated JavaScript, templates, binary mapping, version, or
other published metadata may differ. Because an npm tarball embeds its package
manifest and canonical package name in its filename, the two tarballs are
intentionally different artifacts with different SHA-256 digests. Release
evidence records both digests and proves the allowed manifest delta and equality
of every other packaged file.

Each tarball must pass installed-package smoke tests on real Ubuntu, macOS, and
Windows runners, including Node.js 22. The smoke tests invoke the globally
exposed `draftforge` binary, not source or `dist` directly.

The owner-scoped GitHub package is published with the workflow's built-in
`GITHUB_TOKEN` and a job limited to `packages: write` plus minimum read access.
It needs no new GitHub organization, personal access token,
`GH_PACKAGES_TOKEN`, or prerelease GitHub Packages bootstrap. GitHub may create
the package as private on its first stable publish. That expected partial state
requires the repository owner to change visibility to Public, confirm repository
linkage and Actions access, and rerun the idempotent release workflow. npmjs and
GitHub Release must remain gated until the public/linkage verification passes.

npmjs keeps its separate one-time bootstrap requirement so the npm trusted
publisher can be configured. Stable npmjs publication uses OIDC trusted
publishing with provenance and no long-lived npm token.

GitHub Release `v0.1.0` attaches only the canonical npmjs tarball and its
checksum. The mirror tarball remains a GitHub Packages artifact and is verified
by its separately recorded digest; it is not attached to the release.

This ADR supersedes ADR 0011 only where ADR 0011 describes the GitHub Packages
mirror as an identical `@draftforge-dev` tarball, requires matching digests
across both registries, or leaves cross-owner GitHub credentials and a matching
GitHub organization as prerequisites. ADR 0011 remains authoritative for the
portable installed-artifact gate, explicit upgrades, npmjs identity and
provenance, job separation, and release safety.

## Why

GitHub npm package scopes are GitHub account or organization owners. The
repository already belongs to `darkweb19`, so an owner-scoped mirror can use
GitHub Actions' short-lived repository token and native package linkage. This
removes an unnecessary organization and broadly scoped classic PAT from the
release path.

Pretending both registries can receive byte-identical tarballs is incorrect
when their required package names differ: changing the embedded manifest
necessarily changes the archive bytes and digest. Constraining the mirror to a
two-field manifest transformation gives the release a precise, testable
equivalence rule without confusing artifact identity with product equivalence.

## Consequences

- Registry versions agree, while package names, tarball filenames, and digests
  intentionally differ.
- CI and the release gate must retain, install-test, and record both artifacts.
- First publication may pause after creating the private GitHub package; the
  documented owner visibility/linkage action and a safe rerun complete that
  boundary without a separate bootstrap version.
- GitHub Release is the checksum distribution surface for the canonical npmjs
  artifact only.
- Documentation must not present the GitHub Packages mirror as the normal
  install path or imply that a `draftforge-dev` GitHub organization is needed.
- A future repository-owner transfer requires a new decision and coordinated
  mirror identity change; the workflow must not infer it.

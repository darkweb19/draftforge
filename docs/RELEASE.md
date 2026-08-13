# Release process

DraftForge publishes two npm packages from one tagged source commit:

| Surface | Identity | Role |
| --- | --- | --- |
| npmjs | `@draftforge-dev/draftforge@0.1.0` | Canonical package and user install source |
| GitHub Packages | `@darkweb19/draftforge@0.1.0` | Public repository-linked mirror |
| GitHub Release | `v0.1.0` | Canonical npmjs tarball and its SHA-256 checksum |

Both packages expose the same `draftforge` binary. Users should install the
canonical npmjs package. The GitHub Packages package is a release mirror, not a
second recommended installation path.

## Package-equivalence contract

The workflow builds both tarballs from the same clean tagged commit. The
canonical package retains the checked-in manifest. The mirror is staged with
only these manifest changes:

- `name`: `@draftforge-dev/draftforge` to `@darkweb19/draftforge`;
- `publishConfig.registry`: `https://registry.npmjs.org/` to
  `https://npm.pkg.github.com/`.

All product source, built JavaScript, templates, version, `bin` mapping, and
other published metadata must match. The archives necessarily have different
filenames and SHA-256 digests because each embeds a different package manifest.
Release evidence records both digests and verifies equality outside the two
allowed fields. Do not compare the two registry digests for equality.

The canonical tarball is `draftforge-dev-draftforge-0.1.0.tgz`. The mirror
tarball is `darkweb19-draftforge-0.1.0.tgz`. Both must be installed and tested
through their npm-generated `draftforge` binary on real Ubuntu, macOS, and
Windows runners, including Node.js 22.

## Prerequisites

- Use a clean checkout of the release commit with Node.js 22 and npm available.
- Run `npm ci`. Deterministic gates do not call a model or require a provider
  credential.
- Confirm control of the npm organization `@draftforge-dev`.
- Perform the separately approved one-time npmjs bootstrap needed to create the
  package, then configure `darkweb19/draftforge` and `release.yml` as its trusted
  publisher. Stable `0.1.0` uses OIDC with provenance and no `NPM_TOKEN`.
- Keep `darkweb19/draftforge` public and allow Actions to publish owner-scoped
  package `@darkweb19/draftforge` with its built-in `GITHUB_TOKEN`.

Do not create a `draftforge-dev` GitHub organization. Do not configure a PAT,
`GH_PACKAGES_TOKEN`, or GitHub Packages bootstrap. None is part of this owner-
scoped topology.

## Build and local gate

From the clean release commit:

```bash
npm ci
npm run check
npm run package:pack
node -e "const fs=require('node:fs');const crypto=require('node:crypto');const p='draftforge-dev-draftforge-0.1.0.tgz';const d=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');fs.writeFileSync(p+'.sha256',d+'  '+p+'\n')"
node scripts/release-gate.mjs ./draftforge-dev-draftforge-0.1.0.tgz --checksum ./draftforge-dev-draftforge-0.1.0.tgz.sha256 --tag v0.1.0 --identity npmjs
```

The release workflow also stages and packs the mirror, verifies its constrained
manifest delta against the canonical package, records its separate checksum,
and runs the gate with `--identity github`. The local canonical gate is
necessary but not sufficient release evidence.

Each gate audits the allowlisted files, metadata, tag, Node floor, repository
metadata, documentation, and changelog. It installs its exact tarball into a
temporary npm project and invokes `draftforge` for `--version`, `init`, `doctor`,
`status`, `handoff`, and `upgrade`. It also covers deterministic resume and
review behavior without a provider call.

## Approval and publication order

Creating stable tag `v0.1.0` at the accepted commit is the publication approval.
Configure protected GitHub environments first if additional per-job human
approval is required.

1. Require the canonical and mirror tarballs to pass installed-binary tests on
   Ubuntu, macOS, and Windows. Record their distinct SHA-256 digests and verify
   the two-field manifest delta.
2. Confirm the npmjs bootstrap and trusted publisher. No equivalent GitHub
   Packages bootstrap is needed.
3. Push `v0.1.0` at that exact commit.
4. Publish or verify `@darkweb19/draftforge@0.1.0` using only the built-in
   `GITHUB_TOKEN` with `packages: write`. A first publish may create the package
   as private. In that case the job stops here after the external write.
5. In GitHub package settings, change visibility to **Public**, link
   `darkweb19/draftforge`, and grant the repository Actions access if it is not
   already inherited. Rerun the workflow. It must verify the existing version
   and digest without overwriting it before later jobs start.
6. Publish or verify `@draftforge-dev/draftforge@0.1.0` through npm trusted
   publishing with provenance and `id-token: write`. No long-lived npm token is
   allowed.
7. Download each registry tarball and require it to match its own recorded
   digest. Recheck the constrained manifest delta and common packaged content.
8. Create or resume GitHub Release `v0.1.0` with `contents: write`. Attach only
   `draftforge-dev-draftforge-0.1.0.tgz` and its `.sha256` sidecar, then download
   both and verify the canonical digest.
9. Mark Phase 6 complete only after both public packages, npm provenance,
   repository linkage, three-OS evidence, and GitHub Release assets pass.

Publication jobs remain separate and least privilege. Ordinary pushes and pull
requests cannot publish. Tag/version drift, an unexpected artifact, an invalid
mirror delta, or a digest mismatch stops the affected write.

## Reruns and failures

Cross-registry publication is not atomic. The expected first-run partial state
is a private GitHub package with npmjs and GitHub Release still absent. Make the
package public, confirm linkage/access, then rerun. Every job must be safely
rerunnable. If a target version exists, download it and accept it only if its
identity, content contract, and recorded digest match. Never overwrite a
published version.

Do not replace a failed candidate in place. Fix the source, issue a new version
and tag when required, create new checksums, and rerun the complete matrix.
Never reuse green evidence from another digest. Optional authenticated harness
smoke remains separate from deterministic release acceptance.

See [ADR 0012](decisions/0012-owner-scoped-github-packages-mirror.md) for the
owner-scoped mirror decision and [ADR 0011](decisions/0011-release-artifact-upgrades-and-provenance.md)
for the installed-artifact, upgrade, and npm provenance foundation.

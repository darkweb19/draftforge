# Release process

DraftForge releases one exact npm tarball. npmjs is the canonical installation
registry. GitHub Packages is a repository-linked mirror, and GitHub Release
`v0.1.0` carries the same `.tgz` plus its SHA-256 checksum. None of those
surfaces may rebuild or repack the candidate.

## Bootstrap prerequisites

- Use a clean checkout of the tag candidate with Node.js 22 and npm available.
- Run `npm ci` before the gate. The deterministic execution fixture uses the
  checked-in `tsx` development dependency; the gate never downloads a provider
  dependency or calls a model.
- Confirm control of both the npm organization and GitHub organization for
  `@draftforge-dev`. Before a stable tag can exist, build and fully test one
  distinct `0.1.0-bootstrap.0` tarball. Publish that same prerelease manually
  under a non-`latest` bootstrap tag to both registries. On GitHub Packages,
  make the bootstrap package public, confirm its `repository` link, and grant
  this workflow write access. On npmjs, use an explicitly approved 2FA publish,
  then configure this repository's `release.yml` as the trusted publisher.
  Stable `0.1.0` remains a separately tested, content-addressed candidate
  published by OIDC with provenance; never promote or reuse the bootstrap
  tarball as the stable artifact.
- Prefer transferring the repository into the `draftforge-dev` GitHub
  organization so its `GITHUB_TOKEN` can publish a linked package without a
  personal credential. A transfer changes repository identity: update package
  metadata, workflow checks, links, and trusted-publisher configuration, then
  rerun the complete gate before tagging.
- If the current cross-owner topology is retained, GitHub Packages requires a
  personal access token (classic), not a fine-grained or package-scoped token.
  Give it `write:packages`; GitHub may also show/select `read:packages` (write
  includes read). Do not add `repo` for this public npm package. The token's
  human or machine account must itself have write authority in the target
  organization and must authorize SSO when the organization requires it.
  Record an owner and expiry, rotate before expiry, and revoke it immediately
  after moving to a same-owner `GITHUB_TOKEN` topology. A classic PAT cannot be
  restricted to one package, so compromise can affect every package its owner
  can write; store it only as the `GH_PACKAGES_TOKEN` Actions secret and never
  expose it to npmjs or GitHub Release jobs. See GitHub's
  [npm registry authentication](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry),
  [package scopes](https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages),
  and [credential lifecycle guidance](https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/github-credential-types).

## Build and local gate

From the clean release commit:

```bash
npm ci
npm run check
npm run package:pack
node -e "const fs=require('node:fs');const crypto=require('node:crypto');const p='draftforge-dev-draftforge-0.1.0.tgz';const d=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');fs.writeFileSync(p+'.sha256',d+'  '+p+'\n')"
node scripts/release-gate.mjs ./draftforge-dev-draftforge-0.1.0.tgz --checksum ./draftforge-dev-draftforge-0.1.0.tgz.sha256 --tag v0.1.0
```

The gate does not build. It accepts the already-built tarball, verifies the
sidecar filename and SHA-256 digest, audits the allowlisted files, and checks
package name, version, tag, tarball name, public npmjs metadata, Node floor,
repository metadata, documentation install command, and changelog entry.

It then installs that exact file offline into a temporary npm project and uses
the npm-generated `draftforge` binary for `--version`, `init`, `doctor`,
`status`, `handoff`, and `upgrade`. It covers supported upgrade, future-state
refusal, and modified-managed-schema refusal without changing refused state. A
persisted interrupted result is resumed once and a second resume is idempotent.
The gate then creates a real Git worktree with an acceptance-ready attempt and
persisted accept verdict; `review` must commit and merge that branch, record the
actual rollback and integration commits, and move the task to `done` without a
provider call. Temporary projects are removed even when the gate fails.

The local gate is necessary but not sufficient release evidence. The same
tarball digest must pass installed-binary jobs on real Ubuntu, macOS, and
Windows runners, including Node.js 22. Platform simulation and a newer local
Node version do not replace those jobs.

## Approval boundaries and publication order

Creating the stable version tag is the explicit publication approval. The tag
workflow then runs separately authorized, least-privilege publication jobs
after their declared prerequisites pass. If per-job human approval is required,
configure protected GitHub environments for those jobs before creating the tag;
the workflow itself must not be described as enforcing approval it does not
contain.

1. Approve the content-addressed candidate after local checks, independent QA,
   and all three OS jobs agree on the SHA-256 digest.
2. Confirm the npm trusted publisher and the existing public, repository-linked
   GitHub bootstrap package. Confirm either same-owner `GITHUB_TOKEN` authority
   or the explicitly approved classic PAT described above. These checks reduce
   risk but cannot prove that all external authority will remain valid through
   every later registry write.
3. Explicitly approve the release by creating/pushing tag `v0.1.0` at the tested
   candidate commit. This one action triggers the separately gated jobs.
4. The GitHub Packages job publishes or verifies the retained tarball with
   `packages: write`, then verifies the stable version is public and linked to
   this repository. The npmjs job does not start until this succeeds.
5. The npmjs job publishes or verifies the retained tarball through the trusted
   publisher with provenance; it must not use the manual bootstrap authority or
   a long-lived npm token. The registry-verification job then downloads both
   registry copies and requires both digests to match the candidate.
6. Only after both registries pass does the GitHub Release job create or resume
   `v0.1.0` and attach the `.tgz` plus `.sha256` with `contents: write`. A final
   job downloads and verifies those public assets. Protected environments may
   add distinct human approvals when configured.
7. Verify public `@draftforge-dev/draftforge@0.1.0` on npmjs, including its SLSA
   provenance metadata, the public repository-linked GitHub package, and GitHub
   Release `v0.1.0`; all downloaded artifacts must match the tested candidate
   digest. Missing npm provenance is a failed release, not a warning. Only then
   may Phase 6 canonical state and `SESSION.md` move to complete.

Publication jobs must remain separate and least privilege: npmjs receives
`id-token: write`, GitHub Packages receives `packages: write`, and GitHub
Release receives `contents: write`, plus minimum read access. Forks, ordinary
pushes, tag/version drift, an unexpected artifact, or a digest mismatch must
stop the affected write. Missing post-publish provenance must stop subsequent
release jobs and prevent the release from being declared complete.

Cross-registry publication is not atomic. In this workflow GitHub Packages is
the first stable external write. If npmjs subsequently fails, the matching
GitHub Packages version remains published while npmjs and GitHub Release remain
absent; rerunning resumes by verifying that existing GitHub package before
retrying npmjs. If both registries succeed but GitHub Release fails, rerunning
verifies both existing registry versions before resuming the release/assets.
Every publication job must therefore be safely rerunnable. When the target
version already exists, download it from that registry and treat the step as
successful only when its bytes match the candidate SHA-256 and its required
visibility/linkage/provenance checks pass. Never overwrite an existing version.
If the bytes differ, fail closed and issue a new version and tag after correcting
the source. Do not claim that every credential, visibility, linkage, or service
failure can be detected before the first external write.

## Failure handling

Do not replace a failed candidate in place. Fix the source, create a new clean
candidate, generate a new checksum, and rerun the complete matrix. Never reuse
green evidence from a different digest. The deterministic gate contains no
provider credential and optional authenticated harness smoke remains separate;
it cannot be made a prerequisite for package acceptance.

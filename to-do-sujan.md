# Sujan's 0.1.0 publication setup

The canonical package is `@draftforge-dev/draftforge@0.1.0` on npmjs. GitHub
Packages mirrors it as `@darkweb19/draftforge@0.1.0`. Both expose the same
`draftforge` binary, but have separate tarballs and digests because their
manifest names and publish registries differ. Users should install the npmjs
package.

## npmjs scope and bootstrap

- [ ] Sign in at [npmjs.com](https://www.npmjs.com/) and enable two-factor
  authentication. Store recovery codes securely.
- [ ] Confirm the `draftforge-dev` npm organization exists and your account can
  administer the `@draftforge-dev` scope.
- [ ] Confirm the exact canonical name: `@draftforge-dev/draftforge`.
- [ ] Complete the separately approved one-time npmjs bootstrap publication
  needed before trusted publishing can be configured. Use a non-`latest`
  prerelease version/tag and do not reuse it as stable `0.1.0`.
- [ ] After `release.yml` is on the default branch, configure its npm trusted
  publisher as described below.

Run ownership checks locally and complete browser/2FA prompts when npm requests
them. Never paste a password, token, OTP, recovery code, or `.npmrc` content into
this repository or chat.

```powershell
npm login
npm whoami
npm ping
npm view @draftforge-dev/draftforge name version
```

## npm trusted publishing

Do not add an `NPM_TOKEN` GitHub secret. Stable publication uses short-lived
OIDC credentials with provenance.

1. Open `@draftforge-dev/draftforge` on npmjs after the one-time bootstrap.
2. Under **Settings -> Trusted Publisher**, select **GitHub Actions**.
3. Enter:
   - Organization or user: `darkweb19`
   - Repository: `draftforge`
   - Workflow filename: `release.yml`
   - Environment: use the exact environment named by the committed workflow,
     if any
4. Save and recheck spelling and capitalization.
5. After trusted publishing succeeds, choose the strongest publishing-access
   policy compatible with trusted publishing and keep the repository public for
   provenance.

The release workflow must grant the npmjs job `id-token: write`, use a supported
Node/npm combination, and keep repository metadata pointed at
`https://github.com/darkweb19/draftforge`.

## GitHub Packages mirror

No new GitHub organization is required. Do not create `draftforge-dev` on
GitHub for this release. Do not create a PAT, `GH_PACKAGES_TOKEN`, or GitHub
Packages bootstrap version.

- [ ] Confirm repository `darkweb19/draftforge` is public.
- [ ] In repository Actions settings, allow workflows the write access required
  to publish packages.
- [ ] Confirm `release.yml` publishes `@darkweb19/draftforge` with the built-in
  `GITHUB_TOKEN` and job-level `packages: write`.
- [ ] Expect the first stable workflow run may create the package as private and
  stop before npmjs publication.
- [ ] If private, open the package settings, change visibility to **Public**,
  link `darkweb19/draftforge`, and confirm repository Actions access.
- [ ] Rerun the same release workflow. It verifies the existing mirror version
  and digest without overwriting it, then proceeds to npmjs and GitHub Release.

The GitHub mirror does not need the npmjs bootstrap. The workflow creates the
owner-scoped mirror directly and verifies its repository linkage after publish.

## Before pushing `v0.1.0`

- [ ] Canonical `draftforge-dev-draftforge-0.1.0.tgz` passes installed-binary
  tests on Ubuntu, macOS, and Windows.
- [ ] Mirror `darkweb19-draftforge-0.1.0.tgz` passes the same three-OS tests.
- [ ] Release checks prove only manifest `name` and `publishConfig.registry`
  differ and record both SHA-256 digests.
- [ ] npm trusted publishing is configured and the protected environment, if
  used, is ready.
- [ ] Tag `v0.1.0` points to the exact tested commit.

GitHub Release `v0.1.0` should contain only the canonical npmjs tarball and its
checksum sidecar. The mirror has its own digest and remains on GitHub Packages.

## Official references

- [npm: About scopes](https://docs.npmjs.com/about-scopes/)
- [npm: Creating scoped public packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)
- [npm: Trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [GitHub Packages: npm registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)
- [GitHub Actions package permissions](https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages)

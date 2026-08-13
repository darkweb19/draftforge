# Sujan's 0.1.0 publication setup

The approved public package is `@draftforge-dev/draftforge@0.1.0`. npmjs is the
canonical registry; GitHub Packages will be a repository-linked mirror of the
same tested tarball. The unscoped `draftforge` package belongs to another
project.

## Recommended: use an npm organization scope

An organization keeps the package identity separate from a personal account and makes future collaborator access easier.

- [ ] Sign in at [npmjs.com](https://www.npmjs.com/). Create an account first if needed.
- [ ] Enable two-factor authentication on the npm account and save the recovery codes somewhere secure.
- [ ] Confirm the `draftforge-dev` organization exists. If it does not, open the profile menu and select **Add an Organization** to create it.
- [ ] Confirm your account can administer the `@draftforge-dev` scope.
- [ ] Select **Unlimited public packages** unless private npm packages are actually needed.
- [ ] Confirm the exact package name: `@draftforge-dev/draftforge`.

## Verify ownership locally

Run these commands in a terminal. Complete browser/2FA prompts when npm requests them. Never paste a password, token, OTP, recovery code, or `.npmrc` content into this repository or chat.

```powershell
npm login
npm whoami
npm ping
```

Then verify `draftforge-dev` appears in your npm account at **Profile → Organizations**.

Check the approved package identity:

```powershell
npm view @draftforge-dev/draftforge name version
```

For a new package, npm should return a not-found error. That is expected; the scope exists, but the package has not been published. Do not publish anything yet.

## Send this back to Codex

- [ ] Exact scope confirmed: `@draftforge-dev`
- [ ] Exact intended package name confirmed: `@draftforge-dev/draftforge`
- [ ] Scope type confirmed: organization
- [ ] npm 2FA enabled: yes / no
- [ ] GitHub repository visibility: public / private

The GitHub repository is currently `darkweb19/draftforge`. It must be public for npm provenance to be generated for a public package.

Also confirm whether `GITHUB_TOKEN` can publish and link the GitHub Packages
mirror for the selected namespace. npm scope ownership does not prove GitHub
Packages authority. If cross-owner publication needs another credential, stop
and approve a separately scoped credential rather than broadening permissions.

## Trusted publishing — do this after P06-T04 adds the workflow

Do not add an `NPM_TOKEN` GitHub secret. DraftForge will use npm trusted publishing with short-lived OIDC credentials.

1. Wait until `.github/workflows/release.yml` exists on the default branch.
2. Confirm the scoped package already exists on npm. Current npm rules require an existing package before a trusted publisher can be attached. The safe one-time package bootstrap must be agreed separately; do not improvise a publish from this checklist.
3. Open the package on npmjs.com, then go to **Settings → Trusted Publisher**.
4. Select **GitHub Actions** and enter:
   - Organization or user: `darkweb19`
   - Repository: `draftforge`
   - Workflow filename: `release.yml`
   - Environment: leave blank unless the release workflow explicitly creates one
   - Allowed action: select the action required by the final workflow; staged publishing is the safer option when supported by the completed release design
5. Save the trusted publisher configuration. npm does not validate these values when saving, so check spelling and capitalization carefully.
6. Under **Settings → Publishing access**, select **Require two-factor authentication and disallow tokens** after trusted publishing has been proven.
7. Keep the repository public if provenance is required.

Trusted publishing currently requires npm CLI 11.5.1+ and Node.js 22.14.0+ on a GitHub-hosted runner. The workflow must grant `id-token: write` and use a repository URL matching `https://github.com/darkweb19/draftforge`.

## Official references

- [npm: Creating an organization](https://docs.npmjs.com/creating-an-organization/)
- [npm: About scopes](https://docs.npmjs.com/about-scopes/)
- [npm: Creating scoped public packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)
- [npm: Trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm: `npm trust` requirements](https://docs.npmjs.com/cli/v11/commands/npm-trust/)

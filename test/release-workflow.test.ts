import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
// The release-check executable stays plain JavaScript for direct CI use.
// @ts-expect-error JavaScript executable intentionally has no declaration file.
import { expectedTarballFilename, validateChecksumSidecar, validateGitHubMirrorMetadata, validateNpmBootstrapMetadata, validateNpmPublicationMetadata, validatePackageMetadata, validatePublicationConfiguration } from "../scripts/release-check.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

async function fixture(path: string): Promise<string> {
  return readFile(`${root}/${path}`, "utf8");
}

function job(workflow: string, name: string): string {
  const match = new RegExp(`^  ${name}:\\n(?<body>[\\s\\S]*?)(?=^  [a-z][a-z-]*:\\n|(?![\\s\\S]))`, "mu").exec(workflow);
  assert.ok(match?.groups?.body !== undefined, `Missing workflow job: ${name}`);
  return match.groups.body;
}

function assertOfficialActionMajors(workflow: string): void {
  const uses = [...workflow.matchAll(/uses:\s+(actions\/[a-z-]+)@([^\s]+)/gu)];
  assert.ok(uses.length > 0);
  const allowed = new Map([
    ["actions/checkout", "v7"],
    ["actions/setup-node", "v7"],
    ["actions/upload-artifact", "v7"],
    ["actions/download-artifact", "v8"],
  ]);
  for (const match of uses) {
    assert.equal(match[2], allowed.get(match[1] ?? ""), `${match[1]} must use its pinned current official major`);
  }
  assert.doesNotMatch(workflow, /@(main|master|latest)\b/u);
}

function assertPinnedNpmAfterSetupNode(workflow: string): void {
  const setupMatches = [...workflow.matchAll(/uses: actions\/setup-node@v7/gu)];
  const pinMatches = [...workflow.matchAll(/run: npm install --global npm@11\.16\.0/gu)];
  assert.equal(pinMatches.length, setupMatches.length, "every Node.js job must install packageManager npm@11.16.0");
  for (const [index, setup] of setupMatches.entries()) {
    const section = workflow.slice(setup.index, setupMatches[index + 1]?.index ?? workflow.length);
    assert.match(section, /run: npm install --global npm@11\.16\.0/u);
    const pinIndex = section.indexOf("run: npm install --global npm@11.16.0");
    const firstConsumer = [section.indexOf("run: npm ci"), section.indexOf("uses: actions/download-artifact@v8")]
      .filter((position) => position >= 0)
      .sort((left, right) => left - right)[0];
    if (firstConsumer !== undefined) assert.ok(pinIndex < firstConsumer, "npm must be pinned before install or artifact gates");
  }
}

test("package metadata is the approved public npmjs identity", async () => {
  const metadata: unknown = JSON.parse(await fixture("package.json"));
  validatePackageMetadata(metadata);
  assert.equal(expectedTarballFilename("npmjs"), "draftforge-dev-draftforge-0.1.0.tgz");
  assert.equal(expectedTarballFilename("github"), "darkweb19-draftforge-0.1.0.tgz");
});

test("GitHub mirror metadata changes only the owner scope and registry", () => {
  const mirror = {
    name: "@darkweb19/draftforge",
    version: "0.1.0",
    license: "MIT",
    repository: { type: "git", url: "git+https://github.com/darkweb19/draftforge.git" },
    bugs: { url: "https://github.com/darkweb19/draftforge/issues" },
    engines: { node: ">=22" },
    publishConfig: { access: "public", registry: "https://npm.pkg.github.com/" },
  };
  assert.doesNotThrow(() => validateGitHubMirrorMetadata(mirror));
  assert.throws(() => validateGitHubMirrorMetadata({ ...mirror, name: "@draftforge-dev/draftforge" }), /owner's scope/u);
  assert.throws(() => validateGitHubMirrorMetadata({ ...mirror, publishConfig: { ...mirror.publishConfig, registry: "https://registry.npmjs.org/" } }), /GitHub Packages/u);
});

test("release metadata checks reject identity, version, and registry drift", () => {
  const valid = {
    name: "@draftforge-dev/draftforge",
    version: "0.1.0",
    private: false,
    license: "MIT",
    repository: { type: "git", url: "git+https://github.com/darkweb19/draftforge.git" },
    bugs: { url: "https://github.com/darkweb19/draftforge/issues" },
    engines: { node: ">=22" },
    publishConfig: { access: "public", registry: "https://registry.npmjs.org/" },
  };
  for (const invalid of [
    { ...valid, name: "draftforge" },
    { ...valid, version: "0.1.1" },
    { ...valid, publishConfig: { ...valid.publishConfig, registry: "https://npm.pkg.github.com/" } },
  ]) {
    assert.throws(() => validatePackageMetadata(invalid));
  }
});

test("publication configuration rejects missing trusted-publisher provenance", () => {
  const valid = {
    npmTrustedPublisherConfigured: "true",
    npmTrustedPublisherRepository: "darkweb19/draftforge",
    npmTrustedPublisherWorkflow: "release.yml",
    npmTrustedPublisherEnvironment: "npmjs",
    githubRepository: "darkweb19/draftforge",
    githubRepositoryOwner: "darkweb19",
  };
  assert.doesNotThrow(() => validatePublicationConfiguration(valid));
  assert.throws(
    () => validatePublicationConfiguration({ ...valid, npmTrustedPublisherConfigured: undefined }),
    /npm trusted publisher is configured/u,
  );
  assert.throws(
    () => validatePublicationConfiguration({ ...valid, npmTrustedPublisherWorkflow: undefined }),
    /bind the npm trusted publisher/u,
  );
  assert.throws(
    () => validatePublicationConfiguration({ ...valid, githubRepositoryOwner: "draftforge-dev" }),
    /existing darkweb19 owner scope/u,
  );
});

test("post-publication metadata rejects missing npm provenance", () => {
  const valid = {
    name: "@draftforge-dev/draftforge",
    version: "0.1.0",
    dist: {
      attestations: {
        url: "https://registry.npmjs.org/-/npm/v1/attestations/example",
        provenance: { predicateType: "https://slsa.dev/provenance/v1" },
      },
    },
  };
  assert.doesNotThrow(() => validateNpmPublicationMetadata(valid));
  assert.throws(
    () => validateNpmPublicationMetadata({ ...valid, dist: {} }),
    /missing its provenance attestation URL/u,
  );
});

test("npmjs bootstrap metadata requires the exact public prerelease identity", () => {
  const valid = {
    name: "@draftforge-dev/draftforge",
    version: "0.1.0-bootstrap.0",
    repository: { type: "git", url: "git+https://github.com/darkweb19/draftforge.git" },
  };
  assert.doesNotThrow(() => validateNpmBootstrapMetadata(valid));
  assert.throws(() => validateNpmBootstrapMetadata({ ...valid, version: "0.1.0-bootstrap.1" }), /bootstrap\.0/u);
  assert.throws(() => validateNpmBootstrapMetadata({ ...valid, private: true }), /publicly readable/u);
});

test("release checksum sidecar rejects missing, extra, or mismatched content", () => {
  const digest = "a".repeat(64);
  const tarball = "draftforge-dev-draftforge-0.1.0.tgz";
  assert.doesNotThrow(() => validateChecksumSidecar(`${digest}  ${tarball}\n`, digest, tarball));
  assert.throws(() => validateChecksumSidecar(undefined, digest, tarball), /sidecar is missing/u);
  assert.throws(() => validateChecksumSidecar(`${digest}  replacement.tgz\n`, digest, tarball), /exactly/u);
  assert.throws(() => validateChecksumSidecar(`${"b".repeat(64)}  ${tarball}\n`, digest, tarball), /exactly/u);
  assert.throws(() => validateChecksumSidecar(`${digest}  ${tarball}\nextra\n`, digest, tarball), /exactly/u);
});

test("CI runs the full gate on one checksum-addressed tarball on every supported OS", async () => {
  const workflow = await fixture(".github/workflows/ci.yml");
  assert.match(workflow, /^on:\n  push:\n  pull_request:\n/mu);
  assert.match(workflow, /^permissions:\n  contents: read$/mu);
  assert.doesNotMatch(workflow, /workflow_dispatch|id-token:\s*write|packages:\s*write|contents:\s*write/u);
  assert.doesNotMatch(workflow, /npm publish|gh release create|secrets\./u);
  assertOfficialActionMajors(workflow);
  assertPinnedNpmAfterSetupNode(workflow);

  const packageJob = job(workflow, "package");
  assert.match(packageJob, /runs-on: ubuntu-latest/u);
  assert.match(packageJob, /node-version: 22/u);
  assert.match(packageJob, /npm ci[\s\S]*npm run build/u);
  assert.match(packageJob, /npm pack --ignore-scripts --pack-destination release-artifact[\s\S]*name=@darkweb19\/draftforge[\s\S]*npm\.pkg\.github\.com[\s\S]*npm pack \.\/mirror-source/u);
  assert.match(packageJob, /node scripts\/release-check\.mjs/u);
  assert.match(packageJob, /actions\/upload-artifact@v7/u);
  assert.match(packageJob, /canonical_sha256: \$\{\{ steps\.canonical-check\.outputs\.sha256 \}\}/u);
  assert.match(packageJob, /mirror_sha256: \$\{\{ steps\.mirror-check\.outputs\.sha256 \}\}/u);
  assert.match(packageJob, /--identity github[\s\S]*--source-tarball/u);

  const gate = job(workflow, "artifact-smoke");
  assert.match(gate, /needs: package/u);
  assert.match(gate, /os: \[ubuntu-latest, macos-latest, windows-latest\]/u);
  assert.match(gate, /actions\/download-artifact@v8/u);
  assert.match(gate, /needs\.package\.outputs\.artifact_name/u);
  assert.match(gate, /npm ci[\s\S]*npm run check/u);
  assert.equal((gate.match(/release-check\.mjs/gu) ?? []).length, 2);
  assert.equal((gate.match(/release-gate\.mjs/gu) ?? []).length, 2);
  assert.match(gate, /mirror_sha256/u);
  assert.match(gate, /release-gate\.mjs[\s\S]*--identity github[\s\S]*--checksum/u);
  assert.doesNotMatch(gate, /npm pack/u);

  assert.doesNotMatch(workflow, /actions\/cache|node_modules|\bdist\/|\.draftforge\/runs|\.env/u);
  assert.equal((workflow.match(/npm pack/gu) ?? []).length, 2, "CI must pack exactly the canonical and mirror artifacts");
});

test("release preflights authority, resumes safely, and verifies every public artifact", async () => {
  const workflow = await fixture(".github/workflows/release.yml");
  assert.match(workflow, /^on:\n  push:\n    tags:\n      - "v\*"\n  workflow_dispatch:$/mu);
  assert.doesNotMatch(workflow, /pull_request|branches:/u);
  assertOfficialActionMajors(workflow);
  assertPinnedNpmAfterSetupNode(workflow);

  const packageJob = job(workflow, "package");
  assert.match(packageJob, /if: github\.event_name == 'push'/u);
  assert.match(packageJob, /git rev-parse HEAD/u);
  assert.match(packageJob, /git status --porcelain --untracked-files=all/u);
  assert.match(packageJob, /npm ci[\s\S]*npm run build[\s\S]*npm pack --ignore-scripts[\s\S]*name=@darkweb19\/draftforge[\s\S]*npm pack \.\/mirror-source/u);
  assert.match(packageJob, /release-check\.mjs[\s\S]*--tag/u);
  assert.match(packageJob, /--identity github[\s\S]*--source-tarball/u);

  const gate = job(workflow, "artifact-smoke");
  assert.match(gate, /if: github\.event_name == 'push'/u);
  assert.match(gate, /os: \[ubuntu-latest, macos-latest, windows-latest\]/u);
  assert.match(gate, /npm ci[\s\S]*npm run check/u);
  assert.equal((gate.match(/release-gate\.mjs/gu) ?? []).length, 2);
  assert.match(gate, /--identity github[\s\S]*--checksum/u);

  const authority = job(workflow, "publication-authority");
  assert.match(authority, /if: github\.event_name == 'push'/u);
  assert.match(authority, /needs: \[package, artifact-smoke\]/u);
  assert.match(authority, /contents: read/u);
  assert.match(authority, /NPM_TRUSTED_PUBLISHER_CONFIGURED: \$\{\{ vars\.NPM_TRUSTED_PUBLISHER_CONFIGURED \}\}/u);
  assert.match(authority, /--publication-config/u);
  assert.doesNotMatch(authority, /GH_PACKAGES|PAT|\/orgs\/draftforge-dev/u);
  assert.match(authority, /npm ping --registry https:\/\/registry\.npmjs\.org\//u);
  assert.match(authority, /@draftforge-dev\/draftforge@0\.1\.0-bootstrap\.0/u);
  assert.match(authority, /npm view[\s\S]*registry\.npmjs\.org[\s\S]*--json/u);
  assert.match(authority, /--npm-bootstrap-metadata npmjs-bootstrap\.json/u);

  const githubPackages = job(workflow, "publish-github-packages");
  assert.match(githubPackages, /if: github\.event_name == 'push'/u);
  assert.match(githubPackages, /needs: \[package, publication-authority\]/u);
  assert.match(githubPackages, /packages: write/u);
  assert.doesNotMatch(githubPackages, /id-token: write|contents: write/u);
  assert.match(githubPackages, /scope: "@darkweb19"/u);
  assert.match(githubPackages, /NODE_AUTH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(githubPackages, /@darkweb19\/draftforge/u);
  assert.match(githubPackages, /darkweb19-draftforge-0\.1\.0\.tgz/u);
  assert.match(githubPackages, /npm view[\s\S]*view_status[\s\S]*E404[\s\S]*refusing to publish[\s\S]*npm publish/u);
  assert.match(githubPackages, /npm publish "\.\/\$\{\{ needs\.package\.outputs\.mirror_tarball \}\}"/u);
  assert.doesNotMatch(githubPackages, /npm publish "\$\{\{ needs\.package\.outputs\.mirror_tarball \}\}"/u);
  assert.match(githubPackages, /curl[\s\S]*release-check\.mjs[\s\S]*--sha256/u);
  assert.match(githubPackages, /\/users\/darkweb19\/packages\/npm\/draftforge/u);
  assert.match(githubPackages, /first GitHub Packages publication is private by default/u);
  assert.match(githubPackages, /make @darkweb19\/draftforge public[\s\S]*rerun/u);
  assert.match(githubPackages, /\.repository\.full_name[\s\S]*darkweb19\/draftforge/u);

  const npmjs = job(workflow, "publish-npmjs");
  assert.match(npmjs, /if: github\.event_name == 'push'/u);
  assert.match(npmjs, /needs: \[package, publish-github-packages\]/u);
  assert.match(npmjs, /environment: npmjs/u);
  assert.match(npmjs, /id-token: write/u);
  assert.doesNotMatch(npmjs, /packages: write|contents: write|NPM_TOKEN|NODE_AUTH_TOKEN/u);
  assert.match(npmjs, /npm view[\s\S]*view_status[\s\S]*E404[\s\S]*refusing to publish[\s\S]*npm publish/u);
  assert.match(npmjs, /npm publish[\s\S]*--provenance[\s\S]*--access public/u);
  assert.match(npmjs, /npm publish "\.\/\$\{\{ needs\.package\.outputs\.canonical_tarball \}\}"/u);
  assert.doesNotMatch(npmjs, /npm publish "\$\{\{ needs\.package\.outputs\.canonical_tarball \}\}"/u);
  assert.match(npmjs, /curl[\s\S]*release-check\.mjs[\s\S]*--sha256/u);
  assert.match(npmjs, /npm view[\s\S]*--json[\s\S]*--npm-metadata/u);

  for (const publishJob of [githubPackages, npmjs]) {
    assert.match(publishJob, /actions\/download-artifact@v8[\s\S]*needs\.package\.outputs\.artifact_name/u);
    assert.match(publishJob, /release-check\.mjs[\s\S]*--sha256[\s\S]*--downloaded/u);
    assert.doesNotMatch(publishJob, /npm pack|npm run build|npm run check|prepack/u);
  }

  const registryGate = job(workflow, "verify-registries");
  assert.match(registryGate, /if: github\.event_name == 'push'/u);
  assert.match(registryGate, /needs: \[package, publish-github-packages, publish-npmjs\]/u);
  assert.match(registryGate, /packages: read/u);
  assert.match(registryGate, /registry\.npmjs\.org/u);
  assert.match(registryGate, /npm\.pkg\.github\.com/u);
  assert.match(registryGate, /registry-url: https:\/\/npm\.pkg\.github\.com\//u);
  assert.match(registryGate, /scope: "@darkweb19"/u);
  assert.match(registryGate, /NODE_AUTH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.equal((registryGate.match(/release-check\.mjs/gu) ?? []).length, 2);
  assert.equal((registryGate.match(/--sha256/gu) ?? []).length, 2);
  assert.match(registryGate, /npm view[\s\S]*--json[\s\S]*--npm-metadata/u);

  const githubRelease = job(workflow, "github-release");
  assert.match(githubRelease, /if: github\.event_name == 'push'/u);
  assert.match(githubRelease, /needs: \[package, verify-registries\]/u);
  assert.match(githubRelease, /contents: write/u);
  assert.doesNotMatch(githubRelease, /id-token: write|packages: write/u);
  assert.match(githubRelease, /gh release create/u);
  assert.match(githubRelease, /gh release upload/u);
  assert.match(githubRelease, /--verify-tag/u);
  assert.doesNotMatch(githubRelease, /--clobber/u);

  const releaseAssets = job(workflow, "verify-release-assets");
  assert.match(releaseAssets, /if: github\.event_name == 'push'/u);
  assert.match(releaseAssets, /needs: \[package, github-release\]/u);
  assert.match(releaseAssets, /contents: read/u);
  assert.match(releaseAssets, /gh release download/u);
  assert.match(releaseAssets, /expected_assets[\s\S]*actual_assets/u);
  assert.match(releaseAssets, /actual_assets" != "\$expected_assets/u);
  assert.equal((releaseAssets.match(/gh release download/gu) ?? []).length, 2);
  assert.doesNotMatch(releaseAssets, /\.tgz\*/u);
  assert.match(releaseAssets, /release-check\.mjs[\s\S]*--sha256[\s\S]*--require-checksum-sidecar/u);

  assert.equal((packageJob.match(/npm pack/gu) ?? []).length, 2, "tag release must pack exactly the canonical and mirror artifacts");
  assert.doesNotMatch(workflow, /NPM_TOKEN|_authToken|npm_[A-Za-z0-9]{20,}/u);
  assert.deepEqual([...workflow.matchAll(/secrets\.([A-Z0-9_]+)/gu)], [], "release must not use a PAT or registry secret");
});

test("manual v0.1.0 recovery uses the npm trusted workflow and cannot run tag publication jobs", async () => {
  const workflow = await fixture(".github/workflows/release.yml");
  const recovery = job(workflow, "recover-npmjs-v0-1-0");
  const expectedCommit = "109b3ef543879027bbb1c3e3db4f99ec960c484b";
  const expectedSha256 = "270cbc73b3a7887d915ea045b9d6bfc2904dc286d2e36ac20f0179d72cd4c1b1";

  assert.match(workflow, /NPM_TRUSTED_PUBLISHER_WORKFLOW: \$\{\{ vars\.NPM_TRUSTED_PUBLISHER_WORKFLOW \}\}/u);
  assert.doesNotMatch(workflow, /release-recovery\.yml/u);
  assert.match(recovery, /if: github\.event_name == 'workflow_dispatch'/u);
  assert.doesNotMatch(recovery, /needs:/u);
  assert.match(recovery, /environment: npmjs/u);
  assert.match(recovery, /permissions:\n      contents: read\n      id-token: write/u);
  assert.doesNotMatch(recovery, /contents: write|packages: (?:read|write)/u);

  assert.match(recovery, /uses: actions\/checkout@v7[\s\S]*ref: v0\.1\.0[\s\S]*fetch-depth: 0/u);
  assert.match(recovery, new RegExp(`EXPECTED_COMMIT: ${expectedCommit}`, "u"));
  assert.match(recovery, /git rev-parse HEAD[\s\S]*git rev-parse 'v0\.1\.0\^\{commit\}'/u);
  assert.match(recovery, /uses: actions\/setup-node@v7[\s\S]*node-version: 22/u);
  assert.doesNotMatch(recovery, /registry-url:/u);
  assert.match(recovery, /npm install --global npm@11\.16\.0[\s\S]*npm ci[\s\S]*npm run build/u);

  assert.match(recovery, new RegExp(`EXPECTED_SHA256: ${expectedSha256}`, "u"));
  assert.match(recovery, /TARBALL: release-artifact\/draftforge-dev-draftforge-0\.1\.0\.tgz/u);
  assert.equal((recovery.match(/npm pack/gu) ?? []).length, 1);
  assert.match(recovery, /release-check\.mjs "\$TARBALL" --tag v0\.1\.0 --sha256 "\$EXPECTED_SHA256"/u);
  assert.match(recovery, /npm view[\s\S]*view_status[\s\S]*E404\|404 Not Found[\s\S]*refusing recovery publication/u);
  assert.equal((recovery.match(/npm publish/gu) ?? []).length, 1);
  assert.match(recovery, /npm publish "\.\/\$TARBALL" --provenance --access public --registry "\$REGISTRY"/u);
  assert.doesNotMatch(recovery, /npm publish "\$TARBALL"/u);
  assert.match(recovery, /--sha256 "\$EXPECTED_SHA256"[\s\S]*--downloaded[\s\S]*--npm-metadata registry-npmjs\/metadata\.json/u);
  assert.doesNotMatch(recovery, /npm\.pkg\.github\.com|GH_PACKAGES|gh release|release upload|github\.token|secrets\.|NPM_TOKEN|NODE_AUTH_TOKEN|_authToken/u);

  for (const name of [
    "package",
    "artifact-smoke",
    "publication-authority",
    "publish-github-packages",
    "publish-npmjs",
    "verify-registries",
    "github-release",
    "verify-release-assets",
  ]) {
    assert.match(job(workflow, name), /if: github\.event_name == 'push'/u, `${name} must not run during manual recovery`);
  }
});

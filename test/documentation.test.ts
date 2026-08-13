import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { main, type CliIo } from "../src/cli.js";
import { readProjectState } from "../src/state/files.js";

const DOCS = [
  "README.md", "SECURITY.md", "CHANGELOG.md", "docs/INSTALLATION.md",
  "docs/PROVIDERS.md", "docs/UPGRADING.md", "docs/TROUBLESHOOTING.md",
  "docs/EXAMPLE.md", "docs/RELEASE.md",
  "docs/decisions/0011-release-artifact-upgrades-and-provenance.md",
  "docs/decisions/0012-owner-scoped-github-packages-mirror.md",
] as const;

const RELEASE_NAME = "@draftforge-dev/draftforge";
const RELEASE_VERSION = "0.1.0";

function capture(): { io: CliIo; output: string[]; errors: string[] } {
  const output: string[] = [];
  const errors: string[] = [];
  return { io: { out: (m) => output.push(m), error: (m) => errors.push(m) }, output, errors };
}

test("documentation internal links resolve", async () => {
  for (const source of DOCS) {
    const markdown = await readFile(resolve(source), "utf8");
    for (const match of markdown.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu)) {
      const destination = match[1];
      if (destination === undefined || /^(?:https?:|mailto:|#)/u.test(destination)) continue;
      const path = decodeURIComponent(destination.split("#", 1)[0] ?? "");
      assert.notEqual(path, "", `${source} has an empty link target`);
      await assert.doesNotReject(access(resolve(dirname(source), path)), `${source}: ${destination}`);
    }
  }
});

test("packaged README uses stable repository links for non-packaged files", async () => {
  const readme = await readFile(resolve("README.md"), "utf8");
  const destinations = [...readme.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu)]
    .map((match) => match[1])
    .filter((destination): destination is string => destination !== undefined);
  assert.ok(destinations.length > 0);
  for (const destination of destinations) {
    assert.ok(
      destination.startsWith("#")
        || destination.startsWith("https://github.com/darkweb19/draftforge/")
        || destination === "https://www.npmjs.com/package/@draftforge-dev/draftforge",
      `README link is not tarball-safe: ${destination}`,
    );
  }
  for (const destination of [
    "https://github.com/darkweb19/draftforge/blob/main/docs/INSTALLATION.md",
    "https://github.com/darkweb19/draftforge/blob/main/SECURITY.md",
    "https://github.com/darkweb19/draftforge/blob/main/docs/EXAMPLE.md",
  ]) assert.ok(destinations.includes(destination), `README is missing ${destination}`);
});

test("release identity and installation commands stay canonical", async () => {
  const packageJson: unknown = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  const packageLock: unknown = JSON.parse(await readFile(resolve("package-lock.json"), "utf8"));
  const metadata = packageJson as {
    name: string; version: string; private?: boolean; license: string;
    repository: { type: string; url: string }; bugs: { url: string }; homepage: string;
    bin: { draftforge: string }; files: string[]; engines: { node: string };
    packageManager: string; publishConfig: { access: string; registry: string };
  };
  const lock = packageLock as { name: string; version: string; packages: { "": { name: string; version: string } } };

  assert.equal(metadata.name, RELEASE_NAME);
  assert.equal(metadata.version, RELEASE_VERSION);
  assert.equal(metadata.private, undefined);
  assert.equal(metadata.license, "MIT");
  assert.deepEqual(metadata.repository, {
    type: "git",
    url: "git+https://github.com/darkweb19/draftforge.git",
  });
  assert.equal(metadata.bugs.url, "https://github.com/darkweb19/draftforge/issues");
  assert.equal(metadata.homepage, "https://github.com/darkweb19/draftforge#readme");
  assert.deepEqual(metadata.bin, { draftforge: "./dist/bin.js" });
  assert.deepEqual(metadata.files, ["dist", "templates", "README.md", "LICENSE"]);
  assert.deepEqual(metadata.engines, { node: ">=22" });
  assert.equal(metadata.packageManager, "npm@11.16.0");
  assert.deepEqual(metadata.publishConfig, {
    access: "public",
    registry: "https://registry.npmjs.org/",
  });
  assert.equal(lock.name, RELEASE_NAME);
  assert.equal(lock.version, RELEASE_VERSION);
  assert.equal(lock.packages[""].name, RELEASE_NAME);
  assert.equal(lock.packages[""].version, RELEASE_VERSION);

  const releaseDocs = await Promise.all([
    "README.md", "CHANGELOG.md", "SECURITY.md", "docs/INSTALLATION.md",
    "docs/TROUBLESHOOTING.md", "to-do-sujan.md",
  ].map(async (path) => readFile(resolve(path), "utf8")));
  const combined = releaseDocs.join("\n");
  assert.doesNotMatch(combined, /@YOUR_SCOPE|0\.0\.0/u);
  assert.match(combined, /npm install --global @draftforge-dev\/draftforge/u);
  assert.match(combined, /npm uninstall --global @draftforge-dev\/draftforge/u);
  assert.match(combined, /npmjs is\s+the canonical registry/u);
  assert.match(combined, /GitHub Packages (?:will be |is )?a? ?(?:repository-linked )?mirror/u);
  assert.match(combined, /^## 0\.1\.0$/mu);
  const lifecycleNeutralDocs = await Promise.all([
    "README.md", "CHANGELOG.md", "SECURITY.md", "docs/INSTALLATION.md",
  ].map(async (path) => readFile(resolve(path), "utf8")));
  assert.doesNotMatch(
    lifecycleNeutralDocs.join("\n"),
    /not (?:a )?published release|has not been published|not available from the registry|evidence (?:is )?still (?:in progress|pending)|final three-(?:platform|OS) gate has not passed/iu,
  );
});

test("release documentation keeps the owner-scoped mirror contract", async () => {
  const [readme, installation, release, decision, checklist] = await Promise.all([
    "README.md", "docs/INSTALLATION.md", "docs/RELEASE.md",
    "docs/decisions/0012-owner-scoped-github-packages-mirror.md", "to-do-sujan.md",
  ].map(async (path) => readFile(resolve(path), "utf8")));
  const publicDocs = [readme, installation].join("\n");
  const operatorDocs = [release, decision, checklist].join("\n");

  assert.match(publicDocs, /@darkweb19\/draftforge/u);
  assert.match(publicDocs, /same `draftforge` binary/u);
  assert.match(publicDocs, /Users should install the canonical npmjs package/u);
  assert.match(operatorDocs, /built-in\s+`GITHUB_TOKEN`/u);
  assert.match(operatorDocs, /different[\s\S]{0,40}SHA-256 digests/u);
  assert.match(operatorDocs, /`name`/u);
  assert.match(operatorDocs, /`publishConfig\.registry`/u);
  assert.match(operatorDocs, /Ubuntu, macOS, and Windows/u);
  assert.match(operatorDocs, /GitHub Release[\s\S]{0,100}canonical npmjs tarball/u);
  assert.match(operatorDocs, /No new GitHub organization/u);
  assert.match(operatorDocs, /Do not (?:create|configure) a PAT/u);
});

test("quickstart prepares a clean Git root and states ignore ownership", async () => {
  const readme = await readFile(resolve("README.md"), "utf8");
  const security = await readFile(resolve("SECURITY.md"), "utf8");
  const providers = await readFile(resolve("docs", "PROVIDERS.md"), "utf8");
  const gitInit = readme.indexOf("git init");
  const initialCommit = readme.indexOf('git commit -m "chore: initialize project"');
  const approval = readme.indexOf("draftforge plan --approve --by <actor>");
  const planCommit = readme.indexOf('git commit -m "chore: approve DraftForge plan"');
  const run = readme.indexOf("draftforge run --by <actor>");
  assert.ok(gitInit >= 0 && gitInit < initialCommit);
  assert.ok(initialCommit < approval && approval < planCommit && planCommit < run);
  assert.doesNotMatch(readme, /^git add \.$/mu);
  for (const entry of [".draftforge/config.local.json", ".draftforge/runs/*", ".draftforge/backups/"]) {
    assert.ok(readme.includes(entry), `README lacks ignore entry ${entry}`);
  }
  assert.match(readme, /`init` does not create `.gitignore`/u);
  assert.match(security, /Initialization does not create `.gitignore`/u);
  assert.match(providers, /Initialization does not create\s+`.gitignore`/u);
  assert.match(readme, /Ignored files are not encrypted/u);
});

test("example foundation owns package verification without path overlap", async () => {
  const response: unknown = JSON.parse(await readFile(resolve("examples", "local-notes", "plan.json"), "utf8"));
  const tasks = (response as { plan: { tasks: Array<{ id: string; ownedPaths: string[]; acceptanceCriteria: string[] }> } }).plan.tasks;
  const foundation = tasks.find((task) => task.id === "P01-T01");
  const cli = tasks.find((task) => task.id === "P01-T02");
  assert.ok(foundation !== undefined && cli !== undefined);
  assert.ok(foundation.ownedPaths.includes("package.json"));
  assert.ok(foundation.ownedPaths.includes("package-lock.json"));
  assert.ok(foundation.acceptanceCriteria.some((criterion) => criterion.includes("npm test script")));
  assert.deepEqual(foundation.ownedPaths.filter((path) => cli.ownedPaths.includes(path)), []);
});

test("documented command families remain in CLI help", async () => {
  const result = capture();
  assert.equal(await main(["help"], result.io), 0);
  assert.deepEqual(result.errors, []);
  const help = result.output.join("\n");
  for (const command of ["init", "doctor", "status", "plan", "run", "resume", "review", "upgrade", "handoff"]) {
    assert.match(help, new RegExp(`^\\s*${command}(?:\\s|$)`, "mu"));
  }
  const readme = await readFile(resolve("README.md"), "utf8");
  for (const command of [
    "draftforge plan --approve --by <actor>", "draftforge resume [--by <actor>]",
    "draftforge review [--by <actor>]", "draftforge upgrade",
  ]) assert.ok(readme.includes(command), `README is missing ${command}`);
});

test("committed example approves deterministically without a provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "draftforge-doc-example-"));
  try {
    assert.equal(await main(["init", root, "--name", "Local notes index"], capture().io), 0);
    for (const file of ["idea.md", "questions.json", "plan.json"] as const) {
      await writeFile(join(root, file), await readFile(resolve("examples", "local-notes", file), "utf8"), "utf8");
    }
    for (const args of [
      ["plan", "idea.md"], ["plan", "--submit", "questions.json"],
      ["plan", "--answer", "storage=JSON-file-beside-the-notes"],
      ["plan", "--submit", "plan.json"],
      ["plan", "--approve", "--by", "example-operator"], ["status"], ["handoff"],
    ] as const) {
      const result = capture();
      assert.equal(await main(args, result.io, root), 0, `${args.join(" ")}: ${result.errors.join("\n")}`);
      assert.deepEqual(result.errors, []);
    }
    const state = await readProjectState(root);
    assert.equal(state.workflow.phaseId, "phase-01");
    assert.equal(state.tasks.find((task) => task.id === "P01-T01")?.status, "ready");
    assert.equal(state.tasks.find((task) => task.id === "P01-T02")?.status, "backlog");
    assert.equal(state.handoff.updatedBy, "example-operator");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

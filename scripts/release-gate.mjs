import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  auditTarball,
  expectedTarballEntries,
  prepareSmokeInvocation,
} from "./package-smoke.mjs";

export const RELEASE_NAME = "@draftforge-dev/draftforge";
export const GITHUB_MIRROR_NAME = "@darkweb19/draftforge";
export const RELEASE_VERSION = "0.1.0";
export const RELEASE_TAG = `v${RELEASE_VERSION}`;
export const RELEASE_IDENTITIES = Object.freeze({
  npmjs: Object.freeze({ name: RELEASE_NAME, registry: "https://registry.npmjs.org/" }),
  github: Object.freeze({ name: GITHUB_MIRROR_NAME, registry: "https://npm.pkg.github.com/" }),
});
const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";
const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function parseChecksum(contents, tarballName) {
  const line = contents.trim();
  const match = /^([a-fA-F0-9]{64})\s+[ *]?([^\r\n]+)$/u.exec(line);
  if (match === null) {
    throw new Error("Checksum must contain one SHA-256 digest and the tarball filename.");
  }
  const [, digest, recordedName] = match;
  if (basename(recordedName) !== tarballName) {
    throw new Error(`Checksum names ${recordedName}; expected ${tarballName}.`);
  }
  return digest.toLowerCase();
}

export function assertChecksum(buffer, expectedDigest) {
  const normalized = expectedDigest.toLowerCase();
  if (!SHA256.test(normalized)) throw new Error("Expected checksum is not a SHA-256 digest.");
  const actual = sha256(buffer);
  if (actual !== normalized) {
    throw new Error(`Tarball checksum mismatch: expected ${normalized}, received ${actual}.`);
  }
  return actual;
}

/** Validate the registry metadata that the post-publish npmjs gate observes. */
export function assertNpmProvenance(metadata) {
  assert.equal(metadata?.name, RELEASE_NAME, "Published npm package name must match the release identity");
  assert.equal(metadata?.version, RELEASE_VERSION, "Published npm package version must match the release identity");
  const attestations = metadata?.dist?.attestations;
  if (typeof attestations?.url !== "string" || !attestations.url.startsWith("https://")) {
    throw new Error("Published npm package is missing its provenance attestation URL.");
  }
  assert.equal(
    attestations.provenance?.predicateType,
    SLSA_PROVENANCE_V1,
    "Published npm package is missing SLSA provenance v1 metadata",
  );
}

export function npmTarballName(name, version) {
  return `${name.replace(/^@/u, "").replaceAll("/", "-")}-${version}.tgz`;
}

export function validateReleaseIdentity(metadata, sourceMetadata, options = {}) {
  const identity = releaseIdentity(options.identity);
  const tag = options.tag ?? `v${sourceMetadata.version}`;
  const tarballName = options.tarballName ?? npmTarballName(identity.name, sourceMetadata.version);
  assert.equal(sourceMetadata.name, RELEASE_NAME, `package.json name must be ${RELEASE_NAME}`);
  assert.equal(sourceMetadata.version, RELEASE_VERSION, `package.json version must be ${RELEASE_VERSION}`);
  assert.equal(metadata.name, identity.name, "Tarball package name must match its release identity");
  assert.equal(metadata.version, sourceMetadata.version, "Tarball version must match package.json");
  assert.equal(tag, `v${sourceMetadata.version}`, "Release tag must match package.json version");
  assert.equal(
    tarballName,
    npmTarballName(identity.name, sourceMetadata.version),
    "Tarball filename must match package name and version",
  );
  assert.equal(metadata.private, undefined, "Release package must not be private");
  assert.deepEqual(metadata.bin, { draftforge: "./dist/bin.js" }, "Tarball must expose the installed draftforge binary");
  assert.equal(metadata.engines?.node, ">=22", "Tarball must require Node.js 22 or newer");
  assert.equal(metadata.publishConfig?.access, "public", "Tarball publish access must be public");
  assert.equal(
    metadata.publishConfig?.registry,
    identity.registry,
    `Tarball registry must match the ${options.identity ?? "npmjs"} release identity`,
  );
  assert.deepEqual(metadata.repository, sourceMetadata.repository, "Tarball repository metadata must match package.json");
}

function releaseIdentity(identity = "npmjs") {
  if (!(identity in RELEASE_IDENTITIES)) throw new Error(`Unknown release identity: ${identity}`);
  return RELEASE_IDENTITIES[identity];
}

export function assertTarballShape(actualEntries, expectedEntries) {
  const actual = new Set(actualEntries);
  const expected = new Set(expectedEntries);
  for (const entry of actual) {
    if (!expected.has(entry)) throw new Error(`Unexpected file in release tarball: ${entry}`);
  }
  for (const entry of expected) {
    if (!actual.has(entry)) throw new Error(`Missing required package file: ${entry}`);
  }
  if (!actual.has("package/dist/bin.js")) throw new Error("Installed binary is missing from the release tarball.");
  if (![...actual].some((entry) => entry.startsWith("package/templates/"))) {
    throw new Error("Release tarball contains no project templates.");
  }
}

export function readTarball(buffer) {
  const archive = gunzipSync(buffer);
  const entries = new Map();
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const size = Number.parseInt(tarString(header, 124, 12).trim() || "0", 8);
    const mode = Number.parseInt(tarString(header, 100, 8).trim() || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid tarball entry size.");
    const path = prefix.length > 0 ? `${prefix}/${name}` : name;
    const type = header[156];
    const dataOffset = offset + 512;
    if (name.length > 0 && type !== 53) {
      if (type !== 0 && type !== 48) throw new Error(`Unexpected tarball entry type: ${path}`);
      if (entries.has(path)) throw new Error(`Duplicate tarball entry: ${path}`);
      entries.set(path, { data: archive.subarray(dataOffset, dataOffset + size), mode });
    }
    offset = dataOffset + Math.ceil(size / 512) * 512;
  }
  return entries;
}

export async function inspectCandidate(tarballInput, options = {}) {
  const root = resolve(options.repositoryRoot ?? repositoryRoot);
  const tarball = resolve(tarballInput);
  const status = await lstat(tarball);
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error("Release candidate tarball must be a regular, non-symlinked file.");
  }
  const buffer = await readFile(tarball);
  const expectedDigest = options.expectedSha256 ?? parseChecksum(
    await readFile(resolve(options.checksumPath ?? `${tarball}.sha256`), "utf8"),
    basename(tarball),
  );
  const digest = assertChecksum(buffer, expectedDigest);
  const sourceMetadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const expectedEntries = options.expectedEntries ?? await expectedTarballEntries(root);
  auditTarball(buffer, tarball, expectedEntries);
  const entries = readTarball(buffer);
  assertTarballShape([...entries.keys()], expectedEntries);
  const packedMetadataEntry = entries.get("package/package.json");
  if (packedMetadataEntry === undefined) throw new Error("Tarball package.json is missing.");
  const metadata = JSON.parse(packedMetadataEntry.data.toString("utf8"));
  validateReleaseIdentity(metadata, sourceMetadata, {
    identity: options.identity,
    tag: options.tag,
    tarballName: basename(tarball),
  });
  const binary = entries.get("package/dist/bin.js");
  if (binary === undefined || !binary.data.toString("utf8").startsWith("#!/usr/bin/env node")) {
    throw new Error("Installed binary must have a Node.js shebang.");
  }
  await validateReleaseDocuments(root, sourceMetadata);
  return { tarball, digest, metadata, entries: [...entries.keys()] };
}

export async function validateReleaseDocuments(root, metadata) {
  const installCommand = `npm install --global ${metadata.name}`;
  const [readme, installation, changelog] = await Promise.all([
    readFile(join(root, "README.md"), "utf8"),
    readFile(join(root, "docs", "INSTALLATION.md"), "utf8"),
    readFile(join(root, "CHANGELOG.md"), "utf8"),
  ]);
  assert.ok(readme.includes(installCommand), `README must contain ${installCommand}`);
  assert.ok(installation.includes(installCommand), `Installation guide must contain ${installCommand}`);
  assert.match(changelog, new RegExp(`^## ${escapeRegExp(metadata.version)}(?:\\s|$)`, "mu"));
}

export async function runInstalledGate(tarballInput, metadata, options = {}) {
  const root = resolve(options.repositoryRoot ?? repositoryRoot);
  const tarball = resolve(tarballInput);
  const smokeRoot = await mkdtemp(join(tmpdir(), "draftforge-release-gate-"));
  try {
    await writeFile(
      join(smokeRoot, "package.json"),
      `${JSON.stringify({ name: "draftforge-release-gate", private: true, version: "0.0.0" })}\n`,
      "utf8",
    );
    const baseEnv = releaseEnvironment(smokeRoot);
    await run(npmInvocation(), [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      tarball,
    ], { cwd: smokeRoot, env: baseEnv });

    const binary = await installedBinary(smokeRoot);
    const version = await run(binary.invocation, ["--version"], { cwd: smokeRoot, env: baseEnv });
    assert.equal(version.stdout.trim(), metadata.version, "Installed binary is inert or reports the wrong version");

    const doctorShims = await createHarnessShims(smokeRoot, "pass");
    const project = join(smokeRoot, "project");
    const commandEnv = { ...baseEnv, PATH: `${doctorShims.directory}${delimiter}${baseEnv.PATH}` };
    await run(binary.invocation, ["init", project, "--name", "Release gate"], { cwd: smokeRoot, env: commandEnv });
    await run(binary.invocation, ["doctor"], { cwd: project, env: commandEnv });
    await run(binary.invocation, ["status"], { cwd: project, env: commandEnv });
    await run(binary.invocation, ["handoff"], { cwd: project, env: commandEnv });
    await runUpgradeGate(binary.invocation, smokeRoot, project, root, commandEnv);
    await runUnsafeUpgradeGates(binary.invocation, smokeRoot, commandEnv);
    await runResumeReviewGate(binary.invocation, smokeRoot, root, baseEnv);
  } finally {
    await rm(smokeRoot, { recursive: true, force: true });
  }
}

async function runUpgradeGate(binary, smokeRoot, project, root, env) {
  const statePath = join(project, ".draftforge", "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.schemaVersion = 2;
  for (const task of state.tasks ?? []) delete task.review;
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await writeFile(
    join(project, ".draftforge", "schema", "state.schema.json"),
    await readFile(join(root, "test", "fixtures", "release", "upgrade", "state-v2.schema.json"), "utf8"),
    "utf8",
  );
  await run(binary, ["upgrade"], { cwd: project, env });
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).schemaVersion, 3);
  await run(binary, ["status"], { cwd: project, env });

  // Keep the caller-visible temp tree names stable when a failure is reported.
  assert.ok(project.startsWith(smokeRoot));
}

async function runUnsafeUpgradeGates(binary, smokeRoot, env) {
  const future = join(smokeRoot, "future-state");
  await run(binary, ["init", future, "--name", "Future state"], { cwd: smokeRoot, env });
  const futureState = join(future, ".draftforge", "state.json");
  const futureJson = JSON.parse(await readFile(futureState, "utf8"));
  await writeFile(futureState, `${JSON.stringify({ ...futureJson, schemaVersion: 4 }, null, 2)}\n`, "utf8");
  const futureBefore = await snapshotFiles(future, [".draftforge/state.json", "SESSION.md"]);
  await run(binary, ["upgrade"], { cwd: future, env, expectedExitCode: 2 });
  assert.deepEqual(await snapshotFiles(future, [".draftforge/state.json", "SESSION.md"]), futureBefore);

  const modified = join(smokeRoot, "modified-schema");
  await run(binary, ["init", modified, "--name", "Modified schema"], { cwd: smokeRoot, env });
  const schemaPath = ".draftforge/schema/state.schema.json";
  await writeFile(join(modified, schemaPath), "user-modified schema\n", "utf8");
  const modifiedBefore = await snapshotFiles(modified, [".draftforge/state.json", "SESSION.md", schemaPath]);
  await run(binary, ["upgrade"], { cwd: modified, env, expectedExitCode: 2 });
  assert.deepEqual(
    await snapshotFiles(modified, [".draftforge/state.json", "SESSION.md", schemaPath]),
    modifiedBefore,
  );
}

async function runResumeReviewGate(binary, smokeRoot, root, baseEnv) {
  const project = join(smokeRoot, "interrupted");
  await run(process.execPath, [
    "--import",
    "tsx",
    join(root, "test", "fixtures", "execution", "project.ts"),
    "resumable",
    project,
  ], { cwd: root, env: baseEnv });
  await writeFile(
    join(project, ".gitignore"),
    [".draftforge/runs/", ".draftforge/state.json", "SESSION.md", ""].join("\n"),
    "utf8",
  );
  await run("git", ["init", "-b", "main"], { cwd: project, env: baseEnv });
  await run("git", ["config", "user.name", "DraftForge release gate"], { cwd: project, env: baseEnv });
  await run("git", ["config", "user.email", "release-gate@invalid.example"], { cwd: project, env: baseEnv });
  await run("git", ["add", "--all"], { cwd: project, env: baseEnv });
  await run("git", ["commit", "-m", "test: seed release acceptance fixture"], { cwd: project, env: baseEnv });
  const baseCommit = (await run("git", ["rev-parse", "HEAD"], { cwd: project, env: baseEnv })).stdout.trim();
  assert.match(baseCommit, GIT_COMMIT, "Release acceptance fixture must have a real Git base commit");

  const worktree = join(project, ".draftforge", "runs", "run-seed", "worktrees", "P04-T01");
  const branch = "draftforge/run-seed/P04-T01/alpha-01";
  await run("git", ["config", "extensions.worktreeConfig", "true"], { cwd: project, env: baseEnv });
  await run("git", ["worktree", "add", "-b", branch, worktree, baseCommit], { cwd: project, env: baseEnv });
  await run("git", ["config", "--worktree", "draftforge.attempt-id", "alpha-01"], { cwd: worktree, env: baseEnv });
  await run("git", ["config", "--worktree", "draftforge.base-commit", baseCommit], { cwd: worktree, env: baseEnv });
  await mkdir(join(worktree, "src", "alpha"), { recursive: true });
  await writeFile(join(worktree, "src", "alpha", "index.ts"), "export const alpha = true;\n", "utf8");
  const trap = await createHarnessShims(smokeRoot, "trap");
  const env = {
    ...baseEnv,
    PATH: `${trap.directory}${delimiter}${baseEnv.PATH}`,
    DRAFTFORGE_RELEASE_PROVIDER_MARKER: trap.marker,
  };
  await run(binary, ["resume", "--by", "release-gate"], { cwd: project, env });
  const statePath = join(project, ".draftforge", "state.json");
  const firstState = await readFile(statePath, "utf8");
  const parsed = JSON.parse(firstState);
  const alpha = parsed.tasks.find((task) => task.id === "P04-T01");
  assert.equal(alpha?.status, "review", "Interrupted attempt must reconcile to review");
  const manifestPath = join(
    project,
    ".draftforge",
    "runs",
    alpha.attempt.runId,
    "attempts",
    `${alpha.attempt.attemptId}.json`,
  );
  const firstManifest = await readFile(manifestPath, "utf8");
  await run(binary, ["resume", "--by", "release-gate"], { cwd: project, env });
  assert.equal(await readFile(statePath, "utf8"), firstState, "A second resume must not duplicate state work");
  assert.equal(await readFile(manifestPath, "utf8"), firstManifest, "A second resume must not duplicate attempt work");
  await assertMissing(trap.marker, "Resume unexpectedly invoked a provider harness");

  const manifest = JSON.parse(firstManifest);
  manifest.lifecycle = "review";
  manifest.baseCommit = baseCommit;
  manifest.verification = {
    status: "passed",
    classification: null,
    commands: [],
    completedAt: new Date().toISOString(),
  };
  manifest.scan = null;
  manifest.verdict = {
    verdict: "accept",
    classification: null,
    findingCount: 0,
    evidencePath: null,
    recordedAt: new Date().toISOString(),
  };
  manifest.integration = null;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const review = await run(binary, ["review", "--by", "release-gate"], { cwd: project, env });
  assert.match(review.stdout, /^Integrated: P04-T01$/mu);
  const reviewed = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(reviewed.tasks.find((task) => task.id === "P04-T01")?.status, "done");
  const integration = JSON.parse(await readFile(manifestPath, "utf8")).integration;
  const projectHead = (await run("git", ["rev-parse", "HEAD"], { cwd: project, env: baseEnv })).stdout.trim();
  const branchTip = (await run("git", ["rev-parse", branch], { cwd: project, env: baseEnv })).stdout.trim();
  assert.notEqual(projectHead, baseCommit, "Review must create a real integration commit");
  assert.equal(integration?.status, "integrated");
  assert.equal(integration?.rollbackCommit, baseCommit);
  assert.equal(integration?.integrationCommit, projectHead);
  await run("git", ["merge-base", "--is-ancestor", branchTip, projectHead], { cwd: project, env: baseEnv });
  assert.equal(await readFile(join(project, "src", "alpha", "index.ts"), "utf8"), "export const alpha = true;\n");
  await run(binary, ["status"], { cwd: project, env });
  await assertMissing(trap.marker, "Review recovery unexpectedly invoked a provider harness");
}

export async function runReleaseGate(options) {
  const candidate = await inspectCandidate(options.tarball, options);
  await runInstalledGate(candidate.tarball, candidate.metadata, options);
  return candidate;
}

async function installedBinary(root) {
  const path = process.platform === "win32"
    ? join(root, "node_modules", ".bin", "draftforge.cmd")
    : join(root, "node_modules", ".bin", "draftforge");
  const status = await lstat(path);
  if (process.platform === "win32") {
    assert.ok(status.isFile() && !status.isSymbolicLink(), "npm must generate the Windows draftforge.cmd shim");
    return { path, invocation: path };
  }
  assert.ok(status.isSymbolicLink(), "npm must generate the POSIX draftforge binary symlink");
  const target = resolve(join(path, ".."), await readlink(path));
  const targetStatus = await lstat(target);
  assert.ok(targetStatus.isFile() && !targetStatus.isSymbolicLink(), "npm-generated draftforge symlink target must be an installed regular file");
  return { path, invocation: { command: process.execPath, prefix: [path] } };
}

function npmInvocation() {
  if (typeof process.env.npm_execpath === "string" && process.env.npm_execpath.length > 0) {
    return { command: process.execPath, prefix: [process.env.npm_execpath] };
  }
  return { command: process.platform === "win32" ? "npm.cmd" : "npm", prefix: [] };
}

async function run(commandInput, args, options) {
  const command = typeof commandInput === "string" ? commandInput : commandInput.command;
  const completeArgs = typeof commandInput === "string" ? args : [...commandInput.prefix, ...args];
  const invocation = prepareSmokeInvocation(command, completeArgs);
  const expectedExitCode = options.expectedExitCode ?? 0;
  return new Promise((resolveRun, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (exitCode === expectedExitCode) resolveRun({ stdout, stderr, exitCode });
      else {
        const diagnostic = stderr.trim() || stdout.trim() || "no diagnostic";
        reject(new Error(`${basename(command)} exited ${String(exitCode)}; expected ${String(expectedExitCode)}. ${diagnostic}`));
      }
    });
  });
}

function releaseEnvironment(cacheRoot) {
  const allowed = [
    "APPDATA", "ComSpec", "HOME", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA",
    "NODE_OPTIONS", "PATH", "PATHEXT", "SystemDrive", "SystemRoot", "TEMP", "TMP",
    "USERPROFILE", "WINDIR",
  ];
  const environment = {};
  for (const key of allowed) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  environment.PATH = environment.PATH ?? "";
  environment.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.npm_config_cache = join(cacheRoot, "npm-cache");
  environment.npm_config_update_notifier = "false";
  return environment;
}

async function createHarnessShims(root, mode) {
  const directory = join(root, `harness-${mode}`);
  const marker = join(root, "provider-invoked.txt");
  await mkdir(directory, { recursive: true });
  for (const name of ["codex", "claude"]) {
    if (process.platform === "win32") {
      const body = mode === "pass"
        ? "@echo off\r\nexit /b 0\r\n"
        : "@echo off\r\n>\"%DRAFTFORGE_RELEASE_PROVIDER_MARKER%\" echo invoked\r\nexit /b 97\r\n";
      await writeFile(join(directory, `${name}.cmd`), body, "utf8");
    } else {
      const body = mode === "pass"
        ? "#!/bin/sh\nexit 0\n"
        : "#!/bin/sh\nprintf invoked > \"$DRAFTFORGE_RELEASE_PROVIDER_MARKER\"\nexit 97\n";
      const path = join(directory, name);
      await writeFile(path, body, "utf8");
      await chmod(path, 0o755);
    }
  }
  return { directory, marker };
}

async function snapshotFiles(root, relativePaths) {
  return Promise.all(relativePaths.map(async (path) => [path, await readFile(join(root, path), "utf8")]));
}

async function assertMissing(path, message) {
  try {
    await access(path);
  } catch {
    return;
  }
  throw new Error(message);
}

function tarString(buffer, start, length) {
  const boundary = start + length;
  const end = buffer.indexOf(0, start);
  return buffer.subarray(start, end === -1 || end > boundary ? boundary : end).toString("utf8");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function parseArguments(args) {
  const [tarball, ...rest] = args;
  if (tarball === undefined || tarball.startsWith("--")) throw new Error(usage());
  const parsed = { tarball };
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index];
    const value = rest[index + 1];
    if (!["--checksum", "--identity", "--sha256", "--tag"].includes(option) || value === undefined || value.startsWith("--")) {
      throw new Error(usage());
    }
    if (option === "--checksum") parsed.checksumPath = value;
    if (option === "--identity") parsed.identity = value;
    if (option === "--sha256") parsed.expectedSha256 = value;
    if (option === "--tag") parsed.tag = value;
    index += 1;
  }
  if (parsed.checksumPath !== undefined && parsed.expectedSha256 !== undefined) {
    throw new Error("Use either --checksum or --sha256, not both.");
  }
  parsed.tag ??= RELEASE_TAG;
  releaseIdentity(parsed.identity);
  return parsed;
}

function usage() {
  return "Usage: node scripts/release-gate.mjs <tarball-path> [--identity <npmjs|github>] [--checksum <sha256-file> | --sha256 <digest>] [--tag <vX.Y.Z>]";
}

const entryUrl = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (entryUrl === import.meta.url) {
  try {
    const result = await runReleaseGate(parseArguments(process.argv.slice(2)));
    process.stdout.write(`Release gate passed: ${result.metadata.name}@${result.metadata.version}\n`);
    process.stdout.write(`Artifact: ${basename(result.tarball)}\n`);
    process.stdout.write(`SHA-256: ${result.digest}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

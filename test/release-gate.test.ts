import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
// The release gate is deliberately plain JavaScript so clean CI runners can
// execute it without a TypeScript loader.
// @ts-expect-error JavaScript executable intentionally has no declaration file.
import { assertChecksum, assertNpmProvenance, assertTarballShape, parseChecksum, runInstalledGate, sha256, validateReleaseIdentity } from "../scripts/release-gate.mjs";

interface FixtureMetadata {
  readonly source: Record<string, unknown>;
  readonly packed: Record<string, unknown>;
  readonly shape: {
    readonly expected: readonly string[];
    readonly staleDist: readonly string[];
    readonly missingTemplate: readonly string[];
  };
  readonly provenance: {
    readonly present: Record<string, unknown>;
    readonly missing: Record<string, unknown>;
  };
}

const fixtureRoot = resolve("test", "fixtures", "release", "gate");
const fixture = JSON.parse(await readFile(join(fixtureRoot, "failures.json"), "utf8")) as FixtureMetadata;

test("release identity fails closed on package, version, tag, tarball, and publication drift", () => {
  assert.doesNotThrow(() => validateReleaseIdentity(fixture.packed, fixture.source, {
    tag: "v0.1.0",
    tarballName: "draftforge-dev-draftforge-0.1.0.tgz",
  }));

  assert.throws(
    () => validateReleaseIdentity({ ...fixture.packed, name: "draftforge" }, fixture.source),
    /Tarball package name/u,
  );
  assert.throws(
    () => validateReleaseIdentity({ ...fixture.packed, version: "0.1.1" }, fixture.source),
    /Tarball version/u,
  );
  assert.throws(
    () => validateReleaseIdentity(fixture.packed, fixture.source, { tag: "v0.1.1" }),
    /Release tag/u,
  );
  assert.throws(
    () => validateReleaseIdentity(fixture.packed, fixture.source, { tarballName: "candidate.tgz" }),
    /Tarball filename/u,
  );
  assert.throws(
    () => validateReleaseIdentity({ ...fixture.packed, private: true }, fixture.source),
    /must not be private/u,
  );
  assert.throws(
    () => validateReleaseIdentity({ ...fixture.packed, publishConfig: { access: "public", registry: "https://npm.pkg.github.com/" } }, fixture.source),
    /Tarball registry/u,
  );

  assert.doesNotThrow(() => validateReleaseIdentity({
    ...fixture.packed,
    name: "@darkweb19/draftforge",
    publishConfig: { access: "public", registry: "https://npm.pkg.github.com/" },
  }, fixture.source, {
    identity: "github",
    tag: "v0.1.0",
    tarballName: "darkweb19-draftforge-0.1.0.tgz",
  }));
  assert.throws(() => validateReleaseIdentity(fixture.packed, fixture.source, {
    identity: "github",
    tarballName: "darkweb19-draftforge-0.1.0.tgz",
  }), /release identity/u);
});

test("release shape rejects stale dist output and missing templates", () => {
  assert.doesNotThrow(() => assertTarballShape(fixture.shape.expected, fixture.shape.expected));
  assert.throws(
    () => assertTarballShape(fixture.shape.staleDist, fixture.shape.expected),
    /Unexpected file.*stale\.js/u,
  );
  assert.throws(
    () => assertTarballShape(fixture.shape.missingTemplate, fixture.shape.expected),
    /Missing required package file.*templates/u,
  );
});

test("checksum binds one digest to the exact tarball filename and bytes", () => {
  const tarball = Buffer.from("deterministic release candidate", "utf8");
  const digest = sha256(tarball);
  assert.equal(parseChecksum(`${digest}  draftforge-dev-draftforge-0.1.0.tgz\n`, "draftforge-dev-draftforge-0.1.0.tgz"), digest);
  assert.equal(assertChecksum(tarball, digest), digest);
  assert.throws(
    () => parseChecksum(`${digest}  replacement.tgz\n`, "draftforge-dev-draftforge-0.1.0.tgz"),
    /expected draftforge-dev-draftforge-0\.1\.0\.tgz/u,
  );
  assert.throws(() => assertChecksum(Buffer.from("changed", "utf8"), digest), /checksum mismatch/u);
});

test("npm publication provenance fails closed when the attestation is missing", () => {
  assert.doesNotThrow(() => assertNpmProvenance(fixture.provenance.present));
  assert.throws(() => assertNpmProvenance(fixture.provenance.missing), /missing.*provenance/u);
});

test("installed gate rejects an inert npm-generated binary", async (t) => {
  const tarball = await packFixture(t, "inert-binary");
  await assert.rejects(
    runInstalledGate(tarball, { version: "0.1.0" }),
    /binary is inert or reports the wrong version/u,
  );
});

test("installed gate exercises upgrade safety, idempotent resume, and a real Git merge to done", async (t) => {
  const tarball = await packFixture(t, "functional-binary");
  await runInstalledGate(tarball, { version: "0.1.0" });
});

async function packFixture(t: TestContext, name: string): Promise<string> {
  const destination = await mkdtemp(join(tmpdir(), `draftforge-release-${name}-`));
  t.after(async () => rm(destination, { recursive: true, force: true }));
  const source = join(destination, "source");
  const binary = join(source, "dist", "bin.js");
  await mkdir(join(source, "dist"), { recursive: true });
  await writeFile(
    join(source, "package.json"),
    await readFile(join(fixtureRoot, name, "package.json"), "utf8"),
    "utf8",
  );
  await writeFile(binary, fixtureBinary(name), "utf8");
  await chmod(binary, 0o755);
  const npmExecPath = process.env.npm_execpath ?? (
    process.platform === "win32"
      ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
      : undefined
  );
  const result = await run(npmExecPath === undefined ? "npm" : process.execPath, [
    ...(npmExecPath === undefined ? [] : [npmExecPath]),
    "pack",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    destination,
  ], source, {
    ...process.env,
    npm_config_cache: join(destination, "npm-cache"),
  });
  assert.equal(result.exitCode, 0, result.stderr);
  const records = JSON.parse(result.stdout) as readonly { readonly filename: string }[];
  const filename = records[0]?.filename;
  if (filename === undefined) throw new Error("npm pack did not report a fixture tarball.");
  const tarball = resolve(destination, basename(filename));
  // The sidecar mirrors the release workflow contract even though this helper
  // calls the installed phase directly.
  const bytes = await readFile(tarball);
  await writeFile(`${tarball}.sha256`, `${sha256(bytes)}  ${basename(tarball)}\n`, "utf8");
  return tarball;
}

function fixtureBinary(name: string): string {
  if (name === "inert-binary") {
    return [
      "#!/usr/bin/env node",
      "",
      "// Deliberately inert: the release gate must reject a package whose npm shim",
      "// exits successfully without reporting the package version.",
      "",
    ].join("\n");
  }
  assert.equal(name, "functional-binary");
  return [
    "#!/usr/bin/env node",
    "",
    'import { mkdirSync, readFileSync, writeFileSync } from "node:fs";',
    'import { execFileSync } from "node:child_process";',
    'import { join, resolve } from "node:path";',
    "",
    "const [command, ...args] = process.argv.slice(2);",
    "",
    'if (command === "--version") {',
    '  process.stdout.write("0.1.0\\n");',
    '} else if (command === "init") {',
    "  const root = resolve(args[0]);",
    '  const nameIndex = args.indexOf("--name");',
    '  const projectName = nameIndex === -1 ? "Fixture" : args[nameIndex + 1];',
    '  mkdirSync(join(root, ".draftforge", "schema"), { recursive: true });',
    "  const state = {",
    "    schemaVersion: 3,",
    '    project: { name: projectName, draftFile: "idea.md" },',
    '    workflow: { phaseId: "phase-00", phaseName: "Foundation", stage: "implementation", status: "in_progress", currentTask: null, nextTask: null },',
    "    phases: [], tasks: [], decisions: [],",
    '    handoff: { updatedAt: "2026-08-01T00:00:00.000Z", updatedBy: "fixture", summary: "Fixture", decisionsLocked: [], openQuestions: [], blockers: [], nextActions: [], gotchas: [] },',
    "  };",
    '  writeFileSync(join(root, ".draftforge", "state.json"), `${JSON.stringify(state, null, 2)}\\n`);',
    '  writeFileSync(join(root, ".draftforge", "schema", "state.schema.json"), "fixture-current-schema\\n");',
    '  writeFileSync(join(root, "SESSION.md"), "fixture session\\n");',
    '} else if (command === "upgrade") {',
    '  const statePath = join(process.cwd(), ".draftforge", "state.json");',
    '  const schemaPath = join(process.cwd(), ".draftforge", "schema", "state.schema.json");',
    '  const state = JSON.parse(readFileSync(statePath, "utf8"));',
    '  const schema = readFileSync(schemaPath, "utf8");',
    '  if (state.schemaVersion > 3 || schema === "user-modified schema\\n") {',
    "    process.exitCode = 2;",
    "  } else if (state.schemaVersion < 3) {",
    '    writeFileSync(statePath, `${JSON.stringify({ ...state, schemaVersion: 3 }, null, 2)}\\n`);',
    '    writeFileSync(schemaPath, "fixture-current-schema\\n");',
    "  }",
    '} else if (command === "resume") {',
    '  const statePath = join(process.cwd(), ".draftforge", "state.json");',
    '  const state = JSON.parse(readFileSync(statePath, "utf8"));',
    '  const tasks = state.tasks.map((task) => task.status === "active" ? { ...task, status: "review" } : task);',
    "  if (JSON.stringify(tasks) !== JSON.stringify(state.tasks)) {",
    '    writeFileSync(statePath, `${JSON.stringify({ ...state, tasks }, null, 2)}\\n`);',
    "  }",
    '} else if (command === "review") {',
    '  const statePath = join(process.cwd(), ".draftforge", "state.json");',
    '  const state = JSON.parse(readFileSync(statePath, "utf8"));',
    '  const integrated = state.tasks.filter((task) => task.status === "review").map((task) => task.id);',
    '  for (const task of state.tasks.filter((candidate) => candidate.status === "review")) {',
    "    const reference = task.attempt;",
    '    const manifestPath = join(process.cwd(), ".draftforge", "runs", reference.runId, "attempts", `${reference.attemptId}.json`);',
    '    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));',
    '    const worktree = join(process.cwd(), ".draftforge", "runs", reference.runId, "worktrees", task.id);',
    '    const rollbackCommit = git(process.cwd(), ["rev-parse", "HEAD"]);',
    '    git(worktree, ["add", "--all"]);',
    '    git(worktree, ["commit", "-m", `DraftForge: ${task.id}`]);',
    '    const branchTip = git(worktree, ["rev-parse", "HEAD"]);',
    '    git(process.cwd(), ["merge", "--no-ff", "--no-edit", branchTip]);',
    '    const integrationCommit = git(process.cwd(), ["rev-parse", "HEAD"]);',
    "    writeFileSync(manifestPath, `${JSON.stringify({",
    "      ...manifest,",
    '      lifecycle: "integrated",',
    "      integration: {",
    '        status: "integrated",',
    '        projectBranch: "main",',
    "        rollbackCommit,",
    "        integrationCommit,",
    "        integratedAt: new Date().toISOString(),",
    "      },",
    "    }, null, 2)}\\n`);",
    "  }",
    '  const tasks = state.tasks.map((task) => task.status === "review" ? { ...task, status: "done" } : task);',
    '  writeFileSync(statePath, `${JSON.stringify({ ...state, tasks }, null, 2)}\\n`);',
    '  process.stdout.write(`Integrated: ${integrated.join(", ")}\\n`);',
    '} else if (!["doctor", "status", "handoff"].includes(command)) {',
    '  process.stderr.write(`Unexpected fixture command: ${String(command)}\\n`);',
    "  process.exitCode = 2;",
    "}",
    "",
    "function git(cwd, args) {",
    '  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();',
    "}",
    "",
  ].join("\n");
}

function run(command: string, args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<{
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk: Buffer | string) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (exitCode) => resolveRun({ exitCode, stdout, stderr }));
  });
}

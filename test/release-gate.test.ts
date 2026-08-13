import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    /npmjs must remain the canonical registry/u,
  );
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
  ], resolve(fixtureRoot, name), {
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

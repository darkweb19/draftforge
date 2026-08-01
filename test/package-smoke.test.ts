import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { main, type CliIo } from "../src/cli.js";
// The package-smoke executable stays plain JavaScript so npm can invoke it
// without a TypeScript loader; its exported helper is covered here directly.
// @ts-expect-error JavaScript executable intentionally has no declaration file.
import { expectedTarballEntries, prepareSmokeInvocation } from "../scripts/package-smoke.mjs";

test("reports the package metadata version", async () => {
  const output: string[] = [];
  const io: CliIo = { out: (message) => output.push(message), error: () => undefined };
  const metadata: unknown = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  assert.equal(await main(["--version"], io), 0);
  assert.deepEqual(output, [(metadata as { version: string }).version]);
});

test("Windows package shims use an explicit escaped cmd.exe invocation", () => {
  const invocation = prepareSmokeInvocation("C:\\Program Files\\bin\\draftforge.cmd", ["init", "C:\\tmp\\a&b"], {
    platform: "win32",
    commandShell: "C:\\Windows\\System32\\cmd.exe",
  });
  assert.equal(invocation.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(invocation.windowsVerbatimArguments, true);
  assert.match(invocation.args[3] ?? "", /draftforge\.cmd/u);
  assert.match(invocation.args[3] ?? "", /\^\^\^&/u);
  assert.doesNotMatch(invocation.args[3] ?? "", /a&b/u);
});

test("executes the source CLI directly without running it when imported", async () => {
  const stalePath = resolve("dist", "stale-should-not-pack.js");
  await mkdir(resolve("dist"), { recursive: true });
  await writeFile(stalePath, "stale", "utf8");
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath === undefined) throw new Error("npm_execpath is required to run the build test.");
  const build = await run(process.execPath, [npmExecPath, "run", "build"]);
  assert.equal(build.exitCode, 0);
  await assert.rejects(access(stalePath));
  assert.equal((await expectedTarballEntries()).includes("package/dist/stale-should-not-pack.js"), false);
  assert.equal((await expectedTarballEntries()).includes("package/dist/bin.js"), true);

  const result = await run(process.execPath, ["--import", "tsx", "src/cli.ts", "--version"]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), JSON.parse(await readFile(resolve("package.json"), "utf8")).version);

  const compiled = await run(process.execPath, ["dist/cli.js", "--version"]);
  assert.equal(compiled.exitCode, 0);
  assert.equal(compiled.stdout.trim(), JSON.parse(await readFile(resolve("package.json"), "utf8")).version);
});

function run(command: string, args: readonly string[]): Promise<{ readonly exitCode: number | null; readonly stdout: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: resolve(), shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer | string) => { stdout += String(chunk); });
    child.once("error", reject);
    child.once("close", (exitCode) => resolveRun({ exitCode, stdout }));
  });
}

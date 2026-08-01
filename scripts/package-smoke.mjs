import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function auditTarball(buffer, tarballPath) {
  const entries = readTarEntries(gunzipSync(buffer));
  const required = new Set(["package/package.json", "package/dist/bin.js", "package/README.md", "package/LICENSE"]);
  for (const entry of entries) {
    if (!isAllowed(entry)) {
      throw new Error(`Unexpected file in ${basename(tarballPath)}: ${entry}`);
    }
    required.delete(entry);
  }
  if (required.size > 0) {
    throw new Error(`Missing required package files: ${[...required].join(", ")}`);
  }
}

function isAllowed(entry) {
  return entry === "package/package.json" ||
    entry === "package/README.md" ||
    entry === "package/LICENSE" ||
    entry.startsWith("package/dist/") ||
    entry.startsWith("package/templates/");
}

function readTarEntries(buffer) {
  const entries = [];
  for (let offset = 0; offset + 512 <= buffer.length;) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const size = Number.parseInt(readTarString(header, 124, 12).trim() || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid tarball entry size.");
    if (name.length > 0 && header[156] !== 53) entries.push(prefix.length > 0 ? `${prefix}/${name}` : name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function readTarString(buffer, start, length) {
  const end = buffer.indexOf(0, start);
  return buffer.subarray(start, end === -1 || end > start + length ? start + length : end).toString("utf8");
}

export function prepareSmokeInvocation(command, args, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" || !/\.(?:cmd|bat)$/iu.test(command)) {
    return { command, args, windowsVerbatimArguments: false };
  }
  const shellCommand = [
    escapeWindowsCommand(command),
    ...args.map((argument) => escapeWindowsArgument(argument, true)),
  ].join(" ");
  return {
    command: options.commandShell ?? process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${shellCommand}"`],
    windowsVerbatimArguments: true,
  };
}

const WINDOWS_META_CHARACTER = /([()[\]%!^"`<>&|;, *?])/gu;

function escapeWindowsCommand(command) {
  return command.replace(WINDOWS_META_CHARACTER, "^$1");
}

function escapeWindowsArgument(argument, doubleEscapeMetaCharacters) {
  let escaped = argument
    .replace(/(\\*)"/gu, "$1$1\\\"")
    .replace(/(\\*)$/u, "$1$1");
  escaped = `"${escaped}"`.replace(WINDOWS_META_CHARACTER, "^$1");
  return doubleEscapeMetaCharacters
    ? escaped.replace(WINDOWS_META_CHARACTER, "^$1")
    : escaped;
}

function run(command, args, cwd) {
  const invocation = prepareSmokeInvocation(command, args);
  return new Promise((resolveRun, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env: { ...process.env, npm_config_cache: join(cwd, "npm-cache") },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolveRun({ stdout });
      else reject(new Error(`${command} ${args.join(" ")} exited ${String(code)}: ${stderr}`));
    });
  });
}

async function main() {
  const [tarballArgument] = process.argv.slice(2);
  if (tarballArgument === undefined || process.argv.length !== 3) {
    throw new Error("Usage: npm run package:smoke -- <tarball-path>");
  }
  if (typeof process.env.npm_execpath !== "string" || process.env.npm_execpath.length === 0) {
    throw new Error("package smoke must run through npm so npm_execpath is available.");
  }

  const tarball = resolve(tarballArgument);
  const packageMetadata = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  assert.equal(typeof packageMetadata.version, "string", "package.json must have a version");
  auditTarball(await readFile(tarball), tarball);

  const smokeRoot = await mkdtemp(join(tmpdir(), "draftforge-package-smoke-"));
  try {
    await writeFile(
      join(smokeRoot, "package.json"),
      JSON.stringify({ name: "draftforge-package-smoke", private: true, version: "0.0.0" }),
      "utf8",
    );
    await run(process.execPath, [
      process.env.npm_execpath,
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      tarball,
    ], smokeRoot);

    const binary = process.platform === "win32"
      ? join(smokeRoot, "node_modules", ".bin", "draftforge.cmd")
      : join(smokeRoot, "node_modules", ".bin", "draftforge");
    const projectRoot = join(smokeRoot, "project");
    assert.equal((await run(binary, ["--version"], smokeRoot)).stdout.trim(), packageMetadata.version);
    await run(binary, ["init", projectRoot, "--name", "Package smoke"], smokeRoot);
    await run(binary, ["status"], projectRoot);
    await run(binary, ["handoff"], projectRoot);
  } finally {
    await rm(smokeRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}

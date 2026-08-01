import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export async function expectedTarballEntries(root = repositoryRoot) {
  const entries = ["package/package.json", "package/README.md", "package/LICENSE"];
  for (const directory of ["dist", "templates"]) {
    for (const file of await collectRegularFiles(root, directory)) {
      entries.push(`package/${file}`);
    }
  }
  return entries.sort();
}

async function collectRegularFiles(root, directory) {
  const absoluteDirectory = resolve(root, directory);
  const files = [];
  for (const entry of await readdir(absoluteDirectory, { withFileTypes: true })) {
    const absolutePath = join(absoluteDirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectRegularFiles(root, relative(root, absolutePath)));
      continue;
    }
    const status = await lstat(absolutePath);
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new Error(`Expected package source is not a regular file: ${relative(root, absolutePath)}`);
    }
    const file = relative(root, absolutePath).replaceAll("\\", "/");
    if (!isSafeRelativePath(file)) throw new Error(`Unsafe package source path: ${file}`);
    files.push(file);
  }
  return files;
}

export function auditTarball(buffer, tarballPath, expectedEntries) {
  const entries = readTarEntries(gunzipSync(buffer));
  const expected = new Set(expectedEntries);
  const actual = new Set();
  for (const entry of entries) {
    if (!isSafePackagePath(entry)) {
      throw new Error(`Unexpected file in ${basename(tarballPath)}: ${entry}`);
    }
    if (actual.has(entry) || !expected.has(entry)) {
      throw new Error(`Unexpected file in ${basename(tarballPath)}: ${entry}`);
    }
    actual.add(entry);
  }
  for (const entry of expected) {
    if (!actual.has(entry)) throw new Error(`Missing required package file: ${entry}`);
  }
}

function isSafePackagePath(entry) {
  return entry.startsWith("package/") && isSafeRelativePath(entry.slice("package/".length));
}

function isSafeRelativePath(path) {
  return path.length > 0 && !path.includes("\\") && path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
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
    const path = prefix.length > 0 ? `${prefix}/${name}` : name;
    const type = header[156];
    if (name.length > 0 && type !== 53) {
      if (type !== 0 && type !== 48) throw new Error(`Unexpected tarball entry type: ${path}`);
      entries.push(path);
    }
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
  auditTarball(await readFile(tarball), tarball, await expectedTarballEntries());

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

import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const [tarballArgument] = process.argv.slice(2);

if (tarballArgument === undefined || process.argv.length !== 3) {
  throw new Error("Usage: npm run package:smoke -- <tarball-path>");
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

  await run("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", tarball], smokeRoot);

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

function auditTarball(buffer, tarballPath) {
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

function run(command, args, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, npm_config_cache: join(cwd, "npm-cache") },
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
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

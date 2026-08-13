import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { auditTarball, expectedTarballEntries } from "./package-smoke.mjs";
import { assertNpmProvenance } from "./release-gate.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const EXPECTED_NAME = "@draftforge-dev/draftforge";
const EXPECTED_VERSION = "0.1.0";
const NPMJS_REGISTRY = "https://registry.npmjs.org/";
const REPOSITORY_URL = "git+https://github.com/darkweb19/draftforge.git";
const BUGS_URL = "https://github.com/darkweb19/draftforge/issues";
const TRUSTED_PUBLISHER_REPOSITORY = "darkweb19/draftforge";
const TRUSTED_PUBLISHER_WORKFLOW = "release.yml";
const TRUSTED_PUBLISHER_ENVIRONMENT = "npmjs";
const NPMJS_BOOTSTRAP_VERSION = "0.1.0-bootstrap.0";

function requireObject(value, label) {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value;
}

export function validatePackageMetadata(value, label = "package.json") {
  const metadata = requireObject(value, label);
  assert.equal(metadata.name, EXPECTED_NAME, `${label} must use the approved public npm scope`);
  assert.equal(metadata.version, EXPECTED_VERSION, `${label} must use the approved first-release version`);
  assert.notEqual(metadata.private, true, `${label} must not be private`);
  assert.equal(metadata.license, "MIT", `${label} must declare the MIT license`);
  assert.deepEqual(
    metadata.repository,
    { type: "git", url: REPOSITORY_URL },
    `${label} must identify the canonical GitHub repository`,
  );
  assert.deepEqual(metadata.bugs, { url: BUGS_URL }, `${label} must identify the canonical issue tracker`);
  assert.equal(requireObject(metadata.engines, `${label} engines`).node, ">=22", `${label} must retain the Node.js 22 floor`);
  const publishConfig = requireObject(metadata.publishConfig, `${label} publishConfig`);
  assert.equal(publishConfig.access, "public", `${label} must publish publicly`);
  assert.equal(publishConfig.registry, NPMJS_REGISTRY, `${label} must keep npmjs as the canonical registry`);
  return metadata;
}

export function expectedTarballFilename() {
  return "draftforge-dev-draftforge-0.1.0.tgz";
}

export function validateChecksumSidecar(contents, digest, tarballName) {
  assert.notEqual(contents, undefined, `Required checksum sidecar is missing: ${tarballName}.sha256`);
  assert.equal(contents, `${digest}  ${tarballName}\n`, `Checksum sidecar must contain exactly the candidate digest and tarball filename`);
}

export function validatePublicationConfiguration(value, label = "publication configuration") {
  const configuration = requireObject(value, label);
  assert.equal(
    configuration.npmTrustedPublisherConfigured,
    "true",
    `${label} must attest that the npm trusted publisher is configured; verify it in npm package settings, then set NPM_TRUSTED_PUBLISHER_CONFIGURED=true`,
  );
  assert.equal(
    configuration.npmTrustedPublisherRepository,
    TRUSTED_PUBLISHER_REPOSITORY,
    `${label} must bind the npm trusted publisher to ${TRUSTED_PUBLISHER_REPOSITORY}`,
  );
  assert.equal(
    configuration.npmTrustedPublisherWorkflow,
    TRUSTED_PUBLISHER_WORKFLOW,
    `${label} must bind the npm trusted publisher to ${TRUSTED_PUBLISHER_WORKFLOW}`,
  );
  assert.equal(
    configuration.npmTrustedPublisherEnvironment,
    TRUSTED_PUBLISHER_ENVIRONMENT,
    `${label} must bind the npm trusted publisher to the ${TRUSTED_PUBLISHER_ENVIRONMENT} environment`,
  );
  assert.equal(
    configuration.githubPackagesBootstrapVersion,
    "0.1.0-bootstrap.0",
    `${label} must name the approved prior GitHub Packages bootstrap version 0.1.0-bootstrap.0`,
  );
  return configuration;
}

export function validateNpmPublicationMetadata(value) {
  const metadata = requireObject(value, "npm publication metadata");
  assertNpmProvenance(metadata);
  return metadata;
}

export function validateNpmBootstrapMetadata(value, label = "npmjs bootstrap metadata") {
  const metadata = requireObject(value, label);
  assert.equal(metadata.name, EXPECTED_NAME, `${label} must use the approved public npm identity`);
  assert.equal(metadata.version, NPMJS_BOOTSTRAP_VERSION, `${label} must be ${NPMJS_BOOTSTRAP_VERSION}`);
  assert.notEqual(metadata.private, true, `${label} must be publicly readable`);
  const repository = typeof metadata.repository === "string"
    ? metadata.repository
    : requireObject(metadata.repository, `${label} repository`).url;
  assert.equal(repository, REPOSITORY_URL, `${label} must identify the canonical GitHub repository`);
  return metadata;
}

function parseArguments(arguments_) {
  let downloaded = false;
  let npmBootstrapMetadata;
  let npmMetadata;
  let publicationConfig = false;
  let requireChecksumSidecar = false;
  let sha256;
  let tarball;
  let tag;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--tag") {
      tag = arguments_[index + 1];
      if (tag === undefined) throw new Error("--tag requires a value");
      index += 1;
      continue;
    }
    if (argument === "--sha256") {
      sha256 = arguments_[index + 1];
      if (sha256 === undefined) throw new Error("--sha256 requires a value");
      index += 1;
      continue;
    }
    if (argument === "--downloaded") {
      downloaded = true;
      continue;
    }
    if (argument === "--publication-config") {
      publicationConfig = true;
      continue;
    }
    if (argument === "--npm-metadata") {
      npmMetadata = arguments_[index + 1];
      if (npmMetadata === undefined) throw new Error("--npm-metadata requires a value");
      index += 1;
      continue;
    }
    if (argument === "--npm-bootstrap-metadata") {
      npmBootstrapMetadata = arguments_[index + 1];
      if (npmBootstrapMetadata === undefined) throw new Error("--npm-bootstrap-metadata requires a value");
      index += 1;
      continue;
    }
    if (argument === "--require-checksum-sidecar") {
      requireChecksumSidecar = true;
      continue;
    }
    if (argument?.startsWith("--") === true || tarball !== undefined) {
      throw new Error("Usage: node scripts/release-check.mjs <tarball-path> [--tag v0.1.0] [--sha256 digest] [--downloaded] [--publication-config] [--npm-metadata path] [--npm-bootstrap-metadata path] [--require-checksum-sidecar]");
    }
    tarball = argument;
  }
  if (tarball === undefined) {
    throw new Error("Usage: node scripts/release-check.mjs <tarball-path> [--tag v0.1.0] [--sha256 digest] [--downloaded] [--publication-config] [--npm-metadata path] [--npm-bootstrap-metadata path] [--require-checksum-sidecar]");
  }
  return { downloaded, npmBootstrapMetadata, npmMetadata, publicationConfig, requireChecksumSidecar, sha256, tarball, tag };
}

function publicationConfigurationFromEnvironment() {
  return {
    npmTrustedPublisherConfigured: process.env.NPM_TRUSTED_PUBLISHER_CONFIGURED,
    npmTrustedPublisherRepository: process.env.NPM_TRUSTED_PUBLISHER_REPOSITORY,
    npmTrustedPublisherWorkflow: process.env.NPM_TRUSTED_PUBLISHER_WORKFLOW,
    npmTrustedPublisherEnvironment: process.env.NPM_TRUSTED_PUBLISHER_ENVIRONMENT,
    githubPackagesBootstrapVersion: process.env.GH_PACKAGES_BOOTSTRAP_VERSION,
  };
}

function readTarFile(buffer, wantedPath) {
  for (let offset = 0; offset + 512 <= buffer.length;) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const size = Number.parseInt(readTarString(header, 124, 12).trim() || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid tarball entry size.");
    const path = prefix.length > 0 ? `${prefix}/${name}` : name;
    const contentOffset = offset + 512;
    if (path === wantedPath && (header[156] === 0 || header[156] === 48)) {
      return buffer.subarray(contentOffset, contentOffset + size);
    }
    offset = contentOffset + Math.ceil(size / 512) * 512;
  }
  throw new Error(`Missing required package file: ${wantedPath}`);
}

function readTarString(buffer, start, length) {
  const possibleEnd = buffer.indexOf(0, start);
  const end = possibleEnd === -1 || possibleEnd > start + length ? start + length : possibleEnd;
  return buffer.subarray(start, end).toString("utf8");
}

async function recordChecksum(tarball, digest, requireExisting = false) {
  const checksumPath = `${tarball}.sha256`;
  const checksumLine = `${digest}  ${basename(tarball)}\n`;
  let current;
  try {
    current = await readFile(checksumPath, "utf8");
  } catch (error) {
    if (error === null || typeof error !== "object" || error.code !== "ENOENT") throw error;
  }
  if (current === undefined && requireExisting) {
    validateChecksumSidecar(current, digest, basename(tarball));
  }
  if (current === undefined) await writeFile(checksumPath, checksumLine, "utf8");
  else validateChecksumSidecar(current, digest, basename(tarball));
  return checksumPath;
}

async function writeGitHubOutputs(outputs) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath === undefined || outputPath.length === 0) return;
  const body = Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join("");
  await appendFile(outputPath, body, "utf8");
}

export async function verifyReleaseArtifact(tarballArgument, options = {}) {
  const tarball = resolve(tarballArgument);
  assert.equal(basename(tarball), expectedTarballFilename(), "Unexpected release tarball filename");

  const sourceMetadata = validatePackageMetadata(
    JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8")),
  );
  if (options.tag !== undefined) {
    assert.equal(options.tag, `v${sourceMetadata.version}`, "Release tag must exactly match package.json version");
  }

  const compressed = await readFile(tarball);
  if (options.downloaded !== true) {
    auditTarball(compressed, tarball, await expectedTarballEntries(repositoryRoot));
  }
  const archive = gunzipSync(compressed);
  const packedMetadata = validatePackageMetadata(
    JSON.parse(readTarFile(archive, "package/package.json").toString("utf8")),
    "packed package.json",
  );
  assert.equal(packedMetadata.name, sourceMetadata.name, "Packed package name does not match source metadata");
  assert.equal(packedMetadata.version, sourceMetadata.version, "Packed package version does not match source metadata");

  const digest = createHash("sha256").update(compressed).digest("hex");
  if (options.sha256 !== undefined) {
    assert.match(options.sha256, /^[a-f0-9]{64}$/u, "Expected SHA-256 must be lowercase hexadecimal");
    assert.equal(digest, options.sha256, "Tarball digest does not match the producing job");
  }
  await recordChecksum(tarball, digest, options.requireChecksumSidecar === true);
  const relativeTarball = relative(repositoryRoot, tarball).replaceAll("\\", "/");
  assert.ok(relativeTarball.length > 0 && !relativeTarball.startsWith("../"), "Tarball must be inside the repository workspace");
  const outputs = {
    artifact_name: `draftforge-npm-${digest}`,
    tarball: relativeTarball,
    sha256: digest,
  };
  await writeGitHubOutputs(outputs);
  return outputs;
}

async function main() {
  const {
    downloaded,
    npmBootstrapMetadata,
    npmMetadata,
    publicationConfig,
    requireChecksumSidecar,
    sha256,
    tarball,
    tag,
  } = parseArguments(process.argv.slice(2));
  if (publicationConfig) validatePublicationConfiguration(publicationConfigurationFromEnvironment());
  if (npmBootstrapMetadata !== undefined) {
    validateNpmBootstrapMetadata(JSON.parse(await readFile(resolve(npmBootstrapMetadata), "utf8")));
  }
  if (npmMetadata !== undefined) {
    validateNpmPublicationMetadata(JSON.parse(await readFile(resolve(npmMetadata), "utf8")));
  }
  const options = { downloaded, requireChecksumSidecar };
  if (tag !== undefined) options.tag = tag;
  if (sha256 !== undefined) options.sha256 = sha256;
  const outputs = await verifyReleaseArtifact(tarball, options);
  process.stdout.write(`${outputs.tarball} sha256:${outputs.sha256}\n`);
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}

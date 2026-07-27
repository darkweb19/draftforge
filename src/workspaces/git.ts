import { access, lstat, readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type {
  CreateOrRecoverWorkspaceOptions,
  ProcessLiveness,
  WorkspaceAttempt,
  WorkspaceCleanupResult,
  WorkspaceInspection,
  WorkspaceLocation,
  WorkspacePort,
  WorkspaceProcess,
} from "../application/workspace.js";
import {
  createGitProcessTransport,
  type GitProcessResult,
  type GitProcessTransport,
} from "./process.js";

const ATTEMPT_CONFIG_KEY = "draftforge.attempt-id";
const BASE_COMMIT_CONFIG_KEY = "draftforge.base-commit";
const ALLOWED_UNTRACKED_ROOTS = ["node_modules", "dist", "coverage"] as const;
const UNTRACKED_PATHSPECS = [
  ".",
  ...ALLOWED_UNTRACKED_ROOTS.flatMap((root) => [
    `:(exclude)${root}`,
    `:(exclude)${root}/**`,
  ]),
] as const;
const UNSAFE_INSPECTION_CONFIG_KEYS: ReadonlyMap<string, string> = new Map([
  ["core.fsmonitor", "core.fsmonitor"],
  ["core.hookspath", "core.hooksPath"],
  ["core.excludesfile", "core.excludesFile"],
] as const);
const REPOSITORY_NORMALIZATION_CONFIG_KEYS: ReadonlyMap<string, string> = new Map([
  ["core.autocrlf", "core.autocrlf"],
  ["core.eol", "core.eol"],
  ["core.safecrlf", "core.safecrlf"],
] as const);

export class WorkspaceError extends Error {
  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options);
    this.name = "WorkspaceError";
  }
}

export class WorkspaceInUseError extends WorkspaceError {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceInUseError";
  }
}

export interface GitWorkspaceOptions {
  readonly projectRoot: string;
  readonly transport?: GitProcessTransport;
}

/**
 * Local Git implementation of the workspace port. It never invokes a shell,
 * never talks to a network remote, and retains any workspace whose safety is
 * not proven.
 */
export class GitWorkspace implements WorkspacePort {
  readonly #projectRoot: string;
  readonly #transport: GitProcessTransport;

  constructor(options: GitWorkspaceOptions) {
    this.#projectRoot = resolve(options.projectRoot);
    this.#transport = options.transport ?? createGitProcessTransport();
  }

  async createOrRecover(
    attempt: WorkspaceAttempt,
    options: CreateOrRecoverWorkspaceOptions = {},
  ): Promise<WorkspaceLocation> {
    const identity = workspaceIdentity(this.#projectRoot, attempt);
    await this.assertProjectRepository();
    // The workspace path may be missing after an interrupted setup, but a
    // known worker process can still be about to create or edit it. Gate both
    // recovery and fresh creation on definitive process absence.
    await this.assertReusableProcess(options);
    const existing = await this.inspect(attempt);
    if (existing.state === "ready") {
      return existing.location as WorkspaceLocation;
    }
    if (existing.state === "unsafe") {
      throw new WorkspaceError(existing.reason ?? `Workspace at ${identity.path} is unsafe to reuse.`);
    }

    const branchExists = await this.branchExists(identity.branch);
    if (branchExists) {
      throw new WorkspaceError(
        `Workspace branch "${identity.branch}" exists but ${identity.path} is missing; preserving the ambiguous attempt.`,
      );
    }
    const location: WorkspaceLocation = {
      ...identity,
      baseCommit: await this.#projectBaseCommit(),
    };
    // This setting lives in the primary repository config. It must exist
    // before the worktree is created so a crash between add and metadata
    // writes is still recoverable through an empty worktree-local config.
    await this.runGit(this.#projectRoot, ["config", "extensions.worktreeConfig", "true"]);
    await this.runGit(this.#projectRoot, ["worktree", "add", "-b", location.branch, location.path, location.baseCommit]);
    try {
      await this.writeWorkspaceMetadata(location);
      return location;
    } catch (error: unknown) {
      throw new WorkspaceError(
        `Created workspace at ${identity.path} but could not record its identity; it was preserved for inspection.`,
        { cause: error },
      );
    }
  }

  async inspect(
    attempt: WorkspaceAttempt,
    expectedBaseCommit?: string,
  ): Promise<WorkspaceInspection> {
    const identity = workspaceIdentity(this.#projectRoot, attempt);
    if (!(await pathExists(identity.path))) {
      return { state: "missing", location: undefined, dirty: false, changedPaths: [], reason: undefined };
    }
    if (!(await isDirectory(identity.path))) {
      return unsafeInspection(`Workspace path ${identity.path} exists but is not a directory.`);
    }

    try {
      await this.assertWorkspaceTopLevel(identity.path);
      if (!(await this.belongsToProjectRepository(identity.path))) {
        return unsafeInspection(
          `Workspace at ${identity.path} belongs to a different Git repository and was preserved.`,
        );
      }
      const branch = (await this.runGit(identity.path, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
      if (branch !== identity.branch) {
        return unsafeInspection(`Workspace at ${identity.path} is on branch "${branch || "detached"}", not "${identity.branch}".`);
      }
      const configuredAttempt = await this.getConfig(identity.path, ATTEMPT_CONFIG_KEY);
      if (configuredAttempt !== undefined && configuredAttempt !== attempt.attemptId) {
        return unsafeInspection(`Workspace at ${identity.path} belongs to attempt "${configuredAttempt}".`);
      }
      await this.assertInspectionControlsSafe(identity.path);
      const configuredBase = await this.getConfig(identity.path, BASE_COMMIT_CONFIG_KEY);
      const baseCommit = await this.forkBase(identity.path);
      if (configuredBase !== undefined && configuredBase !== baseCommit) {
        return unsafeInspection(
          `Workspace at ${identity.path} base metadata disagrees with its Git fork point.`,
        );
      }
      if (expectedBaseCommit !== undefined && expectedBaseCommit !== baseCommit) {
        return unsafeInspection(
          `Workspace at ${identity.path} fork point does not match the scheduler-owned attempt base.`,
        );
      }
      const location: WorkspaceLocation = { ...identity, baseCommit };
      const changedPaths = await this.changedPathsFor(location);
      const dirty = await this.isDirty(identity.path) || changedPaths.length > 0;
      return { state: "ready", location, dirty, changedPaths, reason: undefined };
    } catch (error: unknown) {
      return unsafeInspection(`Workspace at ${identity.path} cannot be inspected safely: ${messageOf(error)}`);
    }
  }

  async changedPaths(
    attempt: WorkspaceAttempt,
    expectedBaseCommit?: string,
  ): Promise<readonly string[]> {
    const inspection = await this.inspect(attempt, expectedBaseCommit);
    if (inspection.state !== "ready" || inspection.location === undefined) {
      throw new WorkspaceError(inspection.reason ?? `Workspace for ${attempt.taskId} does not exist.`);
    }
    return inspection.changedPaths;
  }

  async processLiveness(process: WorkspaceProcess): Promise<ProcessLiveness> {
    return this.#transport.liveness(process.processId);
  }

  async cleanup(
    attempt: WorkspaceAttempt,
    options: CreateOrRecoverWorkspaceOptions = {},
  ): Promise<WorkspaceCleanupResult> {
    const inspection = await this.inspect(attempt);
    if (inspection.state === "missing") {
      return { outcome: "removed" };
    }
    if (inspection.state === "unsafe" || inspection.location === undefined) {
      return { outcome: "preserved", reason: inspection.reason ?? "Workspace could not be inspected safely." };
    }
    const liveness = await this.reusableProcessLiveness(options);
    if (liveness !== "not-found") {
      return { outcome: "preserved", reason: `Associated process is ${liveness}; workspace was retained.` };
    }
    if (inspection.dirty || inspection.changedPaths.length > 0) {
      return { outcome: "preserved", reason: "Workspace contains uncommitted, committed, or untracked changes." };
    }
    try {
      await this.runGit(this.#projectRoot, ["worktree", "remove", inspection.location.path]);
    } catch (error: unknown) {
      return { outcome: "preserved", reason: `Git refused workspace cleanup: ${messageOf(error)}` };
    }
    return { outcome: "removed" };
  }

  async #projectBaseCommit(): Promise<string> {
    return this.#headCommit(this.#projectRoot);
  }

  async forkBase(workspacePath: string): Promise<string> {
    const projectHead = await this.#projectBaseCommit();
    const result = await this.runGit(workspacePath, ["merge-base", "HEAD", projectHead]);
    const commit = result.stdout.trim();
    if (!isCommitHash(commit)) {
      throw new WorkspaceError("Git did not return a valid workspace fork point.");
    }
    return commit;
  }

  async #headCommit(cwd: string): Promise<string> {
    const output = await this.runGit(cwd, ["rev-parse", "HEAD"]);
    const commit = output.stdout.trim();
    if (!isCommitHash(commit)) {
      throw new WorkspaceError("Git did not return a valid base commit.");
    }
    return commit;
  }

  async assertProjectRepository(): Promise<void> {
    const result = await this.runGit(this.#projectRoot, ["rev-parse", "--show-toplevel"]);
    if ((await realpath(result.stdout.trim())) !== (await realpath(this.#projectRoot))) {
      throw new WorkspaceError("The workspace root must be the top level of a Git repository.");
    }
  }

  async assertWorkspaceTopLevel(workspacePath: string): Promise<void> {
    const result = await this.runGit(workspacePath, ["rev-parse", "--show-toplevel"]);
    if ((await realpath(result.stdout.trim())) !== (await realpath(workspacePath))) {
      throw new WorkspaceError(
        `Git worktree top level does not match the deterministic workspace path ${workspacePath}.`,
      );
    }
  }

  async belongsToProjectRepository(workspacePath: string): Promise<boolean> {
    const [projectCommonDirectory, workspaceCommonDirectory] = await Promise.all([
      this.gitCommonDirectory(this.#projectRoot),
      this.gitCommonDirectory(workspacePath),
    ]);
    return projectCommonDirectory === workspaceCommonDirectory;
  }

  async gitCommonDirectory(cwd: string): Promise<string> {
    const result = await this.runGit(cwd, ["rev-parse", "--git-common-dir"]);
    return realpath(resolve(cwd, result.stdout.trim()));
  }

  async assertReusableProcess(options: CreateOrRecoverWorkspaceOptions): Promise<void> {
    const liveness = await this.reusableProcessLiveness(options);
    if (liveness !== "not-found") {
      throw new WorkspaceInUseError(`Workspace is associated with a ${liveness} process and cannot be reused.`);
    }
  }

  async reusableProcessLiveness(options: CreateOrRecoverWorkspaceOptions): Promise<ProcessLiveness> {
    if (options.activeProcess === undefined) {
      return "not-found";
    }
    return this.processLiveness(options.activeProcess);
  }

  async writeWorkspaceMetadata(location: WorkspaceLocation): Promise<void> {
    await this.runGit(location.path, ["config", "--worktree", ATTEMPT_CONFIG_KEY, location.attempt.attemptId]);
    await this.runGit(location.path, ["config", "--worktree", BASE_COMMIT_CONFIG_KEY, location.baseCommit]);
  }

  async getConfig(cwd: string, key: string): Promise<string | undefined> {
    const result = await this.#transport.run({ command: "git", args: ["config", "--worktree", "--get", key], cwd });
    if (result.exitCode === 1) {
      return undefined;
    }
    this.assertGitSuccess(result, ["config", "--worktree", "--get", key]);
    const value = result.stdout.trim();
    return value.length === 0 ? undefined : value;
  }

  async isDirty(cwd: string): Promise<boolean> {
    const result = await this.runTrustedInspectionGit(cwd, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ]);
    return result.stdout.length > 0;
  }

  async changedPathsFor(location: WorkspaceLocation): Promise<readonly string[]> {
    const diff = await this.runTrustedInspectionGit(location.path, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--name-status",
      "-z",
      "--find-renames",
      "--ignore-submodules=none",
      location.baseCommit,
      "--",
    ]);
    const visibleUntracked = await this.runTrustedInspectionGit(location.path, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ...UNTRACKED_PATHSPECS,
    ]);
    const ignoredUntracked = await this.runTrustedInspectionGit(location.path, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
      "--",
      ...UNTRACKED_PATHSPECS,
    ]);
    // This exclusion-independent view is deliberately directory summarized:
    // it proves that mutable ignore rules did not make an untracked region
    // disappear without recursively walking fixed allowed output roots.
    const allUntracked = await this.runTrustedInspectionGit(location.path, [
      "ls-files",
      "--others",
      "--directory",
      "--no-empty-directory",
      "-z",
      "--",
      ...UNTRACKED_PATHSPECS,
    ]);
    const untracked = mergeAuthoritativeUntrackedPaths(
      parseNullDelimitedPaths(visibleUntracked.stdout),
      parseNullDelimitedPaths(ignoredUntracked.stdout),
      parseNullDelimitedPaths(allUntracked.stdout),
    );
    const fixedOutputChanges = await this.changedFixedOutputRoots(location.path);
    const ignoredControls = await this.ignoredControlPaths(location.path);
    return [...new Set([
      ...parseNameStatus(diff.stdout),
      ...untracked,
      ...fixedOutputChanges,
      ...ignoredControls,
    ])]
      .map(normalizeRepositoryPath)
      .sort((left, right) => left.localeCompare(right, "en"));
  }

  async changedFixedOutputRoots(workspacePath: string): Promise<readonly string[]> {
    const changed: string[] = [];
    for (const root of ALLOWED_UNTRACKED_ROOTS) {
      const ignored = await this.#transport.run({
        command: "git",
        args: trustedInspectionArguments([
          "check-ignore",
          "--quiet",
          "--no-index",
          "--",
          root,
        ]),
        cwd: workspacePath,
      });
      if (ignored.exitCode === 0 && await isDirectory(resolve(workspacePath, root))) {
        continue;
      }
      if (ignored.exitCode !== 0 && ignored.exitCode !== 1) {
        this.assertGitSuccess(ignored, ["check-ignore", "--quiet", "--no-index", "--", root]);
      }
      const untracked = await this.runTrustedInspectionGit(workspacePath, [
        "ls-files",
        "--others",
        "--directory",
        "--no-empty-directory",
        "-z",
        "--",
        root,
      ]);
      if (parseNullDelimitedPaths(untracked.stdout).length > 0) {
        // The fixed root is not actually ignored, so it is authoritative. A
        // root summary avoids expanding a potentially large generated tree.
        changed.push(root);
      }
    }
    return changed;
  }

  async assertInspectionControlsSafe(workspacePath: string): Promise<void> {
    await this.assertInspectionConfigSafe(workspacePath);
    await this.assertIndexFlagsSafe(workspacePath);
    await this.assertExcludesSafe(workspacePath);
    await this.assertHistoryOverridesSafe(workspacePath);
  }

  async assertInspectionConfigSafe(workspacePath: string): Promise<void> {
    const configured = await this.runGit(workspacePath, [
      "config",
      "--null",
      "--name-only",
      "--list",
    ]);
    const keys = parseConfigKeys(configured.stdout);
    const normalized = keys.map((key) => key.toLowerCase());
    if (normalized.some((key) => /^filter\..*\.(?:clean|process)$/u.test(key))) {
      throw new WorkspaceError(
        "Git clean/process content filters are configured for the workspace.",
      );
    }
    const unsafeKey = normalized.find((key) => UNSAFE_INSPECTION_CONFIG_KEYS.has(key));
    if (unsafeKey !== undefined) {
      throw new WorkspaceError(
        `Git inspection configuration ${JSON.stringify(UNSAFE_INSPECTION_CONFIG_KEYS.get(unsafeKey))} is unsafe for the workspace.`,
      );
    }
    for (const scope of ["--local", "--worktree"] as const) {
      const scoped = await this.runGit(workspacePath, [
        "config",
        scope,
        "--null",
        "--name-only",
        "--list",
      ]);
      const normalizationKey = parseConfigKeys(scoped.stdout)
        .map((key) => key.toLowerCase())
        .find((key) => REPOSITORY_NORMALIZATION_CONFIG_KEYS.has(key));
      if (normalizationKey !== undefined) {
        throw new WorkspaceError(
          `Git repository normalization ${JSON.stringify(REPOSITORY_NORMALIZATION_CONFIG_KEYS.get(normalizationKey))} is unsafe for worker inspection.`,
        );
      }
    }
  }

  async assertIndexFlagsSafe(workspacePath: string): Promise<void> {
    const assumeUnchanged = parseTaggedPaths(
      (await this.runTrustedInspectionGit(workspacePath, ["ls-files", "-v", "-z"])).stdout,
    );
    for (const entry of assumeUnchanged) {
      if (entry.tag.toUpperCase() === "S") {
        throw new WorkspaceError(
          `Git index path ${JSON.stringify(entry.path)} is marked skip-worktree.`,
        );
      }
      if (entry.tag !== entry.tag.toUpperCase()) {
        throw new WorkspaceError(
          `Git index path ${JSON.stringify(entry.path)} is marked assume-unchanged.`,
        );
      }
    }

    const fsmonitor = parseTaggedPaths(
      (await this.runTrustedInspectionGit(workspacePath, ["ls-files", "-f", "-z"])).stdout,
    );
    for (const entry of fsmonitor) {
      if (entry.tag !== entry.tag.toUpperCase()) {
        throw new WorkspaceError(
          `Git index path ${JSON.stringify(entry.path)} is marked fsmonitor-valid.`,
        );
      }
    }
    const staged = await this.runTrustedInspectionGit(workspacePath, [
      "ls-files",
      "--stage",
      "-z",
    ]);
    const gitlink = parseIndexStageEntries(staged.stdout).find(
      (entry) => entry.mode === "160000",
    );
    if (gitlink !== undefined) {
      throw new WorkspaceError(
        `Git submodule path ${JSON.stringify(gitlink.path)} is unsupported for worker inspection.`,
      );
    }
  }

  async assertExcludesSafe(workspacePath: string): Promise<void> {
    const excludePathResult = await this.runGit(workspacePath, [
      "rev-parse",
      "--git-path",
      "info/exclude",
    ]);
    const excludePath = resolve(workspacePath, excludePathResult.stdout.trim());
    const contents = await readOptionalFile(excludePath);
    if (contents !== undefined && hasActiveControlLine(contents)) {
      throw new WorkspaceError("Git common info/exclude contains active exclusion patterns.");
    }
  }

  async assertHistoryOverridesSafe(workspacePath: string): Promise<void> {
    const replacements = await this.runGit(workspacePath, ["replace", "--list"]);
    if (parseLineDelimitedValues(replacements.stdout).length > 0) {
      throw new WorkspaceError("Git replacement refs are active for the workspace.");
    }

    const graftsPathResult = await this.runGit(workspacePath, [
      "rev-parse",
      "--git-path",
      "info/grafts",
    ]);
    const graftsPath = resolve(workspacePath, graftsPathResult.stdout.trim());
    const contents = await readOptionalFile(graftsPath);
    if (contents !== undefined && hasActiveControlLine(contents)) {
      throw new WorkspaceError("Git common info/grafts contains active history overrides.");
    }
  }

  async ignoredControlPaths(workspacePath: string): Promise<readonly string[]> {
    const controls: string[] = [];
    if (await pathExists(resolve(workspacePath, ".draftforge", "runs"))) {
      controls.push(".draftforge/runs");
    }
    if (await pathExists(resolve(workspacePath, ".draftforge", "config.local.json"))) {
      controls.push(".draftforge/config.local.json");
    }
    return controls;
  }

  async branchExists(branch: string): Promise<boolean> {
    const result = await this.#transport.run({
      command: "git",
      args: ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      cwd: this.#projectRoot,
    });
    if (result.exitCode === 0) {
      return true;
    }
    if (result.exitCode === 1) {
      return false;
    }
    this.assertGitSuccess(result, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return false;
  }

  async runGit(cwd: string, args: readonly string[]): Promise<GitProcessResult> {
    const result = await this.#transport.run({ command: "git", args, cwd });
    this.assertGitSuccess(result, args);
    return result;
  }

  async runTrustedInspectionGit(
    cwd: string,
    args: readonly string[],
  ): Promise<GitProcessResult> {
    const result = await this.#transport.run({
      command: "git",
      args: trustedInspectionArguments(args),
      cwd,
    });
    this.assertGitSuccess(result, args);
    return result;
  }

  assertGitSuccess(result: GitProcessResult, args: readonly string[]): void {
    if (result.exitCode === 0) {
      return;
    }
    const detail = result.stderr.trim() || result.stdout.trim() || "no diagnostic";
    throw new WorkspaceError(`Git ${args[0] ?? "command"} failed (${result.exitCode ?? "signal"}): ${detail}`);
  }
}

export function workspacePath(projectRoot: string, attempt: WorkspaceAttempt): string {
  return workspaceIdentity(resolve(projectRoot), attempt).path;
}

export function workspaceBranch(attempt: WorkspaceAttempt): string {
  assertAttempt(attempt);
  return `draftforge/${attempt.runId}/${attempt.taskId}/${attempt.attemptId}`;
}

export function trustedInspectionArguments(
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  const nullDevice = platform === "win32" ? "NUL" : "/dev/null";
  return [
    "-c",
    "core.fsmonitor=false",
    "-c",
    `core.hooksPath=${nullDevice}`,
    "-c",
    "core.fileMode=true",
    "-c",
    "core.trustctime=true",
    "-c",
    "core.checkStat=default",
    "-c",
    "core.ignoreStat=false",
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.eol=lf",
    "-c",
    "core.safecrlf=true",
    ...args,
  ];
}

function workspaceIdentity(projectRoot: string, attempt: WorkspaceAttempt): WorkspaceLocation {
  assertAttempt(attempt);
  const path = resolve(projectRoot, ".draftforge", "runs", attempt.runId, "worktrees", attempt.taskId);
  assertWithinRoot(projectRoot, path);
  // The base changes only on first creation. Recovering workspaces read it from
  // worktree config, but this value lets interrupted setup be discovered safely.
  return {
    attempt,
    path,
    branch: workspaceBranch(attempt),
    baseCommit: "",
  };
}

function assertAttempt(attempt: WorkspaceAttempt): void {
  for (const [label, value] of Object.entries(attempt)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
      throw new WorkspaceError(`${label} must be a safe stable identifier.`);
    }
  }
}

function assertWithinRoot(root: string, candidate: string): void {
  const pathRelative = relative(root, candidate);
  if (pathRelative === "" || pathRelative === ".." || pathRelative.startsWith(`..${sep}`)) {
    throw new WorkspaceError("Workspace path escaped the repository root.");
  }
}

function unsafeInspection(reason: string): WorkspaceInspection {
  return { state: "unsafe", location: undefined, dirty: false, changedPaths: [], reason };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

function isCommitHash(value: string): boolean {
  return /^[0-9a-f]{40,64}$/iu.test(value);
}

function parseNameStatus(output: string): readonly string[] {
  const fields = output.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < fields.length - 1; ) {
    const status = fields[index];
    if (status === undefined || status.length === 0) {
      break;
    }
    const kind = status[0];
    const first = fields[index + 1];
    if (first === undefined) {
      throw new WorkspaceError("Git returned an incomplete changed-path record.");
    }
    paths.push(first);
    index += 2;
    if (kind === "R" || kind === "C") {
      const second = fields[index];
      if (second === undefined) {
        throw new WorkspaceError("Git returned an incomplete rename record.");
      }
      paths.push(second);
      index += 1;
    }
  }
  return paths;
}

function parseNullDelimitedPaths(output: string): readonly string[] {
  if (output.length === 0) {
    return [];
  }
  if (!output.endsWith("\0")) {
    throw new WorkspaceError("Git returned an incomplete null-delimited path record.");
  }
  return output.slice(0, -1).split("\0");
}

function parseTaggedPaths(output: string): readonly {
  readonly tag: string;
  readonly path: string;
}[] {
  return parseNullDelimitedPaths(output).map((record) => {
    if (record.length < 3 || record[1] !== " ") {
      throw new WorkspaceError("Git returned an incomplete index-flag record.");
    }
    return {
      tag: record[0] as string,
      path: normalizeRepositoryPath(record.slice(2)),
    };
  });
}

function parseIndexStageEntries(output: string): readonly {
  readonly mode: string;
  readonly path: string;
}[] {
  return parseNullDelimitedPaths(output).map((record) => {
    const separator = record.indexOf("\t");
    if (separator <= 0) {
      throw new WorkspaceError("Git returned an incomplete index-stage record.");
    }
    const metadata = record.slice(0, separator).split(" ");
    const mode = metadata[0];
    const objectId = metadata[1];
    const stage = metadata[2];
    if (
      metadata.length !== 3 ||
      mode === undefined ||
      !/^[0-7]{6}$/u.test(mode) ||
      objectId === undefined ||
      !isCommitHash(objectId) ||
      stage === undefined ||
      !/^[0-3]$/u.test(stage)
    ) {
      throw new WorkspaceError("Git returned malformed index-stage metadata.");
    }
    return {
      mode,
      path: normalizeRepositoryPath(record.slice(separator + 1)),
    };
  });
}

function mergeAuthoritativeUntrackedPaths(
  visibleRecords: readonly string[],
  ignoredRecords: readonly string[],
  allRecords: readonly string[],
): readonly string[] {
  const authoritative = [...new Set(
    [...visibleRecords, ...ignoredRecords]
      .map(normalizeUntrackedRecord)
      .filter((path) => !isAllowedUntrackedOutput(path)),
  )];
  for (const record of allRecords) {
    const directory = record.endsWith("/");
    const path = normalizeUntrackedRecord(record);
    if (isAllowedUntrackedOutput(path) || rawUntrackedRecordIsCovered(path, directory, authoritative)) {
      continue;
    }
    // A summarized path not explained by either the exact visible view or the
    // ignored view is retained conservatively instead of trusted away.
    authoritative.push(path);
  }
  return authoritative;
}

function normalizeUntrackedRecord(record: string): string {
  return normalizeRepositoryPath(record.endsWith("/") ? record.slice(0, -1) : record);
}

function rawUntrackedRecordIsCovered(
  rawPath: string,
  directory: boolean,
  authoritative: readonly string[],
): boolean {
  return directory
    ? authoritative.some((path) => path === rawPath || path.startsWith(`${rawPath}/`))
    : authoritative.includes(rawPath);
}

function isAllowedUntrackedOutput(path: string): boolean {
  return ALLOWED_UNTRACKED_ROOTS.some(
    (root) => path === root || path.startsWith(`${root}/`),
  );
}

function hasActiveControlLine(contents: string): boolean {
  return contents
    .split(/\r?\n/u)
    .some((line) => line.trim().length > 0 && !line.startsWith("#"));
}

function parseLineDelimitedValues(output: string): readonly string[] {
  return output
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function parseConfigKeys(output: string): readonly string[] {
  const keys = parseNullDelimitedPaths(output);
  if (
    keys.some((key) =>
      key.length === 0 ||
      key.includes("\r") ||
      key.includes("\n"))
  ) {
    throw new WorkspaceError("Git returned a malformed configuration key list.");
  }
  return keys;
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

export function normalizeRepositoryPath(value: string): string {
  if (
    value.length === 0 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:\//u.test(value) ||
    value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new WorkspaceError(`Git returned an unsafe repository-relative path: ${JSON.stringify(value)}`);
  }
  return value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

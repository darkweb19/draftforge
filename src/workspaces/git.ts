import { access, lstat, realpath } from "node:fs/promises";
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

  async inspect(attempt: WorkspaceAttempt): Promise<WorkspaceInspection> {
    const identity = workspaceIdentity(this.#projectRoot, attempt);
    if (!(await pathExists(identity.path))) {
      return { state: "missing", location: undefined, dirty: false, changedPaths: [], reason: undefined };
    }
    if (!(await isDirectory(identity.path))) {
      return unsafeInspection(`Workspace path ${identity.path} exists but is not a directory.`);
    }

    try {
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
      const configuredBase = await this.getConfig(identity.path, BASE_COMMIT_CONFIG_KEY);
      const baseCommit = configuredBase ?? (await this.#headCommit(identity.path));
      if (!isCommitHash(baseCommit)) {
        return unsafeInspection(`Workspace at ${identity.path} has invalid base commit metadata.`);
      }
      const dirty = await this.isDirty(identity.path);
      const location: WorkspaceLocation = { ...identity, baseCommit };
      const changedPaths = await this.changedPathsFor(location);
      return { state: "ready", location, dirty, changedPaths, reason: undefined };
    } catch (error: unknown) {
      return unsafeInspection(`Workspace at ${identity.path} cannot be inspected safely: ${messageOf(error)}`);
    }
  }

  async changedPaths(attempt: WorkspaceAttempt): Promise<readonly string[]> {
    const inspection = await this.inspect(attempt);
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
    const result = await this.runGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    return result.stdout.length > 0;
  }

  async changedPathsFor(location: WorkspaceLocation): Promise<readonly string[]> {
    const diff = await this.runGit(location.path, [
      "diff",
      "--name-status",
      "-z",
      "--find-renames",
      location.baseCommit,
      "--",
    ]);
    const untracked = await this.runGit(location.path, ["ls-files", "--others", "--exclude-standard", "-z"]);
    return [...new Set([...parseNameStatus(diff.stdout), ...parseNullDelimitedPaths(untracked.stdout)])]
      .map(normalizeRepositoryPath)
      .sort((left, right) => left.localeCompare(right, "en"));
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
  return output.length === 0 ? [] : output.slice(0, -1).split("\0");
}

export function normalizeRepositoryPath(value: string): string {
  const normalized = value.replace(/\\/gu, "/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new WorkspaceError(`Git returned an unsafe repository-relative path: ${JSON.stringify(value)}`);
  }
  return normalized;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

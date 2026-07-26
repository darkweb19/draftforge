import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test, type TestContext } from "node:test";
import type { WorkspaceAttempt } from "../../src/application/workspace.js";
import {
  GitWorkspace,
  WorkspaceError,
  WorkspaceInUseError,
  normalizeRepositoryPath,
  workspaceBranch,
  workspacePath,
} from "../../src/workspaces/git.js";
import {
  createGitProcessTransport,
  type GitProcessTransport,
} from "../../src/workspaces/process.js";

const ATTEMPT: WorkspaceAttempt = {
  runId: "run-001",
  taskId: "P04-T02",
  attemptId: "attempt-001",
};

test("the Git process boundary uses argument arrays, a working directory, and no shell on Windows paths", async () => {
  const child = fakeChild();
  let invocation:
    | {
        readonly command: string;
        readonly args: readonly string[];
        readonly cwd: string | URL | undefined;
        readonly shell: boolean | string | undefined;
        readonly windowsVerbatimArguments: boolean | undefined;
      }
    | undefined;
  const transport = createGitProcessTransport({
    spawn(command, args, options) {
      invocation = {
        command,
        args,
        cwd: options.cwd,
        shell: options.shell,
        windowsVerbatimArguments: options.windowsVerbatimArguments,
      };
      queueMicrotask(() => {
        (child.stdout as PassThrough).end("ok");
        (child.stderr as PassThrough).end();
        child.emit("close", 0, null);
      });
      return child;
    },
  });

  const result = await transport.run({
    command: "git",
    args: ["-C", "C:\\Users\\Sujan Space\\project", "status", "--porcelain=v1"],
    cwd: "C:\\Users\\Sujan Space\\project",
  });

  assert.deepEqual(invocation, {
    command: "git",
    args: ["-C", "C:\\Users\\Sujan Space\\project", "status", "--porcelain=v1"],
    cwd: "C:\\Users\\Sujan Space\\project",
    shell: false,
    windowsVerbatimArguments: false,
  });
  assert.equal(result.definitelyTerminated, true);
});

test("create-or-recover is deterministic, idempotent, and discovers setup interrupted before metadata writes", async (t) => {
  const repository = await createRepository(t);
  const workspace = new GitWorkspace({ projectRoot: repository });

  const first = await workspace.createOrRecover(ATTEMPT);
  const second = await workspace.createOrRecover(ATTEMPT);

  assert.equal(first.path, workspacePath(repository, ATTEMPT));
  assert.equal(first.branch, workspaceBranch(ATTEMPT));
  assert.match(first.baseCommit, /^[0-9a-f]{40}$/u);
  assert.deepEqual(second, first);
  assert.equal(git(repository, ["worktree", "list", "--porcelain"]).includes(first.path), true);
  assert.equal(git(first.path, ["config", "--worktree", "--get", "draftforge.attempt-id"]).trim(), ATTEMPT.attemptId);

  git(first.path, ["config", "--worktree", "--unset-all", "draftforge.attempt-id"]);
  git(first.path, ["config", "--worktree", "--unset-all", "draftforge.base-commit"]);
  const recovered = await workspace.createOrRecover(ATTEMPT);
  assert.equal(recovered.path, first.path);
  assert.equal(recovered.branch, first.branch);
  assert.equal(recovered.baseCommit, first.baseCommit);
});

test("a deterministic path on another attempt's Git branch is never reused", async (t) => {
  const repository = await createRepository(t);
  const workspace = new GitWorkspace({ projectRoot: repository });
  await workspace.createOrRecover(ATTEMPT);

  const otherAttempt = { ...ATTEMPT, attemptId: "attempt-002" };
  const inspection = await workspace.inspect(otherAttempt);
  assert.equal(inspection.state, "unsafe");
  await assert.rejects(workspace.createOrRecover(otherAttempt), WorkspaceError);
});

test("a nested foreign Git repository at the deterministic path is rejected and preserved", async (t) => {
  const repository = await createRepository(t);
  const workspace = new GitWorkspace({ projectRoot: repository });
  const foreignPath = workspacePath(repository, ATTEMPT);
  await mkdir(foreignPath, { recursive: true });
  git(foreignPath, ["init", "--initial-branch=main"]);
  git(foreignPath, ["config", "user.name", "Foreign Test"]);
  git(foreignPath, ["config", "user.email", "foreign-test@example.invalid"]);
  await writeFile(join(foreignPath, "foreign.txt"), "foreign\n", "utf8");
  git(foreignPath, ["add", "."]);
  git(foreignPath, ["commit", "-m", "foreign initial"]);
  git(foreignPath, ["checkout", "-b", workspaceBranch(ATTEMPT)]);

  const inspection = await workspace.inspect(ATTEMPT);
  assert.equal(inspection.state, "unsafe");
  assert.match(inspection.reason ?? "", /different Git repository/u);
  await assert.rejects(workspace.createOrRecover(ATTEMPT), WorkspaceError);
  assert.equal(git(foreignPath, ["rev-parse", "--is-inside-work-tree"]).trim(), "true");
});

test("changed paths are Git-derived and include staged, unstaged, deleted, renamed, and untracked files", async (t) => {
  const repository = await createRepository(t, {
    "deleted.txt": "delete me\n",
    "renamed-old.txt": "same content\n",
    "staged.txt": "before staged edit\n",
    "unstaged.txt": "before unstaged edit\n",
  });
  const workspace = new GitWorkspace({ projectRoot: repository });
  const location = await workspace.createOrRecover(ATTEMPT);

  await writeFile(join(location.path, "staged.txt"), "after staged edit\n", "utf8");
  git(location.path, ["add", "staged.txt"]);
  await writeFile(join(location.path, "unstaged.txt"), "after unstaged edit\n", "utf8");
  await rm(join(location.path, "deleted.txt"));
  await rename(join(location.path, "renamed-old.txt"), join(location.path, "renamed-new.txt"));
  await writeFile(join(location.path, "untracked.txt"), "untracked\n", "utf8");

  const changed = await workspace.changedPaths(ATTEMPT);
  assert.deepEqual(changed, [
    "deleted.txt",
    "renamed-new.txt",
    "renamed-old.txt",
    "staged.txt",
    "unstaged.txt",
    "untracked.txt",
  ]);
});

test("cleanup retains changed work and any workspace with a live or unknown process", async (t) => {
  const repository = await createRepository(t);
  const changedWorkspace = new GitWorkspace({ projectRoot: repository });
  const location = await changedWorkspace.createOrRecover(ATTEMPT);
  await writeFile(join(location.path, "untracked.txt"), "preserve\n", "utf8");
  assert.deepEqual(await changedWorkspace.cleanup(ATTEMPT), {
    outcome: "preserved",
    reason: "Workspace contains uncommitted, committed, or untracked changes.",
  });

  const cleanAttempt = { ...ATTEMPT, taskId: "P04-T03" };
  const unknownWorkspace = new GitWorkspace({
    projectRoot: repository,
    transport: livenessTransport("unknown"),
  });
  await unknownWorkspace.createOrRecover(cleanAttempt);
  assert.deepEqual(await unknownWorkspace.cleanup(cleanAttempt, { activeProcess: { processId: 44 } }), {
    outcome: "preserved",
    reason: "Associated process is unknown; workspace was retained.",
  });
  await assert.rejects(
    unknownWorkspace.createOrRecover(cleanAttempt, { activeProcess: { processId: 44 } }),
    WorkspaceInUseError,
  );

  const missingAttempt = { ...ATTEMPT, taskId: "P04-T04" };
  await assert.rejects(
    unknownWorkspace.createOrRecover(missingAttempt, { activeProcess: { processId: 44 } }),
    WorkspaceInUseError,
  );
  assert.equal((await unknownWorkspace.inspect(missingAttempt)).state, "missing");
});

test("path normalization rejects traversal and accepts Windows separators as repository-relative paths", () => {
  assert.equal(normalizeRepositoryPath("src\\workspaces\\git.ts"), "src/workspaces/git.ts");
  assert.throws(() => normalizeRepositoryPath("../outside.ts"), WorkspaceError);
  assert.throws(() => normalizeRepositoryPath("C:\\outside.ts"), WorkspaceError);
  assert.throws(() => normalizeRepositoryPath("/outside.ts"), WorkspaceError);
});

function livenessTransport(liveness: "alive" | "not-found" | "unknown"): GitProcessTransport {
  const transport = createGitProcessTransport({ liveness: () => liveness });
  return transport;
}

async function createRepository(
  t: TestContext,
  files: Readonly<Record<string, string>> = {},
): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "draftforge-workspace-"));
  t.after(async () => rm(repository, { recursive: true, force: true }));
  git(repository, ["init", "--initial-branch=main"]);
  git(repository, ["config", "user.name", "DraftForge Test"]);
  git(repository, ["config", "user.email", "draftforge-test@example.invalid"]);
  await writeFile(join(repository, "README.md"), "initial\n", "utf8");
  for (const [path, contents] of Object.entries(files)) {
    await writeFile(join(repository, path), contents, "utf8");
  }
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "initial"]);
  return repository;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function fakeChild(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: () => boolean;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child as unknown as ChildProcessWithoutNullStreams;
}

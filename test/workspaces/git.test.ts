import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, test, type TestContext } from "node:test";
import type { WorkspaceAttempt } from "../../src/application/workspace.js";
import {
  GitWorkspace,
  WorkspaceError,
  WorkspaceInUseError,
  normalizeRepositoryPath,
  trustedInspectionArguments,
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
const originalGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
const originalSystemConfig = process.env.GIT_CONFIG_SYSTEM;
const isolatedConfigRoot = await mkdtemp(join(tmpdir(), "draftforge-git-config-"));
const isolatedConfig = join(isolatedConfigRoot, "empty.gitconfig");
await writeFile(isolatedConfig, "", "utf8");
process.env.GIT_CONFIG_GLOBAL = isolatedConfig;
process.env.GIT_CONFIG_SYSTEM = isolatedConfig;
after(async () => {
  if (originalGlobalConfig === undefined) {
    delete process.env.GIT_CONFIG_GLOBAL;
  } else {
    process.env.GIT_CONFIG_GLOBAL = originalGlobalConfig;
  }
  if (originalSystemConfig === undefined) {
    delete process.env.GIT_CONFIG_SYSTEM;
  } else {
    process.env.GIT_CONFIG_SYSTEM = originalSystemConfig;
  }
  await rm(isolatedConfigRoot, { recursive: true, force: true });
});

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

test("trusted Git inspection arguments disable mutable acceleration and hook surfaces", () => {
  const trustedSuffix = [
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
    "status",
  ];
  assert.deepEqual(
    trustedInspectionArguments(["status"], "linux"),
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...trustedSuffix,
    ],
  );
  assert.deepEqual(
    trustedInspectionArguments(["status"], "win32"),
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=NUL",
      ...trustedSuffix,
    ],
  );
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

test("core.worktree cannot redirect inspection to a clean repository", async (t) => {
  const repository = await createRepository(t);
  const workspace = new GitWorkspace({ projectRoot: repository });
  const location = await workspace.createOrRecover(ATTEMPT);
  await writeFile(join(location.path, "outside.ts"), "unowned\n", "utf8");
  git(location.path, ["config", "--worktree", "core.worktree", repository]);
  assert.equal(
    await realpath(git(location.path, ["rev-parse", "--show-toplevel"]).trim()),
    await realpath(repository),
    "the real Git repro redirects commands away from the worker directory",
  );

  const inspection = await workspace.inspect(ATTEMPT, location.baseCommit);
  assert.equal(inspection.state, "unsafe");
  assert.match(inspection.reason ?? "", /top level does not match/u);
  await assert.rejects(
    workspace.changedPaths(ATTEMPT, location.baseCommit),
    /top level does not match/u,
  );
});

test("Git content filter commands cannot execute or erase authoritative changes", async (t) => {
  await t.test("worktree clean filter with the staged stat-cache repro", async (t) => {
    const repository = await createRepository(t, {
      ".gitattributes": "outside.ts filter=cloak\n",
      "outside.ts": "before\n",
    });
    const workspace = new GitWorkspace({ projectRoot: repository });
    const location = await workspace.createOrRecover(ATTEMPT);
    git(location.path, [
      "config",
      "--worktree",
      "filter.cloak.clean",
      'sed "s/.*/before/"',
    ]);
    git(location.path, ["config", "--worktree", "filter.cloak.required", "true"]);
    await writeFile(join(location.path, "outside.ts"), "after\n", "utf8");
    git(location.path, ["add", "outside.ts"]);

    assert.equal(git(location.path, ["status", "--porcelain=v1"]).trim(), "");
    assert.equal(
      git(location.path, ["diff", "--name-only", location.baseCommit]).trim(),
      "",
      "the real staged clean-filter repro hides the changed path",
    );
    assert.equal(await readFile(join(location.path, "outside.ts"), "utf8"), "after\n");

    const inspection = await workspace.inspect(ATTEMPT, location.baseCommit);
    assert.equal(inspection.state, "unsafe");
    assert.match(inspection.reason ?? "", /clean\/process content filters/u);
    await assert.rejects(
      workspace.changedPaths(ATTEMPT, location.baseCommit),
      /clean\/process content filters/u,
    );
  });

  await t.test("local process filter with mixed-case driver", async (t) => {
    const repository = await createRepository(t);
    const workspace = new GitWorkspace({ projectRoot: repository });
    const location = await workspace.createOrRecover(ATTEMPT);
    git(location.path, [
      "config",
      "--local",
      "filter.ClOaK.process",
      "worker-controlled-filter-process",
    ]);

    const inspection = await workspace.inspect(ATTEMPT, location.baseCommit);
    assert.equal(inspection.state, "unsafe");
    assert.match(inspection.reason ?? "", /clean\/process content filters/u);
  });

  await t.test("global clean filter is effective and rejected", async (t) => {
    const repository = await createRepository(t);
    const workspace = new GitWorkspace({ projectRoot: repository });
    const location = await workspace.createOrRecover(ATTEMPT);
    git(location.path, ["config", "--global", "filter.Global.clean", "cat"]);
    try {
      const inspection = await workspace.inspect(ATTEMPT, location.baseCommit);
      assert.equal(inspection.state, "unsafe");
      assert.match(inspection.reason ?? "", /clean\/process content filters/u);
    } finally {
      git(location.path, ["config", "--global", "--unset-all", "filter.Global.clean"]);
    }
  });

  await t.test("required-only filter metadata is harmless", async (t) => {
    const repository = await createRepository(t);
    const workspace = new GitWorkspace({ projectRoot: repository });
    const location = await workspace.createOrRecover(ATTEMPT);
    git(location.path, ["config", "--worktree", "filter.cloak.required", "true"]);
    await writeFile(join(location.path, "ordinary.txt"), "visible\n", "utf8");

    const inspection = await workspace.inspect(ATTEMPT, location.baseCommit);
    assert.equal(inspection.state, "ready");
    assert.deepEqual(inspection.changedPaths, ["ordinary.txt"]);
  });

  await t.test("malformed config key output is unsafe", async (t) => {
    const repository = await createRepository(t);
    const workspace = new GitWorkspace({ projectRoot: repository });
    const location = await workspace.createOrRecover(ATTEMPT);
    const realTransport = createGitProcessTransport();
    const malformedTransport: GitProcessTransport = {
      async run(request) {
        if (
          request.args.join("\0") ===
          ["config", "--null", "--name-only", "--list"].join("\0")
        ) {
          return {
            stdout: "filter.cloak.clean",
            stderr: "",
            exitCode: 0,
            signal: null,
            definitelyTerminated: true,
            processId: undefined,
          };
        }
        return realTransport.run(request);
      },
      liveness(processId) {
        return realTransport.liveness(processId);
      },
    };
    const malformedWorkspace = new GitWorkspace({
      projectRoot: repository,
      transport: malformedTransport,
    });

    const inspection = await malformedWorkspace.inspect(ATTEMPT, location.baseCommit);
    assert.equal(inspection.state, "unsafe");
    assert.match(inspection.reason ?? "", /incomplete null-delimited/u);
  });
});

test("Git inspection never executes configured fsmonitor or hook commands", async (t) => {
  await t.test("core.fsmonitor", async (t) => {
    const repository = await createRepository(t, { "tracked.txt": "before\n" });
    const workspace = new GitWorkspace({ projectRoot: repository });
    const location = await workspace.createOrRecover(ATTEMPT);
    const marker = join(repository, "fsmonitor-invoked");
    const hook = join(repository, "fsmonitor-hook");
    await writeExecutableMarkerHook(hook, marker);
    git(location.path, ["config", "--worktree", "core.fsmonitor", hook]);
    git(location.path, ["ls-files", "-v"]);
    assert.equal(await readFile(marker, "utf8"), "invoked\n");
    await rm(marker);

    const inspection = await workspace.inspect(ATTEMPT, location.baseCommit);
    assert.equal(inspection.state, "unsafe");
    assert.match(inspection.reason ?? "", /core\.fsmonitor/u);
    await assertFileMissing(marker);
  });

  await t.test("core.hooksPath post-index-change", async (t) => {
    const repository = await createRepository(t, { "tracked.txt": "before\n" });
    const workspace = new GitWorkspace({ projectRoot: repository });
    const location = await workspace.createOrRecover(ATTEMPT);
    const hooks = join(repository, "worker-hooks");
    const marker = join(repository, "post-index-change-invoked");
    await mkdir(hooks, { recursive: true });
    await writeExecutableMarkerHook(join(hooks, "post-index-change"), marker);
    git(location.path, ["config", "--worktree", "core.hooksPath", hooks]);
    await writeFile(join(location.path, "tracked.txt"), "after\n", "utf8");
    git(location.path, ["status", "--porcelain=v1"]);
    assert.equal(await readFile(marker, "utf8"), "invoked\n");
    await rm(marker);

    const inspection = await workspace.inspect(ATTEMPT, location.baseCommit);
    assert.equal(inspection.state, "unsafe");
    assert.match(inspection.reason ?? "", /core\.hooksPath/u);
    await assertFileMissing(marker);
  });
});

test("tracked submodules are rejected before nested inspection can execute", async (t) => {
  const childRepository = await createRepository(t, {
    ".gitattributes": "child.txt filter=nested\n",
    "child.txt": "before\n",
  });
  const repository = await createRepository(t);
  git(repository, [
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    childRepository,
    "modules/child",
  ]);
  git(repository, ["commit", "-am", "add child submodule"]);
  const workspace = new GitWorkspace({ projectRoot: repository });
  const location = await workspace.createOrRecover(ATTEMPT);
  git(location.path, [
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "update",
    "--init",
  ]);
  const child = join(location.path, "modules", "child");
  const marker = join(repository, "nested-filter-invoked");
  const filter = join(repository, "nested-filter");
  await writeExecutablePassthroughFilter(filter, marker);
  git(child, ["config", "filter.nested.clean", filter]);
  await writeFile(join(child, "child.txt"), "after!\n", "utf8");
  git(location.path, ["config", "--worktree", "submodule.modules/child.ignore", "all"]);
  assert.equal(git(location.path, ["status", "--porcelain=v1"]).trim(), "");

  const inspection = await workspace.inspect(ATTEMPT, location.baseCommit);
  assert.equal(inspection.state, "unsafe");
  assert.match(inspection.reason ?? "", /submodule path "modules\/child"/u);
  await assertFileMissing(marker);
});

test("trusted stat settings expose chmod and restored-mtime changes", async (t) => {
  await t.test("core.fileMode=false cannot hide chmod", async (t) => {
    if (process.platform === "win32") {
      t.skip("Windows does not expose POSIX executable mode changes");
      return;
    }
    const repository = await createRepository(t, { "script.sh": "#!/bin/sh\n" });
    const workspace = new GitWorkspace({ projectRoot: repository });
    const location = await workspace.createOrRecover(ATTEMPT);
    git(location.path, ["config", "--worktree", "core.fileMode", "false"]);
    await chmod(join(location.path, "script.sh"), 0o755);
    assert.equal((await stat(join(location.path, "script.sh"))).mode & 0o777, 0o755);
    assert.equal(
      git(location.path, ["diff", "--name-only", location.baseCommit]).trim(),
      "",
    );

    assert.deepEqual(
      await workspace.changedPaths(ATTEMPT, location.baseCommit),
      ["script.sh"],
    );
  });

  await t.test("core.trustctime=false cannot hide a restored-mtime rewrite", async (t) => {
    const repository = await createRepository(t, { "clock.txt": "before\n" });
    const workspace = new GitWorkspace({ projectRoot: repository });
    const location = await workspace.createOrRecover(ATTEMPT);
    const path = join(location.path, "clock.txt");
    const oldTimestamp = new Date("2001-01-01T00:00:00.000Z");
    await utimes(path, oldTimestamp, oldTimestamp);
    git(location.path, ["update-index", "--refresh"]);
    const cached = await stat(path);
    git(location.path, ["config", "--worktree", "core.trustctime", "false"]);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_100));
    await writeFile(path, "after!\n", "utf8");
    await utimes(path, cached.atime, cached.mtime);
    assert.equal(await readFile(path, "utf8"), "after!\n");
    assert.equal((await stat(path)).mtimeMs, cached.mtimeMs);

    assert.deepEqual(
      await workspace.changedPaths(ATTEMPT, location.baseCommit),
      ["clock.txt"],
    );
  });
});

test("trusted line-ending settings expose a staged physical CRLF rewrite", async (t) => {
  const repository = await createRepository(t, { "outside.ts": "line\n" });
  const workspace = new GitWorkspace({ projectRoot: repository });
  const location = await workspace.createOrRecover(ATTEMPT);
  const path = join(location.path, "outside.ts");
  git(location.path, ["config", "--worktree", "core.autocrlf", "true"]);
  await writeFile(path, Buffer.from("line\r\n", "utf8"));
  git(location.path, ["add", "outside.ts"]);

  assert.equal(git(location.path, ["status", "--porcelain=v1"]).trim(), "");
  assert.equal(
    git(location.path, ["diff", "--name-only", location.baseCommit]).trim(),
    "",
    "the real autocrlf repro hides the staged physical rewrite",
  );
  assert.deepEqual(await readFile(path), Buffer.from("line\r\n", "utf8"));

  const inspection = await workspace.inspect(ATTEMPT, location.baseCommit);
  assert.equal(inspection.state, "unsafe");
  assert.match(inspection.reason ?? "", /repository normalization "core\.autocrlf"/u);
  await assert.rejects(
    workspace.changedPaths(ATTEMPT, location.baseCommit),
    /repository normalization "core\.autocrlf"/u,
  );
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

test("unsafe Git index flags cannot suppress tracked workspace changes", async (t) => {
  await t.test("assume-unchanged", async (t) => {
    const repository = await createRepository(t, { "tracked.txt": "before\n" });
    const workspace = new GitWorkspace({ projectRoot: repository });
    const location = await workspace.createOrRecover(ATTEMPT);
    git(location.path, ["update-index", "--assume-unchanged", "tracked.txt"]);
    await writeFile(join(location.path, "tracked.txt"), "after\n", "utf8");

    const inspection = await workspace.inspect(ATTEMPT, location.baseCommit);
    assert.equal(inspection.state, "unsafe");
    assert.match(inspection.reason ?? "", /assume-unchanged/u);
    await assert.rejects(
      workspace.changedPaths(ATTEMPT, location.baseCommit),
      /assume-unchanged/u,
    );
  });

  await t.test("skip-worktree", async (t) => {
    const repository = await createRepository(t, { "tracked.txt": "before\n" });
    const workspace = new GitWorkspace({ projectRoot: repository });
    const location = await workspace.createOrRecover(ATTEMPT);
    git(location.path, ["update-index", "--skip-worktree", "tracked.txt"]);
    await writeFile(join(location.path, "tracked.txt"), "after\n", "utf8");

    const inspection = await workspace.inspect(ATTEMPT, location.baseCommit);
    assert.equal(inspection.state, "unsafe");
    assert.match(inspection.reason ?? "", /skip-worktree/u);
    await assert.rejects(
      workspace.changedPaths(ATTEMPT, location.baseCommit),
      /skip-worktree/u,
    );
  });

  await t.test("fsmonitor-valid when supported by Git", async (t) => {
    const repository = await createRepository(t, { "tracked.txt": "before\n" });
    const workspace = new GitWorkspace({ projectRoot: repository });
    const location = await workspace.createOrRecover(ATTEMPT);
    git(location.path, ["update-index", "--fsmonitor-valid", "tracked.txt"]);
    const tagged = git(location.path, ["ls-files", "-f", "-z"]);
    if (!tagged.startsWith("h tracked.txt\0")) {
      t.skip("installed Git does not retain fsmonitor-valid without an active monitor");
      return;
    }
    await writeFile(join(location.path, "tracked.txt"), "after\n", "utf8");

    const inspection = await workspace.inspect(ATTEMPT, location.baseCommit);
    assert.equal(inspection.state, "unsafe");
    assert.match(inspection.reason ?? "", /fsmonitor-valid/u);
  });
});

test("mutable repository exclusion controls make inspection unsafe", async (t) => {
  await t.test("active common info/exclude pattern", async (t) => {
    const repository = await createRepository(t);
    const workspace = new GitWorkspace({ projectRoot: repository });
    const location = await workspace.createOrRecover(ATTEMPT);
    await writeFile(
      join(repository, ".git", "info", "exclude"),
      "# comments remain safe\nhidden-by-info.txt\n",
      "utf8",
    );
    await writeFile(join(location.path, "hidden-by-info.txt"), "hidden\n", "utf8");

    const inspection = await workspace.inspect(ATTEMPT, location.baseCommit);
    assert.equal(inspection.state, "unsafe");
    assert.match(inspection.reason ?? "", /info\/exclude/u);
    await assert.rejects(
      workspace.changedPaths(ATTEMPT, location.baseCommit),
      /info\/exclude/u,
    );
  });

  for (const scope of ["--local", "--worktree"] as const) {
    await t.test(`${scope} core.excludesFile`, async (t) => {
      const repository = await createRepository(t);
      const workspace = new GitWorkspace({ projectRoot: repository });
      const location = await workspace.createOrRecover(ATTEMPT);
      const excludesFile = join(repository, `exclude-${scope.slice(2)}.txt`);
      await writeFile(excludesFile, "hidden-by-config.txt\n", "utf8");
      git(location.path, ["config", scope, "core.excludesFile", excludesFile]);
      await writeFile(join(location.path, "hidden-by-config.txt"), "hidden\n", "utf8");

      const inspection = await workspace.inspect(ATTEMPT, location.baseCommit);
      assert.equal(inspection.state, "unsafe");
      assert.match(inspection.reason ?? "", /core\.excludesFile/u);
      await assert.rejects(
        workspace.changedPaths(ATTEMPT, location.baseCommit),
        /core\.excludesFile/u,
      );
    });
  }
});

test("mutable Git history overlays cannot rewrite the authoritative diff", async (t) => {
  await t.test("replacement refs", async (t) => {
    const repository = await createRepository(t);
    const workspace = new GitWorkspace({ projectRoot: repository });
    const location = await workspace.createOrRecover(ATTEMPT);
    await writeFile(join(location.path, "outside.ts"), "unowned\n", "utf8");
    git(location.path, ["add", "outside.ts"]);
    git(location.path, ["commit", "-m", "worker commit"]);
    assert.equal(
      git(location.path, ["diff", "--name-only", location.baseCommit]).trim(),
      "outside.ts",
    );

    const forged = git(location.path, ["commit-tree", "HEAD^{tree}", "-m", "forged"]).trim();
    git(location.path, ["replace", location.baseCommit, forged]);
    assert.equal(
      git(location.path, ["diff", "--name-only", location.baseCommit]).trim(),
      "",
      "the real Git replacement repro hides the committed path",
    );

    const inspection = await workspace.inspect(ATTEMPT, location.baseCommit);
    assert.equal(inspection.state, "unsafe");
    assert.match(inspection.reason ?? "", /replacement refs/u);
    await assert.rejects(
      workspace.changedPaths(ATTEMPT, location.baseCommit),
      /replacement refs/u,
    );
  });

  await t.test("common info/grafts", async (t) => {
    const repository = await createRepository(t);
    const workspace = new GitWorkspace({ projectRoot: repository });
    const location = await workspace.createOrRecover(ATTEMPT);
    await writeFile(
      join(repository, ".git", "info", "grafts"),
      `${location.baseCommit}\n`,
      "utf8",
    );

    const inspection = await workspace.inspect(ATTEMPT, location.baseCommit);
    assert.equal(inspection.state, "unsafe");
    assert.match(inspection.reason ?? "", /info\/grafts/u);
    await assert.rejects(
      workspace.changedPaths(ATTEMPT, location.baseCommit),
      /info\/grafts/u,
    );
  });
});

test("untracked enumeration exposes ignored secrets without traversing fixed build outputs", async (t) => {
  const repository = await createRepository(t, {
    ".gitignore": "*.secret\n.env*\nignored-dir/\n!mixed/\n!mixed/visible.txt\nmixed/*.secret\ndist/\ncoverage/\nnode_modules/\n",
  });
  const workspace = new GitWorkspace({ projectRoot: repository });
  const location = await workspace.createOrRecover(ATTEMPT);
  await writeFile(join(location.path, "ordinary.txt"), "visible\n", "utf8");
  await writeFile(join(location.path, "hidden.secret"), "hidden\n", "utf8");
  await writeFile(join(location.path, ".env.worker"), "secret\n", "utf8");
  await mkdir(join(location.path, "ignored-dir"), { recursive: true });
  await writeFile(join(location.path, "ignored-dir", "secret.txt"), "hidden\n", "utf8");
  await mkdir(join(location.path, "mixed"), { recursive: true });
  await writeFile(join(location.path, "mixed", "visible.txt"), "visible\n", "utf8");
  await writeFile(join(location.path, "mixed", "hidden.secret"), "hidden sibling\n", "utf8");
  for (const root of ["dist", "coverage", "node_modules"] as const) {
    await mkdir(join(location.path, root), { recursive: true });
    await writeFile(join(location.path, root, "generated.js"), "build output\n", "utf8");
  }

  const inspection = await workspace.inspect(ATTEMPT, location.baseCommit);
  assert.equal(inspection.state, "ready");
  assert.equal(inspection.dirty, true);
  assert.deepEqual(inspection.changedPaths, [
    ".env.worker",
    "hidden.secret",
    "ignored-dir",
    "mixed/hidden.secret",
    "mixed/visible.txt",
    "ordinary.txt",
  ]);
});

test("a fixed build root is allowed only when it is an ignored directory", async (t) => {
  await t.test("unignored directory", async (t) => {
    const repository = await createRepository(t);
    const workspace = new GitWorkspace({ projectRoot: repository });
    const location = await workspace.createOrRecover(ATTEMPT);
    await mkdir(join(location.path, "dist"), { recursive: true });
    await writeFile(join(location.path, "dist", "not-ignored.js"), "authoritative\n", "utf8");

    assert.deepEqual(
      await workspace.changedPaths(ATTEMPT, location.baseCommit),
      ["dist"],
    );
  });

  await t.test("ignored file with an allowed directory name", async (t) => {
    const repository = await createRepository(t, { ".gitignore": "dist\n" });
    const workspace = new GitWorkspace({ projectRoot: repository });
    const location = await workspace.createOrRecover(ATTEMPT);
    await writeFile(join(location.path, "dist"), "not a build directory\n", "utf8");

    assert.deepEqual(
      await workspace.changedPaths(ATTEMPT, location.baseCommit),
      ["dist"],
    );
  });
});

test("rewritten or missing base metadata cannot hide committed unowned changes", async (t) => {
  const repository = await createRepository(t);
  const workspace = new GitWorkspace({ projectRoot: repository });
  const location = await workspace.createOrRecover(ATTEMPT);
  await writeFile(join(location.path, "unowned-commit.txt"), "committed\n", "utf8");
  git(location.path, ["add", "unowned-commit.txt"]);
  git(location.path, ["commit", "-m", "worker commit"]);

  git(location.path, ["config", "--worktree", "draftforge.base-commit", git(location.path, ["rev-parse", "HEAD"]).trim()]);
  const rewritten = await workspace.inspect(ATTEMPT, location.baseCommit);
  assert.equal(rewritten.state, "unsafe");
  assert.match(rewritten.reason ?? "", /base metadata disagrees/u);

  git(location.path, ["config", "--worktree", "--unset-all", "draftforge.base-commit"]);
  assert.deepEqual(await workspace.changedPaths(ATTEMPT, location.baseCommit), ["unowned-commit.txt"]);
});

test("Git literal backslash filenames are rejected instead of normalized into owned paths", async (t) => {
  const repository = await createRepository(t);
  const workspace = new GitWorkspace({ projectRoot: repository });
  const location = await workspace.createOrRecover(ATTEMPT);
  await writeFile(join(location.path, "src\\worker.ts"), "spoof\n", "utf8");

  const inspection = await workspace.inspect(ATTEMPT, location.baseCommit);
  assert.equal(inspection.state, "unsafe");
  assert.match(inspection.reason ?? "", /unsafe repository-relative path/u);
  await assert.rejects(
    workspace.changedPaths(ATTEMPT, location.baseCommit),
    /unsafe repository-relative path/u,
  );
});

test("ignored worker controls are authoritative while allowed ignored outputs stay excluded", async (t) => {
  const repository = await createRepository(t, {
    ".gitignore": "dist/\n.draftforge/runs/\n.draftforge/config.local.json\n",
  });
  const workspace = new GitWorkspace({ projectRoot: repository });
  const location = await workspace.createOrRecover(ATTEMPT);
  await mkdir(join(location.path, ".draftforge", "runs"), { recursive: true });
  await writeFile(join(location.path, ".draftforge", "runs", "worker.txt"), "control\n", "utf8");
  await writeFile(join(location.path, ".draftforge", "config.local.json"), "{}\n", "utf8");
  await mkdir(join(location.path, "dist"), { recursive: true });
  await writeFile(join(location.path, "dist", "allowed.js"), "ignored build output\n", "utf8");

  assert.deepEqual(await workspace.changedPaths(ATTEMPT, location.baseCommit), [
    ".draftforge",
    ".draftforge/config.local.json",
    ".draftforge/runs",
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

test("Git path normalization rejects traversal, absolute paths, and literal backslashes", () => {
  assert.throws(() => normalizeRepositoryPath("src\\workspaces\\git.ts"), WorkspaceError);
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

async function writeExecutableMarkerHook(path: string, marker: string): Promise<void> {
  await writeFile(
    path,
    `#!/bin/sh\nprintf 'invoked\\n' >> ${shellQuote(marker)}\n`,
    "utf8",
  );
  await chmod(path, 0o755);
}

async function writeExecutablePassthroughFilter(path: string, marker: string): Promise<void> {
  await writeFile(
    path,
    `#!/bin/sh\nprintf 'invoked\\n' >> ${shellQuote(marker)}\ncat\n`,
    "utf8",
  );
  await chmod(path, 0o755);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function assertFileMissing(path: string): Promise<void> {
  await assert.rejects(
    readFile(path, "utf8"),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT",
  );
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

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test, type TestContext } from "node:test";
import type { ExecutionSummary } from "../src/application/execution.js";
import { runExecution } from "../src/commands/run.js";
import type { AttemptReference } from "../src/domain/execution.js";
import { attemptEventPath, readExecutionAttemptManifest } from "../src/state/execution.js";
import { readProjectState } from "../src/state/files.js";
import { GitWorkspace } from "../src/workspaces/git.js";
import {
  createExecutionProject,
  FakeWorkerRunner,
  FakeWorkspace,
} from "./fixtures/execution/harness.js";
import {
  materializeProject,
  seedAttempt,
  type ProjectSpec,
  type SeededAttempt,
  type TaskSpec,
} from "./fixtures/execution/project.js";

// Git must never read this developer's real configuration.
const originalGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
const originalSystemConfig = process.env.GIT_CONFIG_SYSTEM;
const isolatedConfigRoot = await mkdtemp(join(tmpdir(), "draftforge-execution-gitconfig-"));
const isolatedConfig = join(isolatedConfigRoot, "empty.gitconfig");
await writeFile(isolatedConfig, "", "utf8");
process.env.GIT_CONFIG_GLOBAL = isolatedConfig;
process.env.GIT_CONFIG_SYSTEM = isolatedConfig;
after(async () => {
  restoreEnv("GIT_CONFIG_GLOBAL", originalGlobalConfig);
  restoreEnv("GIT_CONFIG_SYSTEM", originalSystemConfig);
  await rm(isolatedConfigRoot, { recursive: true, force: true });
});

const ATTEMPT: AttemptReference = { runId: "run-seed", attemptId: "alpha-01" };
const ALPHA_ACTIVE: TaskSpec = {
  id: "P04-T01",
  title: "Alpha",
  status: "active",
  ownedPaths: ["src/alpha"],
  attempt: ATTEMPT,
};

function spec(tasks: readonly TaskSpec[]): ProjectSpec {
  return {
    name: "Resume sample",
    approved: true,
    workerAdapter: "claude-cli",
    maxConcurrency: 2,
    tasks,
  };
}

async function seededProject(
  t: TestContext,
  tasks: readonly TaskSpec[],
  seeds: readonly SeededAttempt[],
): Promise<string> {
  const project = spec(tasks);
  const root = await createExecutionProject(t, project);
  for (const seed of seeds) {
    await seedAttempt(root, project, seed);
  }
  return root;
}

function statusOf(state: Awaited<ReturnType<typeof readProjectState>>, taskId: string): string {
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  assert.ok(task, `expected task ${taskId}`);
  return task.status;
}

function fingerprint(summary: ExecutionSummary): string {
  return JSON.stringify({
    records: summary.records.map((record) => `${record.taskId}:${record.disposition}:${record.status}`),
    deferred: summary.deferred.map((record) => `${record.taskId}:${record.reason}`),
    reviewReady: summary.reviewReady,
    blocked: summary.blocked,
    orphanAttempts: summary.orphanAttempts,
  });
}

test("resume tolerates a crash after every durable boundary", async (t) => {
  await t.test("after claim: the same attempt and worktree identity are reused", async (inner) => {
    const root = await seededProject(inner, [ALPHA_ACTIVE], [
      { taskId: "P04-T01", reference: ATTEMPT, lifecycle: "claimed" },
    ]);
    const runner = new FakeWorkerRunner({});
    const workspace = new FakeWorkspace(root);

    const result = await runExecution(root, { mode: "resume" }, { runner, workspace, runId: "run-resume" });

    assert.deepEqual(
      result.summary.records.map((record) => `${record.taskId}:${record.disposition}:${record.status}`),
      ["P04-T01:resumed:review"],
    );
    assert.deepEqual(result.summary.records[0]?.attempt, ATTEMPT);
    assert.deepEqual(workspace.createdTasks, ["P04-T01"]);
    assert.equal(statusOf(await readProjectState(root), "P04-T01"), "review");
  });

  await t.test("after worktree creation: the existing worktree is recovered, not recreated", async (inner) => {
    const root = await seededProject(inner, [ALPHA_ACTIVE], [
      { taskId: "P04-T01", reference: ATTEMPT, lifecycle: "running" },
    ]);
    const workspace = new FakeWorkspace(root);
    const worktree = workspace.worktreePath({ ...ATTEMPT, taskId: "P04-T01" });
    await mkdir(worktree, { recursive: true });
    await writeFile(join(worktree, "AGENTS.md"), "# Agent rules\n", "utf8");

    const result = await runExecution(
      root,
      { mode: "resume" },
      { runner: new FakeWorkerRunner({}), workspace, runId: "run-resume" },
    );

    assert.deepEqual(workspace.createdTasks, []);
    assert.ok(workspace.recoveredTasks.includes("P04-T01"));
    assert.equal(result.summary.records[0]?.status, "review");
  });

  await t.test("after the first modification: worktree contents survive the resume", async (inner) => {
    const root = await seededProject(inner, [ALPHA_ACTIVE], [
      { taskId: "P04-T01", reference: ATTEMPT, lifecycle: "running" },
    ]);
    const workspace = new FakeWorkspace(root, { changedPaths: { "P04-T01": ["src/alpha/index.ts"] } });
    const worktree = workspace.worktreePath({ ...ATTEMPT, taskId: "P04-T01" });
    await mkdir(join(worktree, "src", "alpha"), { recursive: true });
    await writeFile(join(worktree, "AGENTS.md"), "# Agent rules\n", "utf8");
    await writeFile(join(worktree, "src", "alpha", "index.ts"), "export const alpha = 1;\n", "utf8");

    const result = await runExecution(
      root,
      { mode: "resume" },
      { runner: new FakeWorkerRunner({}), workspace, runId: "run-resume" },
    );

    assert.equal(result.summary.records[0]?.status, "review");
    assert.equal(
      await readFile(join(worktree, "src", "alpha", "index.ts"), "utf8"),
      "export const alpha = 1;\n",
    );
  });

  await t.test("after result persistence: the record is finalized without another model call", async (inner) => {
    const root = await seededProject(inner, [ALPHA_ACTIVE], [
      {
        taskId: "P04-T01",
        reference: ATTEMPT,
        lifecycle: "running",
        result: { outcome: "review", reason: "completed", changedPaths: ["src/alpha/index.ts"] },
      },
    ]);
    const runner = new FakeWorkerRunner({});

    const result = await runExecution(
      root,
      { mode: "resume" },
      { runner, workspace: new FakeWorkspace(root), runId: "run-resume" },
    );

    assert.equal(runner.callCount, 0);
    assert.deepEqual(
      result.summary.records.map((record) => `${record.taskId}:${record.disposition}:${record.status}`),
      ["P04-T01:finalized:review"],
    );
    assert.equal(statusOf(await readProjectState(root), "P04-T01"), "review");
    assert.equal((await readExecutionAttemptManifest(root, ATTEMPT)).lifecycle, "review");
  });

  await t.test("after event append: finalization stays single-writer", async (inner) => {
    const root = await seededProject(inner, [ALPHA_ACTIVE], [
      {
        taskId: "P04-T01",
        reference: ATTEMPT,
        lifecycle: "running",
        result: { outcome: "blocked", reason: "scope-violation", scopeViolations: ["src/other.ts"] },
        resultEvent: true,
      },
    ]);
    const runner = new FakeWorkerRunner({});

    const result = await runExecution(
      root,
      { mode: "resume" },
      { runner, workspace: new FakeWorkspace(root), runId: "run-resume" },
    );

    assert.equal(runner.callCount, 0);
    assert.equal(result.summary.records[0]?.status, "blocked");
    assert.equal(result.exitCode, 1, "a reconciled blocked outcome is still surfaced as a failure");
    const events = await readFile(resolve(root, attemptEventPath(ATTEMPT)), "utf8");
    assert.equal(events.split("\n").filter((line) => line.includes("worker.result")).length, 1);
  });

  await t.test("after the state write: only the trailing manifest lifecycle is repaired", async (inner) => {
    const root = await seededProject(
      inner,
      [{ ...ALPHA_ACTIVE, status: "review" }],
      [
        {
          taskId: "P04-T01",
          reference: ATTEMPT,
          lifecycle: "running",
          result: { outcome: "review", reason: "completed" },
        },
      ],
    );
    const runner = new FakeWorkerRunner({});

    const result = await runExecution(
      root,
      { mode: "resume" },
      { runner, workspace: new FakeWorkspace(root), runId: "run-resume" },
    );

    assert.equal(runner.callCount, 0);
    assert.equal(result.summary.records[0]?.detail, "Attempt manifest lifecycle was resynchronized with canonical state.");
    assert.equal((await readExecutionAttemptManifest(root, ATTEMPT)).lifecycle, "review");
    assert.equal(statusOf(await readProjectState(root), "P04-T01"), "review");
  });

  await t.test("after the session write: a consistent project has nothing to reconcile", async (inner) => {
    const root = await seededProject(
      inner,
      [{ ...ALPHA_ACTIVE, status: "review" }],
      [
        {
          taskId: "P04-T01",
          reference: ATTEMPT,
          lifecycle: "review",
          result: { outcome: "review", reason: "completed" },
        },
      ],
    );
    const runner = new FakeWorkerRunner({});

    const result = await runExecution(
      root,
      { mode: "resume" },
      { runner, workspace: new FakeWorkspace(root), runId: "run-resume" },
    );

    assert.equal(runner.callCount, 0);
    assert.deepEqual(result.summary.records, []);
    assert.deepEqual(result.summary.reviewReady, ["P04-T01"]);
    assert.ok(result.lines.includes("No work: nothing was dispatched, resumed, or reconciled."));
  });
});

test("repeated reconciliation is stable and never re-dispatches completed work", async (t) => {
  const root = await seededProject(t, [ALPHA_ACTIVE], [
    {
      taskId: "P04-T01",
      reference: ATTEMPT,
      lifecycle: "running",
      result: { outcome: "review", reason: "completed" },
    },
  ]);
  const runner = new FakeWorkerRunner({});
  const workspace = new FakeWorkspace(root);

  const first = await runExecution(root, { mode: "resume" }, { runner, workspace, runId: "run-a" });
  const second = await runExecution(root, { mode: "resume" }, { runner, workspace, runId: "run-b" });
  const third = await runExecution(root, { mode: "resume" }, { runner, workspace, runId: "run-c" });

  assert.equal(runner.callCount, 0);
  assert.equal(first.summary.records.length, 1);
  assert.equal(fingerprint(second.summary), fingerprint(third.summary));
  assert.deepEqual(second.summary.records, []);
  assert.equal(statusOf(await readProjectState(root), "P04-T01"), "review");
});

test("a worker result event without its artifact is never treated as acceptance", async (t) => {
  const root = await seededProject(t, [ALPHA_ACTIVE], [
    { taskId: "P04-T01", reference: ATTEMPT, lifecycle: "running", resultEvent: true },
  ]);
  const runner = new FakeWorkerRunner({});

  const result = await runExecution(
    root,
    { mode: "resume" },
    { runner, workspace: new FakeWorkspace(root), runId: "run-event-ahead" },
  );

  assert.equal(runner.callCount, 0, "an ambiguous attempt must not be redispatched either");
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.summary.records, []);
  const deferral = result.summary.deferred.find((record) => record.taskId === "P04-T01");
  assert.equal(deferral?.reason, "unreconciled");
  assert.match(deferral?.detail ?? "", /result artifact is missing/u);
  assert.equal(statusOf(await readProjectState(root), "P04-T01"), "active");
});

test("an orphan in-flight manifest is reported and never dispatched", async (t) => {
  const project = spec([{ id: "P04-T01", title: "Alpha", status: "ready", ownedPaths: ["src/alpha"] }]);
  const root = await createExecutionProject(t, project);
  await seedAttempt(root, project, {
    taskId: "P04-T01",
    reference: { runId: "run-orphan", attemptId: "ghost-01" },
    lifecycle: "running",
  });
  const runner = new FakeWorkerRunner({});

  const result = await runExecution(
    root,
    { mode: "resume" },
    { runner, workspace: new FakeWorkspace(root), runId: "run-orphan-check" },
  );

  assert.equal(runner.callCount, 0);
  assert.deepEqual(result.summary.orphanAttempts, ["run-orphan/ghost-01"]);
  assert.deepEqual(result.summary.records, []);
  assert.equal(statusOf(await readProjectState(root), "P04-T01"), "ready");
});

test("a task contract that changed under an in-flight attempt blocks resume", async (t) => {
  const root = await seededProject(t, [ALPHA_ACTIVE], [
    { taskId: "P04-T01", reference: ATTEMPT, lifecycle: "running" },
  ]);
  await writeFile(
    resolve(root, ".draftforge", "tasks", "P04-T01.md"),
    `${await readFile(resolve(root, ".draftforge", "tasks", "P04-T01.md"), "utf8")}\n<!-- edited -->\n`,
    "utf8",
  );
  const runner = new FakeWorkerRunner({});

  const result = await runExecution(
    root,
    { mode: "resume" },
    { runner, workspace: new FakeWorkspace(root), runId: "run-drift" },
  );

  assert.equal(runner.callCount, 0);
  assert.equal(result.exitCode, 1);
  const deferral = result.summary.deferred.find((record) => record.taskId === "P04-T01");
  assert.equal(deferral?.reason, "unreconciled");
  assert.match(deferral?.detail ?? "", /contract changed/u);
});

test("resume claims no new work and never redispatches review or done tasks", async (t) => {
  const root = await seededProject(
    t,
    [
      { ...ALPHA_ACTIVE, status: "review" },
      { id: "P04-T02", title: "Beta", status: "done", ownedPaths: ["src/beta"], attempt: { runId: "run-seed", attemptId: "beta-01" } },
      { id: "P04-T03", title: "Gamma", status: "ready", ownedPaths: ["src/gamma"] },
    ],
    [
      {
        taskId: "P04-T01",
        reference: ATTEMPT,
        lifecycle: "review",
        result: { outcome: "review", reason: "completed" },
      },
      {
        taskId: "P04-T02",
        reference: { runId: "run-seed", attemptId: "beta-01" },
        lifecycle: "review",
        result: { outcome: "review", reason: "completed" },
      },
    ],
  );
  const runner = new FakeWorkerRunner({});

  const result = await runExecution(
    root,
    { mode: "resume" },
    { runner, workspace: new FakeWorkspace(root), runId: "run-noop" },
  );

  assert.equal(runner.callCount, 0);
  assert.deepEqual(result.summary.records, []);
  assert.equal(
    result.summary.deferred.find((record) => record.taskId === "P04-T03")?.reason,
    "run-required",
  );
  assert.equal(statusOf(await readProjectState(root), "P04-T02"), "done");
});

test("a real Git worktree is retained across an interrupted attempt and reused on resume", async (t) => {
  if (!gitAvailable()) {
    t.skip("Git is not available on PATH, so real worktree recovery cannot be exercised.");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "draftforge-execution-git-"));
  t.after(async () => {
    // Worktrees hold open handles on Windows; prune before removing the tree.
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: root, stdio: "ignore" });
    } catch {
      // The repository may already be gone; removal below is authoritative.
    }
    await rm(root, { recursive: true, force: true });
  });

  const project = spec([ALPHA_ACTIVE]);
  await materializeProject(root, project);
  await writeFile(resolve(root, ".gitignore"), ".draftforge/runs/\n", "utf8");
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.name", "DraftForge Test"]);
  git(root, ["config", "user.email", "draftforge-test@example.invalid"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "sample"]);
  await seedAttempt(root, project, { taskId: "P04-T01", reference: ATTEMPT, lifecycle: "claimed" });

  const workspace = new GitWorkspace({ projectRoot: root });
  const runner = new FakeWorkerRunner({});
  const result = await runExecution(root, { mode: "resume" }, { runner, workspace, runId: "run-git" });

  assert.equal(result.summary.records[0]?.status, "review", JSON.stringify(result.summary));
  const worktree = resolve(root, ".draftforge", "runs", ATTEMPT.runId, "worktrees", "P04-T01");
  await access(worktree);
  assert.match(await readFile(join(worktree, "AGENTS.md"), "utf8"), /Agent rules/u);

  // The retained worktree is still recoverable by the same attempt identity.
  const recovered = await workspace.inspect({ ...ATTEMPT, taskId: "P04-T01" });
  assert.equal(recovered.state, "ready");
  assert.equal(recovered.location?.path, worktree);
});

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

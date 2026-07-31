import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { ExecutionRefusedError, type ExecutionSummary } from "../src/application/execution.js";
import { WorkerCapabilityError } from "../src/application/worker.js";
import { runExecution } from "../src/commands/run.js";
import { attemptResultPath } from "../src/state/execution.js";
import { readProjectState } from "../src/state/files.js";
import { applyTaskTransition } from "../src/state/transitions.js";
import {
  createBarrier,
  createExecutionProject,
  FakeWorkerRunner,
  FakeWorkspace,
  type WorkerBehaviour,
} from "./fixtures/execution/harness.js";
import type { ProjectSpec, TaskSpec } from "./fixtures/execution/project.js";

const ALPHA: TaskSpec = { id: "P04-T01", title: "Alpha", status: "ready", ownedPaths: ["src/alpha"] };
const BETA: TaskSpec = { id: "P04-T02", title: "Beta", status: "ready", ownedPaths: ["src/beta"] };
const GAMMA: TaskSpec = { id: "P04-T03", title: "Gamma", status: "ready", ownedPaths: ["src/gamma"] };

function spec(overrides: Partial<ProjectSpec> & { readonly tasks: readonly TaskSpec[] }): ProjectSpec {
  return {
    name: "Execution sample",
    approved: true,
    workerAdapter: "claude-cli",
    maxConcurrency: 2,
    ...overrides,
  };
}

function statusOf(state: Awaited<ReturnType<typeof readProjectState>>, taskId: string): string {
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  assert.ok(task, `expected task ${taskId}`);
  return task.status;
}

function deferralFor(summary: ExecutionSummary, taskId: string): { reason: string; detail: string } {
  const record = summary.deferred.find((candidate) => candidate.taskId === taskId);
  assert.ok(record, `expected ${taskId} to be deferred: ${JSON.stringify(summary.deferred)}`);
  return record;
}

test("two disjoint roots run in parallel and never exceed maxConcurrency", async (t) => {
  const project = spec({ tasks: [ALPHA, BETA] });
  const root = await createExecutionProject(t, project);
  const barrier = createBarrier(2);
  const runner = new FakeWorkerRunner(
    {
      "P04-T01": { kind: "completed", changedPaths: ["src/alpha/index.ts"] },
      "P04-T02": { kind: "completed", changedPaths: ["src/beta/index.ts"] },
    },
    { onStart: async () => barrier.arrive() },
  );
  const workspace = new FakeWorkspace(root, {
    changedPaths: { "P04-T01": ["src/alpha/index.ts"], "P04-T02": ["src/beta/index.ts"] },
  });

  const result = await runExecution(root, { mode: "run" }, { runner, workspace, runId: "run-parallel" });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(
    result.summary.records.map((record) => `${record.taskId}:${record.disposition}:${record.status}`),
    ["P04-T01:dispatched:review", "P04-T02:dispatched:review"],
  );
  // The barrier only clears once both workers are inside their model call.
  assert.equal(runner.peakConcurrency, 2);
  assert.ok(runner.peakConcurrency <= project.maxConcurrency);
  assert.deepEqual(runner.startOrder.slice().sort(), ["P04-T01", "P04-T02"]);
  assert.deepEqual(workspace.createdTasks.slice().sort(), ["P04-T01", "P04-T02"]);

  const state = await readProjectState(root);
  assert.equal(statusOf(state, "P04-T01"), "review");
  assert.equal(statusOf(state, "P04-T02"), "review");
  assert.equal(state.tasks.some((task) => task.status === "done"), false, "worker success must never self-accept");
  assert.deepEqual(result.summary.reviewReady, ["P04-T01", "P04-T02"]);
  assert.ok(
    result.lines.includes(
      "Next: `draftforge review` to run machine checks, reviewer judgment, and accepted-work integration.",
    ),
  );
});

test("a third ready root waits for a worker slot instead of overbooking the cap", async (t) => {
  const root = await createExecutionProject(t, spec({ tasks: [ALPHA, BETA, GAMMA], maxConcurrency: 2 }));
  const barrier = createBarrier(2);
  const runner = new FakeWorkerRunner({}, { onStart: async () => barrier.arrive() });
  const workspace = new FakeWorkspace(root);

  const result = await runExecution(root, { mode: "run" }, { runner, workspace, runId: "run-cap" });

  assert.equal(runner.callCount, 2);
  assert.ok(runner.peakConcurrency <= 2);
  assert.equal(result.summary.records.length, 2);
  assert.equal(deferralFor(result.summary, "P04-T03").reason, "capacity");
});

test("ancestor/descendant ownership serializes otherwise-ready tasks", async (t) => {
  const root = await createExecutionProject(t, spec({
    tasks: [
      { id: "P04-T01", title: "Parent", status: "ready", ownedPaths: ["src/app"] },
      { id: "P04-T02", title: "Child", status: "ready", ownedPaths: ["src/app/child.ts"] },
    ],
  }));
  const first = new FakeWorkerRunner({});
  const workspace = new FakeWorkspace(root);

  const one = await runExecution(root, { mode: "run" }, { runner: first, workspace, runId: "run-conflict-1" });
  assert.equal(first.callCount, 1);
  assert.deepEqual(one.summary.records.map((record) => record.taskId), ["P04-T01"]);
  const conflict = deferralFor(one.summary, "P04-T02");
  assert.equal(conflict.reason, "owned-path-conflict");
  assert.match(conflict.detail, /P04-T01/u);

  // The conflicting owner left `active`, so the second root becomes claimable.
  const second = new FakeWorkerRunner({});
  const two = await runExecution(root, { mode: "run" }, { runner: second, workspace, runId: "run-conflict-2" });
  assert.deepEqual(two.summary.records.map((record) => record.taskId), ["P04-T02"]);
  assert.equal(statusOf(await readProjectState(root), "P04-T02"), "review");
});

test("successors stay blocked until a reviewer accepts the predecessor", async (t) => {
  const root = await createExecutionProject(t, spec({
    tasks: [ALPHA, { ...BETA, status: "backlog", dependsOn: ["P04-T01"] }],
  }));
  const workspace = new FakeWorkspace(root);

  const first = await runExecution(
    root,
    { mode: "run" },
    { runner: new FakeWorkerRunner({}), workspace, runId: "run-dep-1" },
  );
  assert.deepEqual(first.summary.records.map((record) => record.taskId), ["P04-T01"]);
  assert.equal(deferralFor(first.summary, "P04-T02").reason, "dependency");

  // `review` is not acceptance: the successor must still be blocked.
  const second = new FakeWorkerRunner({});
  const held = await runExecution(root, { mode: "run" }, { runner: second, workspace, runId: "run-dep-2" });
  assert.equal(second.callCount, 0);
  assert.equal(statusOf(await readProjectState(root), "P04-T01"), "review");
  assert.equal(deferralFor(held.summary, "P04-T02").reason, "dependency");

  // The trusted transition seam stands in for the Phase 5 reviewer.
  await applyTaskTransition(root, {
    taskId: "P04-T01",
    to: "done",
    runId: "run-dep-review",
    actor: "reviewer-simulation",
  });

  const third = new FakeWorkerRunner({});
  const released = await runExecution(root, { mode: "run" }, { runner: third, workspace, runId: "run-dep-3" });
  assert.deepEqual(released.summary.records.map((record) => record.taskId), ["P04-T02"]);
  assert.equal(statusOf(await readProjectState(root), "P04-T02"), "review");
});

test("failure modes block with retained redacted evidence and no duplicate dispatch", async (t) => {
  const cases: readonly {
    readonly name: string;
    readonly behaviour: WorkerBehaviour;
    readonly changedPaths?: readonly string[];
    readonly unsafe?: boolean;
    readonly reason: string;
    readonly assertArtifact?: (artifact: string) => void;
  }[] = [
    {
      name: "malformed worker output",
      behaviour: { kind: "raw", text: "here you go: RAW-SENTINEL-77321 {\"status\":\"completed\"}" },
      reason: "execution-failed",
      assertArtifact: (artifact) => assert.doesNotMatch(artifact, /RAW-SENTINEL-77321/u),
    },
    {
      name: "out-of-scope diff",
      behaviour: { kind: "completed", changedPaths: ["src/alpha/index.ts"] },
      changedPaths: ["src/alpha/index.ts", "src/other/secret.ts"],
      reason: "scope-violation",
      assertArtifact: (artifact) => assert.match(artifact, /src\/other\/secret\.ts/u),
    },
    {
      name: "worker timeout",
      behaviour: {
        kind: "throw",
        error: Object.assign(new Error("TIMEOUT-SENTINEL-51900"), {
          timedOut: true,
          definitelyTerminated: true,
        }),
      },
      reason: "execution-failed",
      assertArtifact: (artifact) => assert.doesNotMatch(artifact, /TIMEOUT-SENTINEL-51900/u),
    },
    {
      name: "interrupted worktree",
      behaviour: { kind: "completed" },
      unsafe: true,
      reason: "execution-failed",
      assertArtifact: (artifact) => assert.match(artifact, /workspace setup failed/iu),
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async (inner) => {
      const root = await createExecutionProject(inner, spec({ tasks: [ALPHA] }));
      const runner = new FakeWorkerRunner({ "P04-T01": scenario.behaviour });
      const workspace = new FakeWorkspace(root, {
        ...(scenario.changedPaths === undefined
          ? {}
          : { changedPaths: { "P04-T01": scenario.changedPaths } }),
        ...(scenario.unsafe === true ? { unsafeTasks: ["P04-T01"] } : {}),
      });

      const result = await runExecution(root, { mode: "run" }, { runner, workspace, runId: "run-fail" });

      assert.equal(result.exitCode, 1);
      assert.deepEqual(result.summary.records.map((record) => record.status), ["blocked"]);
      assert.deepEqual(result.summary.blocked, ["P04-T01"]);

      const state = await readProjectState(root);
      const attempt = state.tasks[0]?.attempt;
      assert.ok(attempt);
      const artifact = await readFile(resolve(root, attemptResultPath(attempt)), "utf8");
      assert.match(artifact, new RegExp(`"reason": "${scenario.reason}"`, "u"));
      scenario.assertArtifact?.(artifact);

      // A blocked task is terminal: a second invocation must not dispatch again.
      const again = new FakeWorkerRunner({});
      const repeat = await runExecution(root, { mode: "run" }, { runner: again, workspace, runId: "run-fail-2" });
      assert.equal(again.callCount, 0);
      assert.equal(repeat.summary.records.length, 0);
    });
  }
});

test("uncertain worker termination preserves the attempt and refuses a live redispatch", async (t) => {
  const root = await createExecutionProject(t, spec({ tasks: [ALPHA], maxConcurrency: 1 }));
  const runner = new FakeWorkerRunner({
    "P04-T01": {
      kind: "throw",
      error: Object.assign(new Error("UNCERTAIN-SENTINEL-30188"), {
        processId: 40123,
        definitelyTerminated: false,
      }),
    },
  });
  const workspace = new FakeWorkspace(root, { liveness: "unknown" });

  const first = await runExecution(root, { mode: "run" }, { runner, workspace, runId: "run-uncertain" });
  assert.deepEqual(first.summary.records.map((record) => `${record.taskId}:${record.status}`), ["P04-T01:active"]);
  assert.equal(statusOf(await readProjectState(root), "P04-T01"), "active");

  const eventLog = await readFile(
    resolve(root, ".draftforge/runs/run-uncertain/attempts", `${first.summary.records[0]?.attempt.attemptId}.events.jsonl`),
    "utf8",
  );
  assert.match(eventLog, /"processId":40123/u);
  assert.doesNotMatch(eventLog, /UNCERTAIN-SENTINEL-30188/u);

  // `run` treats the unfinished attempt as occupied capacity.
  const idle = new FakeWorkerRunner({});
  const second = await runExecution(root, { mode: "run" }, { runner: idle, workspace, runId: "run-uncertain-2" });
  assert.equal(idle.callCount, 0);
  assert.equal(deferralFor(second.summary, "P04-T01").reason, "in-flight");

  // `resume` refuses while the worker process is not provably gone.
  const resumeRunner = new FakeWorkerRunner({});
  const resumed = await runExecution(
    root,
    { mode: "resume" },
    { runner: resumeRunner, workspace, runId: "run-uncertain-3" },
  );
  assert.equal(resumeRunner.callCount, 0);
  assert.deepEqual(workspace.livenessProbes, [40123]);
  assert.equal(deferralFor(resumed.summary, "P04-T01").reason, "worker-process-live");
});

test("run and resume refuse an unapproved plan before any task state changes", async (t) => {
  for (const mode of ["run", "resume"] as const) {
    const root = await createExecutionProject(t, spec({ tasks: [ALPHA], approved: false }));
    const runner = new FakeWorkerRunner({});
    const workspace = new FakeWorkspace(root);

    await assert.rejects(
      runExecution(root, { mode }, { runner, workspace, runId: "run-unapproved" }),
      ExecutionRefusedError,
    );
    assert.equal(runner.callCount, 0);
    assert.equal(statusOf(await readProjectState(root), "P04-T01"), "ready");
    await assert.rejects(access(resolve(root, ".draftforge", "runs")));
  }
});

test("run and resume refuse a text-only worker route before any task state changes", async (t) => {
  for (const mode of ["run", "resume"] as const) {
    const root = await createExecutionProject(t, spec({ tasks: [ALPHA], workerAdapter: "openai-api" }));
    const runner = new FakeWorkerRunner({}, { workspaceAccess: false });
    const workspace = new FakeWorkspace(root);

    await assert.rejects(
      runExecution(root, { mode }, { runner, workspace, runId: "run-api" }),
      WorkerCapabilityError,
    );
    assert.equal(runner.callCount, 0);
    assert.equal(statusOf(await readProjectState(root), "P04-T01"), "ready");
    await assert.rejects(access(resolve(root, ".draftforge", "runs")));
  }
});

test("a project with nothing schedulable reports no work rather than failing", async (t) => {
  const root = await createExecutionProject(t, spec({
    tasks: [{ ...ALPHA, status: "done" }, { ...BETA, status: "review" }],
  }));
  const runner = new FakeWorkerRunner({});

  const result = await runExecution(
    root,
    { mode: "run" },
    { runner, workspace: new FakeWorkspace(root), runId: "run-idle" },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(runner.callCount, 0);
  assert.equal(result.summary.records.length, 0);
  assert.deepEqual(result.summary.reviewReady, ["P04-T02"]);
  assert.ok(result.lines.includes("No work: nothing was dispatched, resumed, or reconciled."));
  assert.ok(result.lines.some((line) => line.startsWith("Dispatched: none")));
  assert.ok(result.lines.some((line) => line.startsWith("Review-ready: P04-T02")));
});

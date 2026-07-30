import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { ModelRequest, ModelRunner } from "../src/application/ports.js";
import type { ClaimedTaskAttempt } from "../src/application/scheduler.js";
import type { TaskContract } from "../src/application/task-contract.js";
import type {
  WorkspaceAttempt,
  WorkspaceInspection,
  WorkspaceLocation,
  WorkspacePort,
} from "../src/application/workspace.js";
import {
  assertWorkspaceCapableWorkerRoute,
  changedPathScopeViolations,
  executeClaimedWorker,
  parseWorkerResult,
  StaleWorkerClaimError,
  WorkerCapabilityError,
} from "../src/application/worker.js";
import type { ExecutionAttemptManifest } from "../src/domain/execution.js";
import { PROJECT_STATE_SCHEMA_VERSION, type ProjectState } from "../src/domain/state.js";
import {
  attemptResultPath,
  attemptEventPath,
  createExecutionAttemptManifest,
  hashTaskContract,
  readExecutionAttemptManifest,
  writeAttemptResult,
  writeExecutionAttemptManifest,
} from "../src/state/execution.js";
import { readProjectState, writeProjectState, writeSession } from "../src/state/files.js";

const NOW = new Date("2026-07-26T12:00:00.000Z");
const REFERENCE = { runId: "run-01", attemptId: "attempt-01" };
const CONTRACT: TaskContract = {
  id: "P04-T03",
  title: "Worker",
  objective: "Implement worker.",
  ownedPaths: ["src/worker.ts", "src/owned"],
  requiredContext: [],
  relevantAdrs: [],
  dependsOn: [],
  acceptanceCriteria: ["Pass."],
  verification: ["npm test"],
  exclusions: [],
  budget: { timeMinutes: 3 },
};
const TASK_CONTENT = `# P04-T03 — Worker

## Objective

Implement worker.

## Owned paths

- src/worker.ts
- src/owned

## Required context

- None

## Relevant ADRs

- None

## Dependencies

- None

## Acceptance criteria

- Pass.

## Verification

- npm test

## Exclusions

- None

## Budget

- timeMinutes: 3
`;

test("preflight rejects a text-only worker before claim, filesystem, or model side effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "draftforge-worker-preflight-"));
  let modelCalls = 0;
  const runner: ModelRunner = {
    capabilities: () => ({ workspaceAccess: false }),
    async run() {
      modelCalls += 1;
      return { text: "{}" };
    },
  };
  let claimCalls = 0;

  try {
    assert.throws(() => {
      assertWorkspaceCapableWorkerRoute(runner);
      claimCalls += 1;
    }, WorkerCapabilityError);
    assert.equal(claimCalls, 0);
    assert.equal(modelCalls, 0);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("strict worker result parser rejects prose, unknown/nested fields, unsafe paths, and stale identities", () => {
  const valid = workerResult();
  assert.deepEqual(parseWorkerResult(JSON.stringify(valid), REFERENCE_IDENTITY), valid);
  assert.throws(
    () => parseWorkerResult(`result: ${JSON.stringify(valid)}`, REFERENCE_IDENTITY),
    /not valid JSON/u,
  );
  assert.throws(
    () => parseWorkerResult(JSON.stringify({ ...valid, extra: true }), REFERENCE_IDENTITY),
    /unsupported property/u,
  );
  assert.throws(
    () => parseWorkerResult(JSON.stringify({
      ...valid,
      commandsRun: [{ ...valid.commandsRun[0], extra: true }],
    }), REFERENCE_IDENTITY),
    /unsupported property/u,
  );
  assert.throws(
    () => parseWorkerResult(JSON.stringify({ ...valid, changedPaths: ["../outside.ts"] }), REFERENCE_IDENTITY),
    /repository-relative/u,
  );
  assert.throws(
    () => parseWorkerResult(JSON.stringify({ ...valid, changedPaths: ["/outside.ts"] }), REFERENCE_IDENTITY),
    /repository-relative/u,
  );
  assert.throws(
    () => parseWorkerResult(JSON.stringify({ ...valid, attemptId: "attempt-old" }), REFERENCE_IDENTITY),
    /identity is stale/u,
  );
});

test("authoritative scope detects unowned rename sides and scheduler control paths", () => {
  assert.deepEqual(
    changedPathScopeViolations(
      [
        "src/owned/new-name.ts",
        "legacy/old-name.ts",
        ".draftforge/state.json",
        "SESSION.md",
      ],
      CONTRACT,
    ),
    ["legacy/old-name.ts", ".draftforge/state.json", "SESSION.md"],
  );
  assert.deepEqual(
    changedPathScopeViolations([".DRAFTFORGE/CONFIG.LOCAL.JSON"], CONTRACT, false),
    [".DRAFTFORGE/CONFIG.LOCAL.JSON"],
  );
});

test("completed result persists redacted evidence then moves active to review without trusting reported paths", async () => {
  await withWorkerFixture(async ({ root, worktree, claimed }) => {
    const secret = "worker-environment-secret-12345";
    const response = workerResult({
      summary: `implemented with ${secret}`,
      changedPaths: ["reported/not-authoritative.ts"],
      evidence: [`tests passed with ${secret}`],
      suggestedFollowUps: ["Create an unrelated task automatically"],
    });
    const runner = fakeRunner(JSON.stringify(response));
    const workspace = new FakeWorkspace(worktree, ["src/worker.ts"]);

    const outcome = await executeClaimedWorker({
      root,
      claimed,
      runner,
      workspace,
      actor: "worker-test",
      now: NOW,
      env: { CUSTOM_SECRET: secret },
    });

    assert.equal(runner.requests.length, 1);
    assert.equal(runner.requests[0]?.workingDirectory, worktree);
    assert.equal(runner.requests[0]?.retryPolicy, "none");
    assert.equal(runner.requests[0]?.timeoutMs, 180_000);
    assert.equal(outcome.transition, "review");
    assert.deepEqual(outcome.authoritativeChangedPaths, ["src/worker.ts"]);
    assert.deepEqual(workspace.changedPathBases, ["b".repeat(40)]);
    assert.deepEqual(outcome.result?.changedPaths, ["reported/not-authoritative.ts"]);
    const state = await readProjectState(root);
    assert.equal(taskState(state).status, "review");
    assert.equal(state.tasks.length, 1, "suggested follow-ups must not expand canonical tasks");
    const manifest = await readExecutionAttemptManifest(root, REFERENCE);
    assert.equal(manifest.lifecycle, "review");
    assert.equal(manifest.evidence.result, attemptResultPath(REFERENCE));
    const artifact = await readFile(resolve(root, attemptResultPath(REFERENCE)), "utf8");
    assert.doesNotMatch(artifact, new RegExp(secret, "u"));
    assert.match(artifact, /\[REDACTED\]/u);
    assert.doesNotMatch(artifact, /rawModelText|provider credentials/iu);
    assert.match(artifact, /Create an unrelated task automatically/u);
    const events = await readFile(resolve(root, ".draftforge/runs/run-01/events.jsonl"), "utf8");
    assert.match(events, new RegExp(attemptResultPath(REFERENCE).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  });
});

test("max-length attempt IDs still persist the attempt-scoped worker result event", async () => {
  const reference = { runId: "run-01", attemptId: "a".repeat(128) };
  await withWorkerFixture(async ({ root, worktree, claimed }) => {
    const outcome = await executeClaimedWorker({
      root,
      claimed,
      runner: fakeRunner(JSON.stringify(workerResult({ attemptId: reference.attemptId }))),
      workspace: new FakeWorkspace(worktree, ["src/worker.ts"]),
      actor: "worker-test",
      now: NOW,
      env: {},
    });

    assert.equal(outcome.transition, "review");
    const eventLog = await readFile(resolve(root, attemptEventPath(reference)), "utf8");
    assert.match(eventLog, /"id":"worker-result"/u);
  }, reference);
});

test("blocked, malformed, transient, and scope-violating outcomes move only to blocked", async (t) => {
  await t.test("worker-reported blocked", async () => {
    await assertBlocked(workerResult({ status: "blocked", summary: "Need architecture decision." }), []);
  });
  await t.test("malformed JSON", async () => {
    await withWorkerFixture(async ({ root, worktree, claimed }) => {
      const sentinel = "RAW-MODEL-SENTINEL-984317";
      const outcome = await executeClaimedWorker({
        root,
        claimed,
        runner: fakeRunner(`not-json-${sentinel}`),
        workspace: new FakeWorkspace(worktree, []),
        actor: "worker-test",
        now: NOW,
        env: {},
      });
      assert.equal(outcome.transition, "blocked");
      for (const path of [
        attemptResultPath(REFERENCE),
        ".draftforge/runs/run-01/attempts/attempt-01.events.jsonl",
        ".draftforge/runs/run-01/attempts/attempt-01.json",
        ".draftforge/runs/run-01/events.jsonl",
      ]) {
        assert.doesNotMatch(await readFile(resolve(root, path), "utf8"), new RegExp(sentinel, "u"));
      }
    });
  });
  await t.test("transient adapter failure is one application call", async () => {
    await withWorkerFixture(async ({ root, worktree, claimed }) => {
      let calls = 0;
      const sentinel = "RAW-PROVIDER-CAUSE-42179";
      const runner: ModelRunner = {
        capabilities: () => ({ workspaceAccess: true }),
        async run() {
          calls += 1;
          throw new Error(`temporary transport failure ${sentinel}`);
        },
      };
      const outcome = await executeClaimedWorker({
        root,
        claimed,
        runner,
        workspace: new FakeWorkspace(worktree, ["src/worker.ts"]),
        actor: "worker-test",
        now: NOW,
        env: {},
      });
      assert.equal(calls, 1);
      assert.equal(outcome.transition, "blocked");
      assert.equal(taskState(await readProjectState(root)).status, "blocked");
      assert.doesNotMatch(
        await readFile(resolve(root, attemptResultPath(REFERENCE)), "utf8"),
        new RegExp(sentinel, "u"),
      );
    });
  });
  await t.test("unowned and ignored control changes", async () => {
    await withWorkerFixture(async ({ root, worktree, claimed }) => {
      await mkdir(join(worktree, ".draftforge", "runs"), { recursive: true });
      await writeFile(join(worktree, ".draftforge", "config.local.json"), "{}", "utf8");
      const outcome = await executeClaimedWorker({
        root,
        claimed,
        runner: fakeRunner(JSON.stringify(workerResult())),
        workspace: new FakeWorkspace(worktree, ["src/outside.ts", ".draftforge/state.json"]),
        actor: "worker-test",
        now: NOW,
        env: {},
      });
      assert.equal(outcome.transition, "blocked");
      assert.deepEqual(outcome.scopeViolations, [
        ".draftforge/state.json",
        "src/outside.ts",
        ".draftforge/runs",
        ".draftforge/config.local.json",
      ]);
      assert.equal(taskState(await readProjectState(root)).status, "blocked");
    });
  });
});

test("stale state or task contracts stop before workspace and model side effects", async (t) => {
  await t.test("attempt identity changed", async () => {
    await withWorkerFixture(async ({ root, worktree, claimed }) => {
      const state = await readProjectState(root);
      const stale: ProjectState = {
        ...state,
        tasks: state.tasks.map((task) => task.id === CONTRACT.id
          ? { ...task, attempt: { runId: "run-02", attemptId: "attempt-02" } }
          : task),
      };
      await writeProjectState(root, stale);
      await writeSession(root, stale);
      const workspace = new FakeWorkspace(worktree, []);
      const runner = fakeRunner(JSON.stringify(workerResult()));

      await assert.rejects(
        executeClaimedWorker({
          root,
          claimed,
          runner,
          workspace,
          actor: "worker-test",
          now: NOW,
          env: {},
        }),
        StaleWorkerClaimError,
      );
      assert.equal(workspace.createCalls, 0);
      assert.equal(runner.requests.length, 0);
    });
  });

  await t.test("task contents changed", async () => {
    await withWorkerFixture(async ({ root, worktree, claimed }) => {
      await writeFile(resolve(root, claimed.task.taskFile), `${TASK_CONTENT}\nchanged\n`, "utf8");
      const workspace = new FakeWorkspace(worktree, []);
      const runner = fakeRunner(JSON.stringify(workerResult()));

      await assert.rejects(
        executeClaimedWorker({
          root,
          claimed,
          runner,
          workspace,
          actor: "worker-test",
          now: NOW,
          env: {},
        }),
        StaleWorkerClaimError,
      );
      assert.equal(workspace.createCalls, 0);
      assert.equal(runner.requests.length, 0);
    });
  });

  await t.test("pre-model contract race", async () => {
    await withWorkerFixture(async ({ root, worktree, claimed }) => {
      const workspace = new FakeWorkspace(worktree, [], undefined, async () => {
        await writeFile(resolve(root, claimed.task.taskFile), `${TASK_CONTENT}\nraced\n`, "utf8");
      });
      const runner = fakeRunner(JSON.stringify(workerResult()));

      await assert.rejects(
        executeClaimedWorker({
          root,
          claimed,
          runner,
          workspace,
          actor: "worker-test",
          now: NOW,
          env: {},
        }),
        StaleWorkerClaimError,
      );
      assert.equal(workspace.createCalls, 1);
      assert.equal(runner.requests.length, 0);
      assert.equal(taskState(await readProjectState(root)).status, "active");
      assert.equal((await readExecutionAttemptManifest(root, REFERENCE)).lifecycle, "running");
    });
  });
});

test("uncertain worker termination records PID evidence but preserves the resumable attempt", async () => {
  await withWorkerFixture(async ({ root, worktree, claimed }) => {
    let calls = 0;
    const runner: ModelRunner = {
      capabilities: () => ({ workspaceAccess: true }),
      async run(request) {
        calls += 1;
        request.onProcessStart?.({ processId: 4312 });
        throw Object.assign(new Error("timeout sentinel must not persist"), {
          timedOut: true,
          processId: 4312,
          definitelyTerminated: false,
        });
      },
    };
    const workspace = new FakeWorkspace(worktree, ["src/outside.ts"]);

    const outcome = await executeClaimedWorker({
      root,
      claimed,
      runner,
      workspace,
      actor: "worker-test",
      now: NOW,
      env: {},
    });

    assert.equal(outcome.transition, "active");
    assert.equal(calls, 1);
    assert.equal(workspace.createCalls, 1);
    assert.equal(workspace.changedPathCalls, 0, "uncertain termination must not inspect a live workspace");
    assert.equal(taskState(await readProjectState(root)).status, "active");
    const manifest = await readExecutionAttemptManifest(root, REFERENCE);
    assert.equal(manifest.lifecycle, "running");
    assert.equal(manifest.evidence.result, null);
    const event = await readFile(resolve(root, attemptEventPath(REFERENCE)), "utf8");
    assert.match(event, /worker\.termination-uncertain/u);
    assert.match(event, /"processId":4312/u);
    assert.doesNotMatch(event, /timeout sentinel/u);

    const recovered = await writeAttemptResult(root, REFERENCE, { final: true }, {});
    assert.equal(recovered.evidence.result, attemptResultPath(REFERENCE));
  });
});

test("short configured secrets are scrubbed from every worker run artifact", async () => {
  await withWorkerFixture(async ({ root, worktree, claimed }) => {
    const secret = "xy";
    const response = workerResult({
      summary: `summary-${secret}`,
      changedPaths: [`src/${secret}.ts`],
      commandsRun: [{ command: `check-${secret}`, exitCode: 0, summary: `ok-${secret}` }],
      evidence: [`evidence-${secret}`],
      risks: [`risk-${secret}`],
      suggestedFollowUps: [`follow-${secret}`],
    });
    await executeClaimedWorker({
      root,
      claimed,
      runner: fakeRunner(JSON.stringify(response)),
      workspace: new FakeWorkspace(worktree, ["src/worker.ts"]),
      actor: `actor-${secret}`,
      now: NOW,
      env: { SHORT_SECRET: secret },
    });

    const artifacts = await Promise.all([
      readFile(resolve(root, attemptResultPath(REFERENCE)), "utf8"),
      readFile(resolve(root, attemptEventPath(REFERENCE)), "utf8"),
      readFile(resolve(root, ".draftforge/runs/run-01/events.jsonl"), "utf8"),
      readFile(resolve(root, ".draftforge/runs/run-01/attempts/attempt-01.json"), "utf8"),
    ]);
    for (const artifact of artifacts) {
      assert.doesNotMatch(artifact, new RegExp(secret, "u"));
    }
    assert.match(artifacts.join("\n"), /\[REDACTED\]/u);
  });
});

test("evidence persistence conflict rejects and leaves canonical task active", async () => {
  await withWorkerFixture(async ({ root, worktree, claimed }) => {
    const resultPath = resolve(root, attemptResultPath(REFERENCE));
    await mkdir(resolve(resultPath, ".."), { recursive: true });
    await writeFile(resultPath, '{"different":true}\n', "utf8");

    await assert.rejects(
      executeClaimedWorker({
        root,
        claimed,
        runner: fakeRunner(JSON.stringify(workerResult())),
        workspace: new FakeWorkspace(worktree, ["src/worker.ts"]),
        actor: "worker-test",
        now: NOW,
        env: {},
      }),
      /already exists with different contents/u,
    );
    assert.equal(taskState(await readProjectState(root)).status, "active");
    assert.equal((await readExecutionAttemptManifest(root, REFERENCE)).lifecycle, "running");
  });
});

test("event persistence failure after atomic result write remains active and reconcilable", async () => {
  await withWorkerFixture(async ({ root, worktree, claimed }) => {
    const eventPath = resolve(root, attemptEventPath(REFERENCE));
    await mkdir(eventPath, { recursive: true });

    await assert.rejects(
      executeClaimedWorker({
        root,
        claimed,
        runner: fakeRunner(JSON.stringify(workerResult())),
        workspace: new FakeWorkspace(worktree, ["src/worker.ts"]),
        actor: "worker-test",
        now: NOW,
        env: {},
      }),
    );
    const state = await readProjectState(root);
    assert.equal(taskState(state).status, "active");
    const manifest = await readExecutionAttemptManifest(root, REFERENCE);
    assert.equal(manifest.lifecycle, "running");
    assert.equal(manifest.evidence.result, attemptResultPath(REFERENCE));
    assert.match(await readFile(resolve(root, attemptResultPath(REFERENCE)), "utf8"), /"outcome": "review"/u);
  });
});

test("transition rechecks attempt identity and cannot apply a stale worker result", async () => {
  await withWorkerFixture(async ({ root, worktree, claimed }) => {
    const workspace = new FakeWorkspace(worktree, ["src/worker.ts"], async () => {
      const state = await readProjectState(root);
      const changed: ProjectState = {
        ...state,
        tasks: state.tasks.map((task) => task.id === CONTRACT.id
          ? { ...task, attempt: { runId: "run-02", attemptId: "attempt-02" } }
          : task),
      };
      await writeProjectState(root, changed);
      await writeSession(root, changed);
    });

    await assert.rejects(
      executeClaimedWorker({
        root,
        claimed,
        runner: fakeRunner(JSON.stringify(workerResult())),
        workspace,
        actor: "worker-test",
        now: NOW,
        env: {},
      }),
      /no longer owns attempt/u,
    );
    const state = await readProjectState(root);
    assert.equal(taskState(state).status, "active");
    assert.deepEqual(taskState(state).attempt, { runId: "run-02", attemptId: "attempt-02" });
  });
});

test("accepts a resumed running manifest whose base commit matches the recovered workspace", async () => {
  const runningBaseCommit = "b".repeat(40);
  await withWorkerFixture(
    async ({ root, worktree, claimed }) => {
      const outcome = await executeClaimedWorker({
        root,
        claimed,
        runner: fakeRunner(JSON.stringify(workerResult())),
        workspace: new FakeWorkspace(worktree, ["src/worker.ts"]),
        actor: "worker-test",
        now: NOW,
        env: {},
      });
      assert.equal(outcome.transition, "review");
      assert.equal(taskState(await readProjectState(root)).status, "review");
    },
    REFERENCE,
    { lifecycle: "running", baseCommit: runningBaseCommit },
  );
});

test("rejects a running manifest with no recorded base commit before any side effect", async () => {
  await withWorkerFixture(
    async ({ root, worktree, claimed }) => {
      await assert.rejects(
        executeClaimedWorker({
          root,
          claimed,
          runner: fakeRunner(JSON.stringify(workerResult())),
          workspace: new FakeWorkspace(worktree, ["src/worker.ts"]),
          actor: "worker-test",
          now: NOW,
          env: {},
        }),
        /running attempt manifest to carry a base commit/,
      );
      assert.equal(taskState(await readProjectState(root)).status, "active");
    },
    REFERENCE,
    { lifecycle: "running", baseCommit: null },
  );
});

test("a running manifest whose base commit disagrees with the recovered workspace is a hard error, not a silent overwrite", async () => {
  await withWorkerFixture(
    async ({ root, worktree, claimed }) => {
      const outcome = await executeClaimedWorker({
        root,
        claimed,
        runner: fakeRunner(JSON.stringify(workerResult())),
        workspace: new FakeWorkspace(worktree, ["src/worker.ts"]),
        actor: "worker-test",
        now: NOW,
        env: {},
      });
      // The recovered workspace reports "b".repeat(40); the manifest disagrees.
      assert.equal(outcome.transition, "blocked");
      assert.equal(taskState(await readProjectState(root)).status, "blocked");
      const manifest = await readExecutionAttemptManifest(root, REFERENCE);
      assert.equal(manifest.lifecycle, "blocked");
      assert.equal(manifest.baseCommit, "c".repeat(40));
    },
    REFERENCE,
    { lifecycle: "running", baseCommit: "c".repeat(40) },
  );
});

async function assertBlocked(
  result: ReturnType<typeof workerResult> | string,
  changedPaths: readonly string[],
): Promise<void> {
  await withWorkerFixture(async ({ root, worktree, claimed }) => {
    const raw = typeof result === "string" ? result : JSON.stringify(result);
    const outcome = await executeClaimedWorker({
      root,
      claimed,
      runner: fakeRunner(raw),
      workspace: new FakeWorkspace(worktree, changedPaths),
      actor: "worker-test",
      now: NOW,
      env: {},
    });
    assert.equal(outcome.transition, "blocked");
    assert.equal(taskState(await readProjectState(root)).status, "blocked");
    assert.equal((await readExecutionAttemptManifest(root, REFERENCE)).lifecycle, "blocked");
  });
}

async function withWorkerFixture(
  run: (fixture: { readonly root: string; readonly worktree: string; readonly claimed: ClaimedTaskAttempt }) => Promise<void>,
  reference = REFERENCE,
  manifestOverrides: Partial<ExecutionAttemptManifest> = {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "draftforge-worker-"));
  const worktree = join(root, "worktree");
  try {
    await mkdir(worktree, { recursive: true });
    await writeFile(join(worktree, "AGENTS.md"), "bounded rules", "utf8");
    await mkdir(resolve(root, ".draftforge", "tasks"), { recursive: true });
    await writeFile(resolve(root, ".draftforge", "tasks", "P04-T03.md"), TASK_CONTENT, "utf8");
    const manifest = {
      ...createExecutionAttemptManifest({
        reference,
        taskId: CONTRACT.id,
        contractHash: hashTaskContract(TASK_CONTENT),
        now: NOW,
        budget: { timeMinutes: 3 },
      }),
      ...manifestOverrides,
    };
    await writeExecutionAttemptManifest(root, manifest);
    const state = workerState(reference);
    await writeProjectState(root, state);
    await writeSession(root, state);
    const claimed: ClaimedTaskAttempt = {
      task: taskState(state),
      contract: CONTRACT,
      manifest,
    };
    await run({ root, worktree, claimed });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function workerState(reference = REFERENCE): ProjectState {
  return {
    schemaVersion: PROJECT_STATE_SCHEMA_VERSION,
    project: { name: "Worker test", draftFile: "idea.md" },
    workflow: {
      phaseId: "phase-04",
      phaseName: "Execution",
      stage: "implementation",
      status: "in_progress",
      currentTask: CONTRACT.id,
      nextTask: null,
    },
    phases: [{ id: "phase-04", name: "Execution", status: "in_progress" }],
    tasks: [{
      id: CONTRACT.id,
      title: CONTRACT.title,
      status: "active",
      taskFile: ".draftforge/tasks/P04-T03.md",
      dependsOn: [],
      attempt: reference,
      review: null,
    }],
    decisions: [],
    handoff: {
      updatedAt: NOW.toISOString(),
      updatedBy: "test",
      summary: "",
      decisionsLocked: [],
      openQuestions: [],
      blockers: [],
      nextActions: [],
      gotchas: [],
    },
  };
}

function taskState(state: ProjectState): ProjectState["tasks"][number] {
  const task = state.tasks.find((candidate) => candidate.id === CONTRACT.id);
  assert.ok(task);
  return task;
}

function workerResult(
  overrides: Partial<{
    readonly status: "completed" | "blocked";
    readonly summary: string;
    readonly changedPaths: readonly string[];
    readonly evidence: readonly string[];
    readonly suggestedFollowUps: readonly string[];
    readonly attemptId: string;
    readonly commandsRun: readonly {
      readonly command: string;
      readonly exitCode: number | null;
      readonly summary: string;
    }[];
    readonly risks: readonly string[];
  }> = {},
) {
  return {
    taskId: CONTRACT.id,
    attemptId: overrides.attemptId ?? REFERENCE.attemptId,
    status: overrides.status ?? "completed",
    summary: overrides.summary ?? "Implemented.",
    changedPaths: overrides.changedPaths ?? ["src/worker.ts"],
    commandsRun: overrides.commandsRun ?? [{ command: "npm test", exitCode: 0, summary: "Tests passed." }],
    evidence: overrides.evidence ?? ["Tests passed."],
    risks: overrides.risks ?? [],
    suggestedFollowUps: overrides.suggestedFollowUps ?? [],
  } as const;
}

const REFERENCE_IDENTITY = { taskId: CONTRACT.id, attemptId: REFERENCE.attemptId };

function fakeRunner(text: string): ModelRunner & { readonly requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    capabilities: () => ({ workspaceAccess: true }),
    async run(request) {
      requests.push(request);
      return { text };
    },
  };
}

class FakeWorkspace implements WorkspacePort {
  readonly #worktree: string;
  readonly #changedPaths: readonly string[];
  readonly #beforeChangedPaths: (() => Promise<void>) | undefined;
  readonly #beforeCreate: (() => Promise<void>) | undefined;
  createCalls = 0;
  changedPathCalls = 0;
  readonly changedPathBases: Array<string | undefined> = [];

  constructor(
    worktree: string,
    changedPaths: readonly string[],
    beforeChangedPaths?: () => Promise<void>,
    beforeCreate?: () => Promise<void>,
  ) {
    this.#worktree = worktree;
    this.#changedPaths = changedPaths;
    this.#beforeChangedPaths = beforeChangedPaths;
    this.#beforeCreate = beforeCreate;
  }

  async createOrRecover(attempt: WorkspaceAttempt): Promise<WorkspaceLocation> {
    this.createCalls += 1;
    await this.#beforeCreate?.();
    return {
      attempt,
      path: this.#worktree,
      branch: "draftforge/run-01/p04-t03/attempt-01",
      baseCommit: "b".repeat(40),
    };
  }

  async inspect(attempt: WorkspaceAttempt): Promise<WorkspaceInspection> {
    return {
      state: "ready",
      location: await this.createOrRecover(attempt),
      dirty: this.#changedPaths.length > 0,
      changedPaths: this.#changedPaths,
      reason: undefined,
    };
  }

  async changedPaths(
    _attempt: WorkspaceAttempt,
    expectedBaseCommit?: string,
  ): Promise<readonly string[]> {
    this.changedPathCalls += 1;
    this.changedPathBases.push(expectedBaseCommit);
    await this.#beforeChangedPaths?.();
    return this.#changedPaths;
  }

  async processLiveness(): Promise<"not-found"> {
    return "not-found";
  }

  async cleanup(): Promise<{ readonly outcome: "removed" }> {
    return { outcome: "removed" };
  }
}

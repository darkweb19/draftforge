import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  createPlanningArtifact,
  submitPlan,
} from "../src/application/planning.js";
import type { ModelRequest, ModelRunner } from "../src/application/ports.js";
import { runInit } from "../src/commands/init.js";
import { runPlan } from "../src/commands/plan.js";
import type { PlanningPlan } from "../src/domain/planning.js";
import { readProjectState } from "../src/state/files.js";
import { inspectProjectHealth } from "../src/state/health.js";
import {
  readPlanningArtifact,
  writePlanningArtifact,
} from "../src/state/planning.js";
import { applyTaskTransition } from "../src/state/transitions.js";

const plan: PlanningPlan = {
  revision: 1,
  assumptions: [],
  decisions: [
    {
      id: "ADR-001",
      title: "Runtime",
      adrFile: "docs/decisions/0001-runtime.md",
      context: "The project needs a runtime.",
      decision: "Use Node.js.",
      consequences: ["Node.js must be installed."],
    },
  ],
  phases: [
    {
      id: "phase-01",
      name: "Foundation",
      objective: "Create the foundation.",
      exitCriteria: ["Checks pass."],
    },
  ],
  tasks: [
    {
      id: "P01-T01",
      title: "Create foundation",
      phaseId: "phase-01",
      objective: "Create the foundation.",
      dependsOn: [],
      ownedPaths: ["src/"],
      requiredContext: [],
      relevantAdrs: ["docs/decisions/0001-runtime.md"],
      acceptanceCriteria: ["The foundation exists."],
      verification: ["npm test"],
      exclusions: [],
    },
  ],
  risks: [],
  verification: ["npm test"],
};

test("plan run drives exactly one architect turn and records its response", async () => {
  const root = await mkdtemp(join(tmpdir(), "draftforge-plan-run-"));
  try {
    await runInit(root, { name: "Sample" });
    await runPlan(root, { mode: "start", sourceFile: "idea.md" });
    const requests: ModelRequest[] = [];
    const runner: ModelRunner = {
      async run(request) {
        requests.push(request);
        return {
          text: JSON.stringify({
            kind: "questions",
            questions: {
              revision: 1,
              items: [
                {
                  id: "Q1",
                  prompt: "Which runtime should the project use?",
                  blocking: true,
                  answer: null,
                },
              ],
            },
          }),
        };
      },
    };

    const result = await runPlan(root, { mode: "run" }, { runner });

    assert.equal(result.mode, "run");
    assert.equal(result.applied, "questions");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.role, "architect");
    assert.equal(result.artifact.questions.items[0]?.id, "Q1");
    assert.deepEqual(await readPlanningArtifact(root), result.artifact);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plan command approval publishes consent before runnable state and is retryable", async () => {
  const root = await mkdtemp(join(tmpdir(), "draftforge-plan-command-"));
  try {
    await runInit(root, { name: "Sample" });
    const draft = submitPlan(createPlanningArtifact("idea.md"), plan);
    await writePlanningArtifact(root, draft);

    const approved = await runPlan(root, {
      mode: "approve",
      approvedBy: "sujan",
      now: new Date("2026-02-01T00:00:00.000Z"),
    });
    assert.equal(approved.mode, "approve");
    assert.deepEqual(approved.readyTaskIds, ["P01-T01"]);
    assert.equal((await readPlanningArtifact(root)).status, "approved");
    assert.equal((await readProjectState(root)).tasks[0]?.status, "ready");
    assert.ok((await inspectProjectHealth(root)).every((check) => check.status === "pass"));
    assert.match(
      await readFile(resolve(root, ".draftforge/tasks/P01-T01.md"), "utf8"),
      /## Owned paths/,
    );
    assert.match(
      await readFile(resolve(root, "docs/decisions/0001-runtime.md"), "utf8"),
      /## Decision/,
    );
    assert.match(await readFile(resolve(root, "PHASES.md"), "utf8"), /## phase-01/);

    await applyTaskTransition(root, {
      taskId: "P01-T01",
      to: "active",
      runId: "retry-preserves-progress",
      actor: "worker",
      now: new Date("2026-02-01T00:01:00.000Z"),
    });

    const retried = await runPlan(root, {
      mode: "approve",
      approvedBy: "different-actor",
      now: new Date("2026-03-01T00:00:00.000Z"),
    });
    assert.equal(retried.mode, "approve");
    assert.deepEqual(retried.artifact, approved.artifact);
    assert.deepEqual(retried.readyTaskIds, []);
    assert.equal((await readProjectState(root)).tasks[0]?.status, "active");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("approval refuses materialization conflicts before recording consent", async () => {
  const root = await mkdtemp(join(tmpdir(), "draftforge-plan-conflict-"));
  try {
    await runInit(root, { name: "Sample" });
    await writePlanningArtifact(root, submitPlan(createPlanningArtifact("idea.md"), plan));
    await writeFile(
      resolve(root, ".draftforge/tasks/P01-T01.md"),
      "# User-owned task file\n",
      "utf8",
    );

    await assert.rejects(
      runPlan(root, {
        mode: "approve",
        approvedBy: "sujan",
        now: new Date("2026-02-01T00:00:00.000Z"),
      }),
      /would overwrite existing project files: .draftforge\/tasks\/P01-T01.md/,
    );
    assert.equal((await readPlanningArtifact(root)).status, "draft");
    assert.deepEqual((await readProjectState(root)).tasks, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

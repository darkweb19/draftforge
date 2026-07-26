import assert from "node:assert/strict";
import { test } from "node:test";
import { effectiveTaskBudget, recomputeTaskReadiness, selectSchedulableTasks } from "../src/application/scheduler.js";
import type { TaskContract } from "../src/application/task-contract.js";
import { PROJECT_STATE_SCHEMA_VERSION, type ProjectState } from "../src/domain/state.js";

const contract = (id: string, ownedPaths: readonly string[]): TaskContract => ({
  id,
  title: id,
  objective: "Work.",
  ownedPaths,
  requiredContext: [],
  relevantAdrs: [],
  dependsOn: [],
  acceptanceCriteria: ["Done."],
  verification: ["npm test"],
  exclusions: [],
});

const state: ProjectState = {
  schemaVersion: PROJECT_STATE_SCHEMA_VERSION,
  project: { name: "Example", draftFile: "idea.md" },
  workflow: { phaseId: "phase-04", phaseName: "Execution", stage: "implementation", status: "in_progress", currentTask: null, nextTask: "P04-T01" },
  phases: [{ id: "phase-04", name: "Execution", status: "in_progress" }],
  tasks: [
    { id: "P03-T04", title: "Done", status: "done", taskFile: ".draftforge/tasks/P03-T04.md", dependsOn: [], attempt: null },
    { id: "P04-T01", title: "One", status: "backlog", taskFile: ".draftforge/tasks/P04-T01.md", dependsOn: ["P03-T04"], attempt: null },
    { id: "P04-T02", title: "Two", status: "ready", taskFile: ".draftforge/tasks/P04-T02.md", dependsOn: [], attempt: null },
  ],
  decisions: [],
  handoff: { updatedAt: "2026-07-26T00:00:00.000Z", updatedBy: "test", summary: "", decisionsLocked: [], openQuestions: [], blockers: [], nextActions: [], gotchas: [] },
};

test("recomputes readiness and selects non-conflicting work up to capacity", () => {
  const ready = recomputeTaskReadiness(state);
  assert.equal(ready.tasks.find((task) => task.id === "P04-T01")?.status, "ready");
  const contracts = new Map([
    ["P04-T01", contract("P04-T01", ["src/scheduler.ts"])],
    ["P04-T02", contract("P04-T02", ["src/workspace.ts"])],
  ]);
  assert.deepEqual(selectSchedulableTasks(ready, contracts, 2).map((candidate) => candidate.task.id), ["P04-T01", "P04-T02"]);
});

test("counts every active task conservatively and avoids its owned paths", () => {
  const active: ProjectState = {
    ...recomputeTaskReadiness(state),
    tasks: recomputeTaskReadiness(state).tasks.map((task) => task.id === "P04-T02" ? { ...task, status: "active" as const, attempt: null } : task),
  };
  const contracts = new Map([
    ["P04-T01", contract("P04-T01", ["src/workspace/child.ts"])],
    ["P04-T02", contract("P04-T02", ["src/workspace"])],
  ]);
  assert.deepEqual(selectSchedulableTasks(active, contracts, 2).map((candidate) => candidate.task.id), []);
});

test("uses the configured time fallback while retaining declared Phase 5 accounting budgets", () => {
  assert.deepEqual(effectiveTaskBudget({ tokenLimit: 1000, costLimitUsd: 2.5 }, 30), {
    timeMinutes: 30,
    tokenLimit: 1000,
    costLimitUsd: 2.5,
  });
});

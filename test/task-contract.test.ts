import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { isReservedWorkerPath, ownedPathsConflict, parseTaskContract, readTaskContract } from "../src/application/task-contract.js";
import type { TaskState } from "../src/domain/state.js";

const task: TaskState = {
  id: "P04-T01",
  title: "Scheduler",
  status: "ready",
  taskFile: ".draftforge/tasks/P04-T01.md",
  dependsOn: ["P03-T04"],
  attempt: null,
  review: null,
};

const contract = `# P04-T01 — Scheduler

Status: ready

## Objective

Schedule safe work.

## Owned paths

- src/application/scheduler.ts

## Required context

- docs/ARCHITECTURE.md

## Relevant ADRs

- docs/decisions/0009-durable-execution-attempts.md

## Dependencies

- P03-T04

## Acceptance criteria

- Work is selected safely.

## Verification

- npm test

## Exclusions

- None

## Budget

- timeMinutes: 15
- tokenLimit: 1000
`;

test("parses the state-named strict task contract and its optional budget", () => {
  const parsed = parseTaskContract(contract, task);
  assert.equal(parsed.id, task.id);
  assert.deepEqual(parsed.budget, { timeMinutes: 15, tokenLimit: 1000 });
  assert.deepEqual(parsed.ownedPaths, ["src/application/scheduler.ts"]);
});

test("rejects contract/state disagreement, missing sections, and reserved or glob ownership", () => {
  assert.throws(() => parseTaskContract(contract.replace("# P04-T01 — Scheduler", "# P04-T01 — Different"), task), /title.*canonical state/);
  assert.throws(() => parseTaskContract(contract.replace("- P03-T04", "- P03-T03"), task), /dependencies.*canonical state/);
  assert.throws(() => parseTaskContract(contract.replace("## Verification\n\n- npm test\n\n", ""), task), /missing required section: Verification/);
  assert.throws(() => parseTaskContract(contract.replace("src/application/scheduler.ts", ".draftforge/state.json"), task), /reserved to the scheduler/);
  assert.throws(() => parseTaskContract(contract.replace("src/application/scheduler.ts", ".draftforge/config.local.json"), task), /reserved to the scheduler/);
  assert.throws(() => parseTaskContract(contract.replace("src/application/scheduler.ts", "src/**/*.ts"), task), /non-glob path/);
});

test("detects exact and ancestor path conflicts with explicit Windows case semantics", () => {
  assert.equal(ownedPathsConflict(["src/app"], ["src/app/worker.ts"]), true);
  assert.equal(ownedPathsConflict(["src/app"], ["src/application"], true), false);
  assert.equal(ownedPathsConflict(["src/App"], ["src/app/worker.ts"], false), true);
  assert.equal(isReservedWorkerPath("SESSION.md", false), true);
  assert.equal(isReservedWorkerPath("session.md", false), true);
});

test("rejects drive, UNC, and traversal task file paths before filesystem access", async () => {
  const root = await mkdtemp(join(tmpdir(), "draftforge-task-contract-"));
  try {
    await writeFile(resolve(root, "task.md"), contract, "utf8");
    for (const taskFile of ["C:\\outside.md", "\\\\server\\share\\task.md", "..\\outside.md"]) {
      await assert.rejects(readTaskContract(root, { ...task, taskFile }), /outside the project/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

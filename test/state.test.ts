import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROJECT_STATE_SCHEMA_VERSION,
  assertProjectState,
  type ProjectState,
} from "../src/domain/state.js";
import { renderSession } from "../src/state/files.js";

const state: ProjectState = {
  schemaVersion: PROJECT_STATE_SCHEMA_VERSION,
  project: { name: "Test project", draftFile: "idea.md" },
  workflow: {
    phaseId: "phase-01",
    phaseName: "Test phase",
    stage: "work",
    status: "in_progress",
    currentTask: "P01-T01",
    nextTask: null,
  },
  phases: [{ id: "phase-01", name: "Test phase", status: "in_progress" }],
  tasks: [
    {
      id: "P01-T01",
      title: "Test the state",
      status: "active",
      taskFile: ".draftforge/tasks/P01-T01.md",
      dependsOn: [],
    },
  ],
  decisions: [],
  handoff: {
    updatedAt: "2026-07-22T00:00:00.000Z",
    updatedBy: "test",
    summary: "Testing.",
    decisionsLocked: ["Use test fixtures."],
    openQuestions: [],
    blockers: [],
    nextActions: ["Finish the test."],
    gotchas: [],
  },
};

test("accepts the supported state version", () => {
  assert.doesNotThrow(() => assertProjectState(state));
});

test("rejects an unsupported state version", () => {
  const invalid: unknown = { ...state, schemaVersion: 99 };
  assert.throws(() => assertProjectState(invalid), /Unsupported project state schema version/);
});

test("renders the cross-harness position", () => {
  const session = renderSession(state);
  assert.match(session, /Current position: phase-01 — Test phase/);
  assert.match(session, /Current task: P01-T01\. Next task: None\./);
  assert.match(session, /## Decisions locked/);
});

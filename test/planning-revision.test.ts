import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approvePlanningArtifact,
  createPlanningArtifact,
  recordQuestionAnswers,
  startPlanningRevision,
  submitPlan,
  submitQuestionBatch,
} from "../src/application/planning.js";
import { architectStage } from "../src/application/architect-prompt.js";
import {
  assertPlanningArtifact,
  type PlanningArtifact,
  type PlanningPlan,
  type PlanningQuestionBatch,
} from "../src/domain/planning.js";
import {
  PROJECT_STATE_SCHEMA_VERSION,
  type ProjectState,
  type TaskStatus,
} from "../src/domain/state.js";

const questions: PlanningQuestionBatch = {
  revision: 1,
  items: [
    { id: "runtime", prompt: "Which runtime?", blocking: true, answer: null },
    { id: "ui", prompt: "Ship a UI?", blocking: false, answer: null },
  ],
};

const plan: PlanningPlan = {
  revision: 1,
  assumptions: [],
  decisions: [
    {
      id: "ADR-001",
      title: "Runtime",
      adrFile: "docs/decisions/0001-runtime.md",
      context: "A runtime is required.",
      decision: "Use Node.js.",
      consequences: ["Node.js is required."],
    },
  ],
  phases: [
    {
      id: "phase-01",
      name: "Foundation",
      objective: "Build the foundation.",
      exitCriteria: ["Checks pass."],
    },
    {
      id: "phase-02",
      name: "Features",
      objective: "Build the feature.",
      exitCriteria: ["Checks pass."],
    },
  ],
  tasks: [
    {
      id: "P01-T01",
      title: "Build foundation",
      phaseId: "phase-01",
      objective: "Build the foundation.",
      dependsOn: [],
      ownedPaths: ["src/foundation.ts"],
      requiredContext: [],
      relevantAdrs: ["docs/decisions/0001-runtime.md"],
      acceptanceCriteria: ["The foundation exists."],
      verification: ["npm test"],
      exclusions: [],
    },
    {
      id: "P01-T02",
      title: "Wire the CLI",
      phaseId: "phase-01",
      objective: "Expose the foundation.",
      dependsOn: ["P01-T01"],
      ownedPaths: ["src/cli.ts"],
      requiredContext: [],
      relevantAdrs: [],
      acceptanceCriteria: ["The CLI runs."],
      verification: ["npm test"],
      exclusions: [],
    },
    {
      id: "P02-T01",
      title: "Report",
      phaseId: "phase-02",
      objective: "Summarize work.",
      dependsOn: ["P01-T02"],
      ownedPaths: ["src/report.ts"],
      requiredContext: [],
      relevantAdrs: [],
      acceptanceCriteria: ["The report renders."],
      verification: ["npm test"],
      exclusions: [],
    },
  ],
  risks: [],
  verification: ["npm test"],
};

const freshState: ProjectState = {
  $schema: "./schema/state.schema.json",
  schemaVersion: PROJECT_STATE_SCHEMA_VERSION,
  project: { name: "Example", draftFile: "idea.md" },
  workflow: {
    phaseId: "phase-00",
    phaseName: "Intake",
    stage: "idea",
    status: "not_started",
    currentTask: null,
    nextTask: null,
  },
  phases: [{ id: "phase-00", name: "Intake", status: "not_started" }],
  tasks: [],
  decisions: [],
  handoff: {
    updatedAt: "2026-01-01T00:00:00.000Z",
    updatedBy: "init",
    summary: "Initialized.",
    decisionsLocked: [],
    openQuestions: [],
    blockers: [],
    nextActions: [],
    gotchas: [],
  },
};

const revisionInput = {
  reason: "The reporting phase changed after user feedback.",
  requestedBy: "sujan",
  now: new Date("2026-03-01T00:00:00.000Z"),
};

function approvedProject(): { artifact: PlanningArtifact; state: ProjectState } {
  const answered = recordQuestionAnswers(
    submitQuestionBatch(createPlanningArtifact("idea.md"), questions),
    { runtime: "Node.js 22" },
  );
  const approved = approvePlanningArtifact(submitPlan(answered, plan), freshState, {
    approvedBy: "sujan",
    now: new Date("2026-02-01T00:00:00.000Z"),
  });
  return { artifact: approved.artifact, state: approved.projectState };
}

function withStatuses(
  state: ProjectState,
  statuses: Readonly<Record<string, TaskStatus>>,
): ProjectState {
  const tasks = state.tasks.map((task) =>
    statuses[task.id] === undefined ? task : { ...task, status: statuses[task.id] as TaskStatus },
  );
  const started = tasks.find((task) => task.status === "active" || task.status === "review");
  return {
    ...state,
    workflow: {
      ...state.workflow,
      currentTask: started?.id ?? state.workflow.currentTask,
      nextTask: tasks.find((task) => task.status === "ready")?.id ?? null,
    },
    tasks,
  };
}

function statusesOf(state: ProjectState): Record<string, TaskStatus> {
  return Object.fromEntries(state.tasks.map((task) => [task.id, task.status]));
}

test("a revision records its reason, actor, and predecessor", () => {
  const { artifact, state } = approvedProject();
  const revised = startPlanningRevision(artifact, state, revisionInput);

  assert.equal(revised.artifact.revision, 2);
  assert.equal(revised.artifact.status, "interview");
  assert.equal(revised.artifact.plan, null);
  assert.equal(revised.artifact.approval, null, "approval must not carry across a revision");
  assert.deepEqual(revised.record, {
    revision: 2,
    previousRevision: 1,
    reason: revisionInput.reason,
    requestedBy: "sujan",
    requestedAt: "2026-03-01T00:00:00.000Z",
    reopenedTasks: [],
    retiredTasks: [],
  });
  assert.deepEqual(revised.artifact.revisions, [revised.record]);
  assert.deepEqual(revised.artifact.supersededPlan, plan);
  assert.doesNotThrow(() => assertPlanningArtifact(revised.artifact));

  assert.throws(
    () => startPlanningRevision(artifact, state, { ...revisionInput, reason: "  " }),
    /requires a recorded reason/,
  );
  assert.throws(
    () => startPlanningRevision(artifact, state, { ...revisionInput, requestedBy: "" }),
    /requires a recorded actor/,
  );
});

test("an unapproved draft can be revised without superseding materialized files", () => {
  const draft = submitPlan(
    recordQuestionAnswers(submitQuestionBatch(createPlanningArtifact("idea.md"), questions), {
      runtime: "Node.js 22",
    }),
    plan,
  );
  const revised = startPlanningRevision(draft, freshState, revisionInput);

  assert.equal(revised.artifact.revision, 2);
  assert.equal(revised.artifact.status, "interview");
  assert.equal(
    revised.artifact.supersededPlan,
    null,
    "a draft never reached the filesystem, so nothing is superseded",
  );
  assert.deepEqual(revised.withdrawnTaskIds, []);
  assert.deepEqual(revised.projectState.tasks, []);
});

test("a revision withdraws readiness the superseded plan justified", () => {
  const { artifact, state } = approvedProject();
  assert.equal(state.tasks[0]?.status, "ready");

  const revised = startPlanningRevision(artifact, state, revisionInput);

  assert.deepEqual(revised.withdrawnTaskIds, ["P01-T01"]);
  assert.deepEqual(statusesOf(revised.projectState), {
    "P01-T01": "backlog",
    "P01-T02": "backlog",
    "P02-T01": "backlog",
  });
  assert.equal(revised.projectState.workflow.stage, "planning");
  assert.equal(revised.projectState.workflow.nextTask, null);
});

test("a revision reopens the interview and carries recorded answers forward", () => {
  const { artifact, state } = approvedProject();
  const revised = startPlanningRevision(artifact, state, revisionInput).artifact;

  assert.equal(architectStage(revised), "questions", "a revision restates its question batch");

  const batch: PlanningQuestionBatch = {
    revision: 2,
    items: [
      { id: "runtime", prompt: "Which runtime?", blocking: true, answer: null },
      { id: "ui", prompt: "Ship a UI?", blocking: false, answer: null },
      { id: "export", prompt: "Export CSV?", blocking: true, answer: null },
    ],
  };
  const resubmitted = submitQuestionBatch(revised, batch);

  assert.equal(resubmitted.questions.items[0]?.answer, "Node.js 22", "answers survive a revision");
  assert.equal(resubmitted.questions.items[2]?.answer, null, "a revision may add questions");
  assert.equal(architectStage(resubmitted), "questions", "the added blocking question reopens it");

  assert.throws(
    () =>
      submitQuestionBatch(revised, {
        revision: 2,
        items: [{ id: "ui", prompt: "Ship a UI?", blocking: false, answer: null }],
      }),
    /must carry forward answered questions: runtime/,
  );
});

test("approving a revision keeps completed and in-flight work", () => {
  const { artifact, state } = approvedProject();
  const progressed = withStatuses(state, { "P01-T01": "done", "P01-T02": "active" });
  const revised = startPlanningRevision(artifact, progressed, revisionInput);

  const nextPlan: PlanningPlan = {
    ...plan,
    revision: 2,
    tasks: [
      plan.tasks[0]!,
      plan.tasks[1]!,
      { ...plan.tasks[2]!, id: "P02-T02", title: "Report as CSV" },
    ],
  };
  const draft = submitPlan(
    submitQuestionBatch(revised.artifact, { ...questions, revision: 2 }),
    nextPlan,
  );
  const approved = approvePlanningArtifact(draft, revised.projectState, {
    approvedBy: "sujan",
    now: new Date("2026-03-02T00:00:00.000Z"),
  });

  assert.deepEqual(statusesOf(approved.projectState), {
    "P01-T01": "done",
    "P01-T02": "active",
    "P02-T02": "backlog",
  });
  assert.equal(approved.projectState.workflow.currentTask, "P01-T02");
  assert.equal(approved.artifact.approval?.revision, 2);
  assert.match(approved.projectState.handoff.summary, /Approved planning revision 2, superseding 1/);
});

test("an explicit reopen is required to redo completed work", () => {
  const { artifact, state } = approvedProject();
  const progressed = withStatuses(state, { "P01-T01": "done" });
  const nextPlan: PlanningPlan = { ...plan, revision: 2 };

  const plain = startPlanningRevision(artifact, progressed, revisionInput);
  const kept = approvePlanningArtifact(
    submitPlan(submitQuestionBatch(plain.artifact, { ...questions, revision: 2 }), nextPlan),
    plain.projectState,
    { approvedBy: "sujan", now: new Date("2026-03-02T00:00:00.000Z") },
  );
  assert.equal(kept.projectState.tasks[0]?.status, "done", "a revision must not reset progress");
  assert.equal(kept.projectState.tasks[1]?.status, "ready", "its dependents stay unblocked");

  const reopening = startPlanningRevision(artifact, progressed, {
    ...revisionInput,
    reopenTasks: ["P01-T01"],
  });
  assert.deepEqual(reopening.record.reopenedTasks, ["P01-T01"], "reopening is recorded");
  const redone = approvePlanningArtifact(
    submitPlan(submitQuestionBatch(reopening.artifact, { ...questions, revision: 2 }), nextPlan),
    reopening.projectState,
    { approvedBy: "sujan", now: new Date("2026-03-02T00:00:00.000Z") },
  );
  assert.equal(redone.projectState.tasks[0]?.status, "ready");
  assert.equal(redone.projectState.tasks[1]?.status, "backlog", "its dependents block again");

  assert.throws(
    () => startPlanningRevision(artifact, progressed, { ...revisionInput, reopenTasks: ["P01-T02"] }),
    /Only completed tasks can be reopened: P01-T02/,
  );
  assert.throws(
    () => startPlanningRevision(artifact, progressed, { ...revisionInput, reopenTasks: ["P09-T09"] }),
    /Cannot revise an unknown task: P09-T09/,
  );
});

test("dropping started or completed tasks is rejected unless they are retired", () => {
  const { artifact, state } = approvedProject();
  const progressed = withStatuses(state, { "P01-T01": "done", "P01-T02": "review" });
  const shrunk: PlanningPlan = {
    ...plan,
    revision: 2,
    phases: [plan.phases[0]!],
    tasks: [{ ...plan.tasks[0]!, id: "P01-T03", title: "Rebuild the foundation", dependsOn: [] }],
  };

  const destructive = startPlanningRevision(artifact, progressed, revisionInput);
  assert.throws(
    () =>
      approvePlanningArtifact(
        submitPlan(submitQuestionBatch(destructive.artifact, { ...questions, revision: 2 }), shrunk),
        destructive.projectState,
        { approvedBy: "sujan", now: new Date("2026-03-02T00:00:00.000Z") },
      ),
    /cannot drop started or completed tasks without retiring them: P01-T01 \(done\), P01-T02 \(review\)/,
  );

  const retiring = startPlanningRevision(artifact, progressed, {
    ...revisionInput,
    retireTasks: ["P01-T01", "P01-T02"],
  });
  const approved = approvePlanningArtifact(
    submitPlan(submitQuestionBatch(retiring.artifact, { ...questions, revision: 2 }), shrunk),
    retiring.projectState,
    { approvedBy: "sujan", now: new Date("2026-03-02T00:00:00.000Z") },
  );
  assert.deepEqual(statusesOf(approved.projectState), { "P01-T03": "ready" });
  assert.match(approved.projectState.handoff.summary, /2 retired/);
});

test("a revision is never approved implicitly", () => {
  const { artifact, state } = approvedProject();
  const revised = startPlanningRevision(artifact, state, revisionInput);
  const draft = submitPlan(
    submitQuestionBatch(revised.artifact, { ...questions, revision: 2 }),
    { ...plan, revision: 2 },
  );

  assert.equal(draft.status, "draft");
  assert.equal(draft.approval, null);
  assert.deepEqual(revised.projectState.tasks.filter((task) => task.status === "ready"), []);
  assert.throws(
    () => startPlanningRevision(revised.artifact, revised.projectState, revisionInput),
    /has no plan to revise/,
  );
});

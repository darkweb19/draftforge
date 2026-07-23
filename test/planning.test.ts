import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  approvePlanningArtifact,
  createPlanningArtifact,
  recordQuestionAnswers,
  submitPlan,
  submitQuestionBatch,
} from "../src/application/planning.js";
import {
  assertPlanningPlan,
  type PlanningPlan,
  type PlanningQuestionBatch,
} from "../src/domain/planning.js";
import {
  PROJECT_STATE_SCHEMA_VERSION,
  type ProjectState,
} from "../src/domain/state.js";
import {
  PLANNING_PATH,
  readPlanningArtifact,
  serializePlanningArtifact,
  writePlanningArtifact,
} from "../src/state/planning.js";

const questions: PlanningQuestionBatch = {
  revision: 1,
  items: [
    {
      id: "database",
      prompt: "Which database should the project use?",
      blocking: true,
      answer: null,
    },
    {
      id: "analytics",
      prompt: "Should the first release include analytics?",
      blocking: false,
      answer: null,
    },
  ],
};

const plan: PlanningPlan = {
  revision: 1,
  assumptions: ["The project runs on Node.js."],
  decisions: [
    {
      id: "ADR-001",
      title: "Persistence",
      adrFile: "docs/decisions/0001-persistence.md",
      context: "The project needs durable data.",
      decision: "Use Postgres.",
      consequences: ["Schema migrations are required."],
    },
  ],
  phases: [
    {
      id: "phase-01",
      name: "Foundation",
      objective: "Create the application foundation.",
      exitCriteria: ["The foundation checks pass."],
    },
    {
      id: "phase-02",
      name: "Features",
      objective: "Build the first feature.",
      exitCriteria: ["The feature checks pass."],
    },
  ],
  tasks: [
    {
      id: "P01-T01",
      title: "Create foundation",
      phaseId: "phase-01",
      objective: "Create the foundation.",
      dependsOn: [],
      ownedPaths: ["src/foundation.ts"],
      requiredContext: ["docs/PRODUCT_SPEC.md"],
      relevantAdrs: ["docs/decisions/0001-persistence.md"],
      acceptanceCriteria: ["The foundation exists."],
      verification: ["npm test"],
      exclusions: ["No provider integration."],
    },
    {
      id: "P02-T01",
      title: "Build feature",
      phaseId: "phase-02",
      objective: "Build the feature.",
      dependsOn: ["P01-T01"],
      ownedPaths: ["src/feature.ts"],
      requiredContext: ["src/foundation.ts"],
      relevantAdrs: ["docs/decisions/0001-persistence.md"],
      acceptanceCriteria: ["The feature works."],
      verification: ["npm test"],
      exclusions: [],
    },
  ],
  risks: [
    {
      id: "risk-1",
      description: "Migrations could fail.",
      mitigation: "Test migrations before release.",
    },
  ],
  verification: ["npm run check"],
};

const projectState: ProjectState = {
  $schema: "./schema/state.schema.json",
  schemaVersion: PROJECT_STATE_SCHEMA_VERSION,
  project: {
    name: "Example",
    draftFile: "idea.md",
  },
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
    nextActions: ["Plan the project."],
    gotchas: [],
  },
};

test("creates a fresh planning artifact", () => {
  const artifact = createPlanningArtifact("idea.md");

  assert.equal(artifact.schemaVersion, 1);
  assert.equal(artifact.revision, 1);
  assert.equal(artifact.sourceFile, "idea.md");
  assert.equal(artifact.status, "interview");
  assert.deepEqual(artifact.questions, { revision: 1, items: [] });
  assert.equal(artifact.plan, null);
  assert.equal(artifact.approval, null);
  assert.throws(() => createPlanningArtifact("  "), /non-empty path/);
});

test("accepts at most one complete question batch per revision", () => {
  const fresh = createPlanningArtifact("idea.md");
  const submitted = submitQuestionBatch(fresh, questions);

  assert.deepEqual(submitted.questions, questions);
  assert.deepEqual(fresh.questions.items, [], "the fresh artifact must remain unchanged");
  assert.throws(
    () => submitQuestionBatch(submitted, questions),
    /already has a question batch/,
  );
  assert.throws(
    () => submitQuestionBatch(fresh, { revision: 1, items: [] }),
    /at least one question/,
  );
});

test("records partial answers and resumes without losing earlier answers", () => {
  const submitted = submitQuestionBatch(createPlanningArtifact("idea.md"), questions);
  const firstSave = recordQuestionAnswers(submitted, { database: "Postgres" });
  const resumed = recordQuestionAnswers(firstSave, { analytics: "Not in the first release" });

  assert.equal(submitted.questions.items[0]?.answer, null);
  assert.equal(firstSave.questions.items[0]?.answer, "Postgres");
  assert.equal(firstSave.questions.items[1]?.answer, null);
  assert.equal(resumed.questions.items[0]?.answer, "Postgres");
  assert.equal(resumed.questions.items[1]?.answer, "Not in the first release");
  assert.throws(
    () => recordQuestionAnswers(firstSave, { missing: "answer" }),
    /Unknown planning question: missing/,
  );
  assert.throws(
    () => recordQuestionAnswers(firstSave, { analytics: "  " }),
    /must be non-empty/,
  );
  assert.throws(() => recordQuestionAnswers(firstSave, {}), /At least one/);
});

test("rejects invalid task graphs through the domain validator", () => {
  const cyclic: PlanningPlan = {
    ...plan,
    tasks: [
      { ...plan.tasks[0]!, dependsOn: ["P02-T01"] },
      { ...plan.tasks[1]!, dependsOn: ["P01-T01"] },
    ],
  };

  assert.throws(() => assertPlanningPlan(cyclic), /contains a cycle/);
  assert.throws(
    () =>
      assertPlanningPlan({
        ...plan,
        tasks: [{ ...plan.tasks[0]!, ownedPaths: ["../outside"] }, plan.tasks[1]!],
      }),
    /project-relative path without traversal/,
  );
  assert.throws(
    () =>
      assertPlanningPlan({
        ...plan,
        tasks: [{ ...plan.tasks[0]!, phaseId: "phase-02" }, plan.tasks[1]!],
      }),
    /id must match its phaseId number/,
  );
  assert.throws(
    () =>
      assertPlanningPlan({
        ...plan,
        decisions: [
          plan.decisions[0]!,
          {
            ...plan.decisions[0]!,
            id: "ADR-002",
            adrFile: "docs\\decisions\\0001-PERSISTENCE.md",
          },
        ],
      }),
    /adrFile must be unique/,
  );
});

test("keeps roots from later phases in backlog until that phase is active", () => {
  const planWithLaterRoot: PlanningPlan = {
    ...plan,
    tasks: [
      plan.tasks[0]!,
      {
        ...plan.tasks[1]!,
        id: "P02-T02",
        dependsOn: [],
      },
    ],
  };
  const draft = submitPlan(createPlanningArtifact("idea.md"), planWithLaterRoot);
  const approved = approvePlanningArtifact(draft, projectState, {
    approvedBy: "sujan",
    now: new Date("2026-02-01T00:00:00.000Z"),
  });

  assert.deepEqual(
    approved.projectState.tasks.map(({ id, status }) => ({ id, status })),
    [
      { id: "P01-T01", status: "ready" },
      { id: "P02-T02", status: "backlog" },
    ],
  );
});

test("does not mutate project state before explicit approval", () => {
  const before = structuredClone(projectState);
  const answered = recordQuestionAnswers(
    submitQuestionBatch(createPlanningArtifact("idea.md"), questions),
    { database: "Postgres" },
  );
  const draft = submitPlan(answered, plan);

  assert.equal(draft.status, "draft");
  assert.deepEqual(projectState, before);
  assert.deepEqual(projectState.tasks, []);
});

test("approval requires readiness and materializes only approved plan state", () => {
  const unansweredDraft = {
    ...submitQuestionBatch(createPlanningArtifact("idea.md"), questions),
    status: "draft" as const,
    plan,
  };
  assert.throws(
    () =>
      approvePlanningArtifact(unansweredDraft, projectState, {
        approvedBy: "sujan",
        now: new Date("2026-02-01T00:00:00.000Z"),
      }),
    /Blocking planning questions remain unanswered: database/,
  );

  const answered = recordQuestionAnswers(
    submitQuestionBatch(createPlanningArtifact("idea.md"), questions),
    { database: "Postgres" },
  );
  const draft = submitPlan(answered, plan);
  const approved = approvePlanningArtifact(draft, projectState, {
    approvedBy: "sujan",
    now: new Date("2026-02-01T00:00:00.000Z"),
  });

  assert.equal(approved.artifact.status, "approved");
  assert.deepEqual(approved.artifact.approval, {
    revision: 1,
    approvedAt: "2026-02-01T00:00:00.000Z",
    approvedBy: "sujan",
  });
  assert.deepEqual(
    approved.projectState.phases.map(({ id, status }) => ({ id, status })),
    [
      { id: "phase-01", status: "in_progress" },
      { id: "phase-02", status: "not_started" },
    ],
  );
  assert.deepEqual(
    approved.projectState.tasks.map(({ id, status }) => ({ id, status })),
    [
      { id: "P01-T01", status: "ready" },
      { id: "P02-T01", status: "backlog" },
    ],
  );
  assert.equal(approved.projectState.workflow.phaseId, "phase-01");
  assert.equal(approved.projectState.workflow.stage, "implementation");
  assert.equal(approved.projectState.workflow.status, "in_progress");
  assert.equal(approved.projectState.workflow.currentTask, null);
  assert.equal(approved.projectState.workflow.nextTask, "P01-T01");
  assert.deepEqual(approved.projectState.decisions, [
    "docs/decisions/0001-persistence.md",
  ]);
  assert.equal(approved.projectState.handoff.updatedBy, "sujan");
  assert.match(approved.projectState.handoff.summary, /Approved planning revision 1/);

  const retried = approvePlanningArtifact(
    approved.artifact,
    approved.projectState,
    {
      approvedBy: "someone-else",
      now: new Date("2026-03-01T00:00:00.000Z"),
    },
  );
  assert.deepEqual(retried, approved, "same-revision approval must be idempotent");
});

test("persists planning artifacts and reports missing or malformed state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "draftforge-planning-"));
  try {
    const artifact = createPlanningArtifact("idea.md");
    await writePlanningArtifact(dir, artifact);

    assert.deepEqual(await readPlanningArtifact(dir), artifact);
    assert.equal(
      serializePlanningArtifact(artifact),
      `${JSON.stringify(artifact, null, 2)}\n`,
    );

    await writeFile(resolve(dir, PLANNING_PATH), "{ invalid json", "utf8");
    await assert.rejects(
      readPlanningArtifact(dir),
      (error: unknown) =>
        error instanceof Error &&
        /contains malformed JSON/.test(error.message) &&
        error.cause instanceof SyntaxError,
    );

    await rm(resolve(dir, PLANNING_PATH));
    await assert.rejects(
      readPlanningArtifact(dir),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT" &&
        error.cause !== undefined,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

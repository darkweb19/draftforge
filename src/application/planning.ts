import {
  PLANNING_SCHEMA_VERSION,
  assertPlanningArtifact,
  assertPlanningPlan,
  assertQuestionBatch,
  type PlanningArtifact,
  type PlanningPlan,
  type PlanningQuestionBatch,
} from "../domain/planning.js";
import {
  assertProjectState,
  type PhaseState,
  type ProjectState,
  type TaskState,
} from "../domain/state.js";

export interface PlanningApprovalResult {
  readonly artifact: PlanningArtifact;
  readonly projectState: ProjectState;
}

export interface PlanningApprovalInput {
  readonly approvedBy: string;
  readonly now: Date;
}

export function createPlanningArtifact(sourceFile: string): PlanningArtifact {
  if (sourceFile.trim().length === 0) {
    throw new Error("Planning source file must be a non-empty path.");
  }

  return {
    $schema: "./schema/planning.schema.json",
    schemaVersion: PLANNING_SCHEMA_VERSION,
    revision: 1,
    sourceFile,
    status: "interview",
    questions: {
      revision: 1,
      items: [],
    },
    plan: null,
    approval: null,
  };
}

export function submitQuestionBatch(
  artifact: PlanningArtifact,
  batch: PlanningQuestionBatch,
): PlanningArtifact {
  assertPlanningArtifact(artifact);
  assertQuestionBatch(batch);

  if (artifact.status !== "interview" || artifact.plan !== null || artifact.approval !== null) {
    throw new Error("Question batches can only be submitted during the interview.");
  }
  if (artifact.questions.items.length > 0) {
    throw new Error(`Planning revision ${artifact.revision} already has a question batch.`);
  }
  if (batch.items.length === 0) {
    throw new Error("Question batch must include at least one question.");
  }
  if (batch.revision !== artifact.revision) {
    throw new Error(
      `Question batch revision ${batch.revision} does not match planning revision ${artifact.revision}.`,
    );
  }

  const next: PlanningArtifact = {
    ...artifact,
    questions: batch,
  };
  assertPlanningArtifact(next);
  return next;
}

export function recordQuestionAnswers(
  artifact: PlanningArtifact,
  answers: Readonly<Record<string, string>>,
): PlanningArtifact {
  assertPlanningArtifact(artifact);

  if (artifact.status !== "interview" || artifact.plan !== null || artifact.approval !== null) {
    throw new Error("Question answers can only be recorded during the interview.");
  }

  const entries = Object.entries(answers);
  if (entries.length === 0) {
    throw new Error("At least one question answer is required.");
  }

  const questionIds = new Set(artifact.questions.items.map((question) => question.id));
  for (const [questionId, answer] of entries) {
    if (!questionIds.has(questionId)) {
      throw new Error(`Unknown planning question: ${questionId}.`);
    }
    if (answer.trim().length === 0) {
      throw new Error(`Answer for planning question ${questionId} must be non-empty.`);
    }
  }
  const answerByQuestionId = new Map(entries);

  const next: PlanningArtifact = {
    ...artifact,
    questions: {
      ...artifact.questions,
      items: artifact.questions.items.map((question) => {
        const answer = answerByQuestionId.get(question.id);
        return answer === undefined ? question : { ...question, answer };
      }),
    },
  };
  assertPlanningArtifact(next);
  return next;
}

export function submitPlan(
  artifact: PlanningArtifact,
  plan: PlanningPlan,
): PlanningArtifact {
  assertPlanningArtifact(artifact);
  assertPlanningPlan(plan);

  if (artifact.status === "approved" || artifact.approval !== null) {
    throw new Error("An approved plan cannot be replaced without a new planning revision.");
  }
  if (plan.revision !== artifact.revision) {
    throw new Error(
      `Plan revision ${plan.revision} does not match planning revision ${artifact.revision}.`,
    );
  }
  assertBlockingQuestionsAnswered(artifact);

  const next: PlanningArtifact = {
    ...artifact,
    status: "draft",
    plan,
    approval: null,
  };
  assertPlanningArtifact(next);
  return next;
}

export function approvePlanningArtifact(
  artifact: PlanningArtifact,
  projectState: ProjectState,
  input: PlanningApprovalInput,
): PlanningApprovalResult {
  assertPlanningArtifact(artifact);
  assertProjectState(projectState);
  assertApprovalInput(input);
  assertBlockingQuestionsAnswered(artifact);

  if (artifact.plan === null) {
    throw new Error("Planning approval requires a submitted draft plan.");
  }
  assertPlanningPlan(artifact.plan);

  let approvedArtifact: PlanningArtifact;
  if (artifact.status === "approved" && artifact.approval?.revision === artifact.revision) {
    approvedArtifact = artifact;
  } else {
    if (artifact.status !== "draft" || artifact.approval !== null) {
      throw new Error("Only a draft plan can be approved.");
    }
    approvedArtifact = {
      ...artifact,
      status: "approved",
      approval: {
        revision: artifact.revision,
        approvedAt: input.now.toISOString(),
        approvedBy: input.approvedBy,
      },
    };
    assertPlanningArtifact(approvedArtifact);
  }

  const nextProjectState = materializeApprovedPlan(
    projectState,
    artifact.plan,
    approvedArtifact.approval!,
    approvedArtifact.questions,
  );
  assertProjectState(nextProjectState);

  return {
    artifact: approvedArtifact,
    projectState: nextProjectState,
  };
}

function materializeApprovedPlan(
  state: ProjectState,
  plan: PlanningPlan,
  approval: NonNullable<PlanningArtifact["approval"]>,
  questions: PlanningQuestionBatch,
): ProjectState {
  if (stateMatchesPlanStructure(state, plan)) {
    return state;
  }

  const activePhase = plan.phases[0];
  if (activePhase === undefined) {
    throw new Error("Approved plan must contain at least one phase.");
  }
  const rootTasks = plan.tasks.filter(
    (task) => task.phaseId === activePhase.id && task.dependsOn.length === 0,
  );
  const firstRoot = rootTasks[0];
  if (firstRoot === undefined) {
    throw new Error(`Approved plan must contain a dependency-free root task in ${activePhase.id}.`);
  }

  const phases: readonly PhaseState[] = plan.phases.map((phase) => ({
    id: phase.id,
    name: phase.name,
    status: phase.id === activePhase.id ? "in_progress" : "not_started",
  }));
  const tasks: readonly TaskState[] = plan.tasks.map((task) => ({
    id: task.id,
    title: task.title,
    status:
      task.phaseId === activePhase.id && task.dependsOn.length === 0
        ? "ready"
        : "backlog",
    taskFile: `.draftforge/tasks/${task.id}.md`,
    dependsOn: task.dependsOn,
  }));
  return {
    ...state,
    workflow: {
      phaseId: activePhase.id,
      phaseName: activePhase.name,
      stage: "implementation",
      status: "in_progress",
      currentTask: null,
      nextTask: firstRoot.id,
    },
    phases,
    tasks,
    decisions: plan.decisions.map((decision) => decision.adrFile),
    handoff: {
      updatedAt: approval.approvedAt,
      updatedBy: approval.approvedBy,
      summary: `Approved planning revision ${approval.revision}; ${rootTasks.length} root task${rootTasks.length === 1 ? " is" : "s are"} ready.`,
      decisionsLocked: plan.decisions.map((decision) => decision.decision),
      openQuestions: questions.items
        .filter((question) => question.answer === null)
        .map((question) => question.prompt),
      blockers: [],
      nextActions: rootTasks.map((task) => `Start ${task.id}: ${task.title}.`),
      gotchas: plan.risks.map(
        (risk) => `${risk.description} Mitigation: ${risk.mitigation}`,
      ),
    },
  };
}

function stateMatchesPlanStructure(state: ProjectState, plan: PlanningPlan): boolean {
  if (
    state.phases.length !== plan.phases.length ||
    state.tasks.length !== plan.tasks.length ||
    state.decisions.length !== plan.decisions.length
  ) {
    return false;
  }

  const phasesMatch = plan.phases.every((phase, index) => {
    const existing = state.phases[index];
    return existing?.id === phase.id && existing.name === phase.name;
  });
  const tasksMatch = plan.tasks.every((task, index) => {
    const existing = state.tasks[index];
    return (
      existing?.id === task.id &&
      existing.title === task.title &&
      existing.taskFile === `.draftforge/tasks/${task.id}.md` &&
      arraysEqual(existing.dependsOn, task.dependsOn)
    );
  });
  const decisionsMatch = arraysEqual(
    state.decisions,
    plan.decisions.map((decision) => decision.adrFile),
  );
  return phasesMatch && tasksMatch && decisionsMatch;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertBlockingQuestionsAnswered(artifact: PlanningArtifact): void {
  const unanswered = artifact.questions.items
    .filter((question) => question.blocking && question.answer === null)
    .map((question) => question.id);
  if (unanswered.length > 0) {
    throw new Error(`Blocking planning questions remain unanswered: ${unanswered.join(", ")}.`);
  }
}

function assertApprovalInput(input: PlanningApprovalInput): void {
  if (input.approvedBy.trim().length === 0) {
    throw new Error("Planning approver must be a non-empty string.");
  }
  if (Number.isNaN(input.now.getTime())) {
    throw new Error("Planning approval timestamp must be a valid date.");
  }
}

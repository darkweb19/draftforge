import {
  PLANNING_SCHEMA_VERSION,
  assertPlanningArtifact,
  assertPlanningPlan,
  assertQuestionBatch,
  type PlanningArtifact,
  type PlanningPlan,
  type PlanningQuestionBatch,
  type PlanningRevisionRecord,
} from "../domain/planning.js";
import {
  assertProjectState,
  type PhaseState,
  type ProjectState,
  type TaskState,
  type TaskStatus,
} from "../domain/state.js";

export interface PlanningApprovalResult {
  readonly artifact: PlanningArtifact;
  readonly projectState: ProjectState;
}

export interface PlanningApprovalInput {
  readonly approvedBy: string;
  readonly now: Date;
}

export interface PlanningRevisionInput {
  readonly reason: string;
  readonly requestedBy: string;
  readonly now: Date;
  readonly reopenTasks?: readonly string[];
  readonly retireTasks?: readonly string[];
}

export interface PlanningRevisionResult {
  readonly artifact: PlanningArtifact;
  readonly projectState: ProjectState;
  readonly record: PlanningRevisionRecord;
  /** Tasks whose readiness the superseded plan can no longer justify. */
  readonly withdrawnTaskIds: readonly string[];
}

/**
 * Work a revision must not silently discard. A plan may still drop such a task,
 * but only by naming it in the revision record.
 */
const PROTECTED_TASK_STATUSES: readonly TaskStatus[] = ["active", "review", "done"];

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
    revisions: [],
    supersededPlan: null,
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
  if (
    artifact.questions.revision === artifact.revision &&
    artifact.questions.items.length > 0
  ) {
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
    questions: carryAnswersForward(artifact.questions, batch),
  };
  assertPlanningArtifact(next);
  return next;
}

/**
 * A revision may add or reword questions, but every answer already recorded
 * survives. Dropping an answered question is a contract error, not an edit.
 */
function carryAnswersForward(
  previous: PlanningQuestionBatch,
  batch: PlanningQuestionBatch,
): PlanningQuestionBatch {
  const answered = new Map(
    previous.items
      .filter((question) => question.answer !== null)
      .map((question) => [question.id, question.answer as string]),
  );
  const submittedIds = new Set(batch.items.map((question) => question.id));
  const discarded = [...answered.keys()].filter((id) => !submittedIds.has(id));
  if (discarded.length > 0) {
    throw new Error(
      `Planning revision ${batch.revision} must carry forward answered questions: ${discarded.join(", ")}.`,
    );
  }

  return {
    ...batch,
    items: batch.items.map((question) => {
      const answer = answered.get(question.id);
      return answer === undefined ? question : { ...question, answer };
    }),
  };
}

/**
 * Start a recorded revision. Approval never carries across it, and readiness the
 * superseded plan justified is withdrawn before the new plan is written.
 */
export function startPlanningRevision(
  artifact: PlanningArtifact,
  projectState: ProjectState,
  input: PlanningRevisionInput,
): PlanningRevisionResult {
  assertPlanningArtifact(artifact);
  assertProjectState(projectState);

  const reason = input.reason.trim();
  const requestedBy = input.requestedBy.trim();
  if (reason.length === 0) {
    throw new Error("A plan revision requires a recorded reason.");
  }
  if (requestedBy.length === 0) {
    throw new Error("A plan revision requires a recorded actor.");
  }
  if (Number.isNaN(input.now.getTime())) {
    throw new Error("Plan revision timestamp must be a valid date.");
  }

  if (artifact.plan === null) {
    throw new Error(
      `Planning revision ${artifact.revision} has no plan to revise; finish the current interview instead.`,
    );
  }

  const reopenTasks = normalizeTaskIds(input.reopenTasks ?? [], "--reopen");
  const retireTasks = normalizeTaskIds(input.retireTasks ?? [], "--retire");
  const overlap = reopenTasks.filter((id) => retireTasks.includes(id));
  if (overlap.length > 0) {
    throw new Error(`A revision cannot both reopen and retire: ${overlap.join(", ")}.`);
  }

  const byId = new Map(projectState.tasks.map((task) => [task.id, task]));
  for (const id of [...reopenTasks, ...retireTasks]) {
    if (!byId.has(id)) {
      throw new Error(`Cannot revise an unknown task: ${id}.`);
    }
  }
  const notDone = reopenTasks.filter((id) => byId.get(id)?.status !== "done");
  if (notDone.length > 0) {
    throw new Error(`Only completed tasks can be reopened: ${notDone.join(", ")}.`);
  }

  const record: PlanningRevisionRecord = {
    revision: artifact.revision + 1,
    previousRevision: artifact.revision,
    reason,
    requestedBy,
    requestedAt: input.now.toISOString(),
    reopenedTasks: reopenTasks,
    retiredTasks: retireTasks,
  };

  const next: PlanningArtifact = {
    ...artifact,
    revision: record.revision,
    status: "interview",
    plan: null,
    approval: null,
    revisions: [...artifact.revisions, record],
    supersededPlan: artifact.approval === null ? artifact.supersededPlan : artifact.plan,
  };
  assertPlanningArtifact(next);

  const withdrawnTaskIds = projectState.tasks
    .filter((task) => task.status === "ready")
    .map((task) => task.id);
  const tasks = projectState.tasks.map((task) =>
    task.status === "ready" ? { ...task, status: "backlog" as const } : task,
  );
  const nextProjectState: ProjectState = {
    ...projectState,
    workflow: {
      ...projectState.workflow,
      stage: "planning",
      status: "in_progress",
      nextTask: null,
    },
    tasks,
    handoff: {
      ...projectState.handoff,
      updatedAt: record.requestedAt,
      updatedBy: record.requestedBy,
      summary: `Started planning revision ${record.revision} (superseding ${record.previousRevision}): ${record.reason}`,
      openQuestions: next.questions.items
        .filter((question) => question.answer === null)
        .map((question) => question.prompt),
      nextActions: [
        `Run \`draftforge plan --prompt\` for planning revision ${record.revision}.`,
        `Approve revision ${record.revision} before any task becomes runnable again.`,
      ],
    },
  };
  assertProjectState(nextProjectState);

  return { artifact: next, projectState: nextProjectState, record, withdrawnTaskIds };
}

function normalizeTaskIds(ids: readonly string[], flag: string): readonly string[] {
  const normalized = ids.map((id) => id.trim());
  if (normalized.some((id) => id.length === 0)) {
    throw new Error(`${flag} requires a task ID.`);
  }
  const duplicate = normalized.find((id, index) => normalized.indexOf(id) !== index);
  if (duplicate !== undefined) {
    throw new Error(`${flag} ${duplicate} was given more than once.`);
  }
  return normalized;
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
    currentRevisionRecord(approvedArtifact),
  );
  assertProjectState(nextProjectState);

  return {
    artifact: approvedArtifact,
    projectState: nextProjectState,
  };
}

function currentRevisionRecord(artifact: PlanningArtifact): PlanningRevisionRecord | null {
  const record = artifact.revisions.at(-1);
  return record !== undefined && record.revision === artifact.revision ? record : null;
}

/**
 * Reconcile the approved plan against recorded progress. A first approval sees
 * an empty task list and reduces to a straight materialization; a revision keeps
 * finished and in-flight work unless the revision record says otherwise.
 */
function materializeApprovedPlan(
  state: ProjectState,
  plan: PlanningPlan,
  approval: NonNullable<PlanningArtifact["approval"]>,
  questions: PlanningQuestionBatch,
  revision: PlanningRevisionRecord | null,
): ProjectState {
  const previousById = new Map(state.tasks.map((task) => [task.id, task]));
  const plannedIds = new Set(plan.tasks.map((task) => task.id));
  const reopened = new Set(revision?.reopenedTasks ?? []);
  const retired = new Set(revision?.retiredTasks ?? []);

  assertNoUnrecordedRemovals(state, plannedIds, retired);
  assertReopeningIsPlanned(reopened, plannedIds, previousById);

  const carriedDone = new Set(
    state.tasks
      .filter((task) => task.status === "done" && plannedIds.has(task.id) && !reopened.has(task.id))
      .map((task) => task.id),
  );
  const activePhase = selectActivePhase(plan, carriedDone);

  const tasks: readonly TaskState[] = plan.tasks.map((task) => {
    const previous = previousById.get(task.id);
    const fresh: TaskStatus =
      task.phaseId === activePhase.id &&
      task.dependsOn.every((dependency) => carriedDone.has(dependency))
        ? "ready"
        : "backlog";
    const status: TaskStatus =
      previous === undefined || previous.status === "backlog" || reopened.has(task.id)
        ? fresh
        : previous.status;
    return {
      id: task.id,
      title: task.title,
      status,
      taskFile: `.draftforge/tasks/${task.id}.md`,
      dependsOn: task.dependsOn,
    };
  });

  const readyTasks = tasks.filter((task) => task.status === "ready");
  const inFlight = tasks.filter((task) => task.status === "active" || task.status === "review");
  if (readyTasks.length === 0 && inFlight.length === 0 && carriedDone.size !== tasks.length) {
    throw new Error(
      `Approved plan must leave at least one runnable task in ${activePhase.id}.`,
    );
  }

  const phases: readonly PhaseState[] = plan.phases.map((phase) => ({
    id: phase.id,
    name: phase.name,
    status: phaseStatus(phase.id, tasks, activePhase.id),
  }));
  const currentTask =
    state.workflow.currentTask !== null &&
    tasks.some(
      (task) =>
        task.id === state.workflow.currentTask &&
        (task.status === "active" || task.status === "review" || task.status === "blocked"),
    )
      ? state.workflow.currentTask
      : null;

  const next: ProjectState = {
    ...state,
    workflow: {
      phaseId: activePhase.id,
      phaseName: activePhase.name,
      stage: "implementation",
      status: "in_progress",
      currentTask,
      nextTask: readyTasks[0]?.id ?? null,
    },
    phases,
    tasks,
    decisions: plan.decisions.map((decision) => decision.adrFile),
    handoff: {
      updatedAt: approval.approvedAt,
      updatedBy: approval.approvedBy,
      summary: approvalSummary(approval, revision, readyTasks.length),
      decisionsLocked: plan.decisions.map((decision) => decision.decision),
      openQuestions: questions.items
        .filter((question) => question.answer === null)
        .map((question) => question.prompt),
      blockers: [],
      nextActions: readyTasks.map((task) => `Start ${task.id}: ${task.title}.`),
      gotchas: plan.risks.map(
        (risk) => `${risk.description} Mitigation: ${risk.mitigation}`,
      ),
    },
  };

  // An interrupted approval is retried, not re-applied: identical output keeps
  // the caller's snapshot so nothing is rewritten.
  return JSON.stringify(next) === JSON.stringify(state) ? state : next;
}

function approvalSummary(
  approval: NonNullable<PlanningArtifact["approval"]>,
  revision: PlanningRevisionRecord | null,
  readyCount: number,
): string {
  const ready = `${readyCount} task${readyCount === 1 ? " is" : "s are"} ready`;
  if (revision === null) {
    return `Approved planning revision ${approval.revision}; ${ready}.`;
  }
  const reopened = revision.reopenedTasks.length;
  const retired = revision.retiredTasks.length;
  return `Approved planning revision ${approval.revision}, superseding ${revision.previousRevision}: ${revision.reason} (${ready}, ${reopened} reopened, ${retired} retired).`;
}

function assertNoUnrecordedRemovals(
  state: ProjectState,
  plannedIds: ReadonlySet<string>,
  retired: ReadonlySet<string>,
): void {
  const removed = state.tasks
    .filter(
      (task) =>
        !plannedIds.has(task.id) &&
        PROTECTED_TASK_STATUSES.includes(task.status) &&
        !retired.has(task.id),
    )
    .map((task) => `${task.id} (${task.status})`);
  if (removed.length > 0) {
    throw new Error(
      `A revision cannot drop started or completed tasks without retiring them: ${removed.join(", ")}.`,
    );
  }
}

function assertReopeningIsPlanned(
  reopened: ReadonlySet<string>,
  plannedIds: ReadonlySet<string>,
  previousById: ReadonlyMap<string, TaskState>,
): void {
  const missing = [...reopened].filter((id) => !plannedIds.has(id));
  if (missing.length > 0) {
    throw new Error(
      `A reopened task must exist in the approved plan: ${missing.join(", ")}.`,
    );
  }
  const notDone = [...reopened].filter((id) => previousById.get(id)?.status !== "done");
  if (notDone.length > 0) {
    throw new Error(`Only completed tasks can be reopened: ${notDone.join(", ")}.`);
  }
}

function selectActivePhase(
  plan: PlanningPlan,
  carriedDone: ReadonlySet<string>,
): PlanningPlan["phases"][number] {
  const incomplete = plan.phases.find((phase) =>
    plan.tasks.some((task) => task.phaseId === phase.id && !carriedDone.has(task.id)),
  );
  const activePhase = incomplete ?? plan.phases.at(-1);
  if (activePhase === undefined) {
    throw new Error("Approved plan must contain at least one phase.");
  }
  return activePhase;
}

function phaseStatus(
  phaseId: string,
  tasks: readonly TaskState[],
  activePhaseId: string,
): PhaseState["status"] {
  const phaseTasks = tasks.filter((task) => taskPhaseId(task.id) === phaseId);
  if (phaseTasks.length > 0 && phaseTasks.every((task) => task.status === "done")) {
    return "complete";
  }
  return phaseId === activePhaseId ? "in_progress" : "not_started";
}

function taskPhaseId(taskId: string): string {
  return `phase-${taskId.slice(1, 3)}`;
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

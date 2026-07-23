export const PLANNING_SCHEMA_VERSION = 1 as const;

export type PlanningStatus = "interview" | "draft" | "approved";

export interface PlanningQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly blocking: boolean;
  readonly answer: string | null;
}

export interface PlanningQuestionBatch {
  readonly revision: number;
  readonly items: readonly PlanningQuestion[];
}

export interface PlanningDecision {
  readonly id: string;
  readonly title: string;
  readonly adrFile: string;
  readonly context: string;
  readonly decision: string;
  readonly consequences: readonly string[];
}

export interface PlanningPhase {
  readonly id: string;
  readonly name: string;
  readonly objective: string;
  readonly exitCriteria: readonly string[];
}

export interface PlanningTask {
  readonly id: string;
  readonly title: string;
  readonly phaseId: string;
  readonly objective: string;
  readonly dependsOn: readonly string[];
  readonly ownedPaths: readonly string[];
  readonly requiredContext: readonly string[];
  readonly relevantAdrs: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly verification: readonly string[];
  readonly exclusions: readonly string[];
}

export interface PlanningRisk {
  readonly id: string;
  readonly description: string;
  readonly mitigation: string;
}

export interface PlanningPlan {
  readonly revision: number;
  readonly assumptions: readonly string[];
  readonly decisions: readonly PlanningDecision[];
  readonly phases: readonly PlanningPhase[];
  readonly tasks: readonly PlanningTask[];
  readonly risks: readonly PlanningRisk[];
  readonly verification: readonly string[];
}

export interface PlanningApproval {
  readonly revision: number;
  readonly approvedAt: string;
  readonly approvedBy: string;
}

/**
 * One recorded plan revision. A revision never happens implicitly: it names its
 * predecessor, a reason, an actor, and every task it deliberately reopened or
 * retired.
 */
export interface PlanningRevisionRecord {
  readonly revision: number;
  readonly previousRevision: number;
  readonly reason: string;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly reopenedTasks: readonly string[];
  readonly retiredTasks: readonly string[];
}

export interface PlanningArtifact {
  readonly $schema?: string;
  readonly schemaVersion: typeof PLANNING_SCHEMA_VERSION;
  readonly revision: number;
  readonly sourceFile: string;
  readonly status: PlanningStatus;
  readonly questions: PlanningQuestionBatch;
  readonly plan: PlanningPlan | null;
  readonly approval: PlanningApproval | null;
  readonly revisions: readonly PlanningRevisionRecord[];
  /**
   * The last approved plan a revision superseded. Retained so re-materialization
   * can tell a file DraftForge generated from a file the user edited.
   */
  readonly supersededPlan: PlanningPlan | null;
}

const PLANNING_STATUSES: readonly PlanningStatus[] = ["interview", "draft", "approved"];
const PHASE_ID_PATTERN = /^phase-[0-9]{2}$/;
const TASK_ID_PATTERN = /^P[0-9]{2}-T[0-9]{2}$/;
const DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function assertPlanningArtifact(value: unknown): asserts value is PlanningArtifact {
  if (!isRecord(value)) {
    throw new Error("Planning artifact must be a JSON object.");
  }

  assertOnlyKeys(value, "Planning artifact", [
    "$schema",
    "schemaVersion",
    "revision",
    "sourceFile",
    "status",
    "questions",
    "plan",
    "approval",
    "revisions",
    "supersededPlan",
  ]);

  if (value.$schema !== undefined && typeof value.$schema !== "string") {
    throw new Error("Planning artifact $schema must be a string.");
  }
  if (value.schemaVersion !== PLANNING_SCHEMA_VERSION) {
    throw new Error(`Unsupported planning schema version: ${String(value.schemaVersion)}.`);
  }

  assertPositiveInteger(value.revision, "revision");
  assertNonEmptyString(value.sourceFile, "sourceFile");
  assertEnum(value.status, "status", PLANNING_STATUSES);
  assertQuestionBatch(value.questions);

  if (value.plan !== null) {
    assertPlanningPlan(value.plan);
  }
  if (value.approval !== null) {
    assertApproval(value.approval);
  }
  assertRevisionHistory(value.revisions, value.revision);
  if (value.supersededPlan !== null) {
    assertPlanningPlan(value.supersededPlan);
    if (value.supersededPlan.revision >= value.revision) {
      throw new Error("supersededPlan.revision must precede the planning artifact revision.");
    }
  }

  const revision = value.revision;
  if (value.questions.revision > revision) {
    throw new Error("questions.revision must not exceed the planning artifact revision.");
  }
  if (value.questions.revision < revision) {
    // Questions carried into a revision that has not produced its own batch yet.
    if (value.plan !== null || value.approval !== null || value.status !== "interview") {
      throw new Error(
        `Planning revision ${revision} must record its own question batch before a plan.`,
      );
    }
  }
  if (value.plan !== null && value.plan.revision !== revision) {
    throw new Error("plan.revision must match planning artifact revision.");
  }
  if (value.approval !== null && value.approval.revision !== revision) {
    throw new Error("approval.revision must match planning artifact revision.");
  }

  if (value.status === "interview" && (value.plan !== null || value.approval !== null)) {
    throw new Error("Interview planning state cannot contain a plan or approval.");
  }
  if (value.status === "draft" && (value.plan === null || value.approval !== null)) {
    throw new Error("Draft planning state requires a plan and cannot contain approval.");
  }
  if (value.status === "approved" && (value.plan === null || value.approval === null)) {
    throw new Error("Approved planning state requires both a plan and approval.");
  }
}

export function assertQuestionBatch(value: unknown): asserts value is PlanningQuestionBatch {
  if (!isRecord(value)) {
    throw new Error("Question batch must be an object.");
  }

  assertOnlyKeys(value, "questions", ["revision", "items"]);
  assertPositiveInteger(value.revision, "questions.revision");
  if (!Array.isArray(value.items)) {
    throw new Error("questions.items must be an array.");
  }

  const ids = new Set<string>();
  for (const [index, question] of value.items.entries()) {
    const path = `questions.items[${index}]`;
    if (!isRecord(question)) {
      throw new Error(`${path} must be an object.`);
    }
    assertOnlyKeys(question, path, ["id", "prompt", "blocking", "answer"]);
    assertNonEmptyString(question.id, `${path}.id`);
    assertNonEmptyString(question.prompt, `${path}.prompt`);
    if (typeof question.blocking !== "boolean") {
      throw new Error(`${path}.blocking must be a boolean.`);
    }
    if (question.answer !== null) {
      assertNonEmptyString(question.answer, `${path}.answer`);
    }
    assertUniqueId(ids, question.id, `${path}.id`);
  }
}

export function assertPlanningPlan(value: unknown): asserts value is PlanningPlan {
  if (!isRecord(value)) {
    throw new Error("Planning plan must be an object.");
  }

  assertOnlyKeys(value, "plan", [
    "revision",
    "assumptions",
    "decisions",
    "phases",
    "tasks",
    "risks",
    "verification",
  ]);
  assertPositiveInteger(value.revision, "plan.revision");
  assertUniqueStringArray(value.assumptions, "plan.assumptions");
  assertDecisions(value.decisions);
  const phaseIds = assertPhases(value.phases);
  const tasks = assertTasks(value.tasks, phaseIds);
  assertRisks(value.risks);
  assertUniqueStringArray(value.verification, "plan.verification", true);
  assertAcyclicTaskGraph(tasks);
}

function assertDecisions(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new Error("plan.decisions must be an array.");
  }

  const ids = new Set<string>();
  const adrFiles = new Set<string>();
  for (const [index, decision] of value.entries()) {
    const path = `plan.decisions[${index}]`;
    if (!isRecord(decision)) {
      throw new Error(`${path} must be an object.`);
    }
    assertOnlyKeys(decision, path, [
      "id",
      "title",
      "adrFile",
      "context",
      "decision",
      "consequences",
    ]);
    assertNonEmptyString(decision.id, `${path}.id`);
    assertNonEmptyString(decision.title, `${path}.title`);
    assertNonEmptyString(decision.adrFile, `${path}.adrFile`);
    assertNonEmptyString(decision.context, `${path}.context`);
    assertNonEmptyString(decision.decision, `${path}.decision`);
    assertUniqueStringArray(decision.consequences, `${path}.consequences`, true);
    assertProjectRelativePath(decision.adrFile, `${path}.adrFile`);
    if (
      !decision.adrFile.replaceAll("\\", "/").startsWith("docs/decisions/") ||
      !decision.adrFile.toLowerCase().endsWith(".md")
    ) {
      throw new Error(`${path}.adrFile must be a Markdown file under docs/decisions/.`);
    }
    assertUniqueId(ids, decision.id, `${path}.id`);
    assertUniqueId(
      adrFiles,
      canonicalProjectPath(decision.adrFile),
      `${path}.adrFile`,
    );
  }
}

function assertPhases(value: unknown): ReadonlySet<string> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("plan.phases must be a non-empty array.");
  }

  const ids = new Set<string>();
  for (const [index, phase] of value.entries()) {
    const path = `plan.phases[${index}]`;
    if (!isRecord(phase)) {
      throw new Error(`${path} must be an object.`);
    }
    assertOnlyKeys(phase, path, ["id", "name", "objective", "exitCriteria"]);
    assertPattern(phase.id, `${path}.id`, PHASE_ID_PATTERN);
    assertNonEmptyString(phase.name, `${path}.name`);
    assertNonEmptyString(phase.objective, `${path}.objective`);
    assertUniqueStringArray(phase.exitCriteria, `${path}.exitCriteria`, true);
    assertUniqueId(ids, phase.id, `${path}.id`);
  }
  return ids;
}

function assertTasks(
  value: unknown,
  phaseIds: ReadonlySet<string>,
): ReadonlyMap<string, readonly string[]> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("plan.tasks must be a non-empty array.");
  }

  const taskIds = new Set<string>();
  const dependencies = new Map<string, readonly string[]>();
  const tasks: { readonly id: string; readonly dependsOn: readonly string[]; readonly path: string }[] =
    [];

  for (const [index, task] of value.entries()) {
    const path = `plan.tasks[${index}]`;
    if (!isRecord(task)) {
      throw new Error(`${path} must be an object.`);
    }
    assertOnlyKeys(task, path, [
      "id",
      "title",
      "phaseId",
      "objective",
      "dependsOn",
      "ownedPaths",
      "requiredContext",
      "relevantAdrs",
      "acceptanceCriteria",
      "verification",
      "exclusions",
    ]);
    assertPattern(task.id, `${path}.id`, TASK_ID_PATTERN);
    assertNonEmptyString(task.title, `${path}.title`);
    assertPattern(task.phaseId, `${path}.phaseId`, PHASE_ID_PATTERN);
    assertNonEmptyString(task.objective, `${path}.objective`);
    assertUniqueStringArray(task.dependsOn, `${path}.dependsOn`);
    assertUniqueStringArray(task.ownedPaths, `${path}.ownedPaths`, true);
    assertUniqueStringArray(task.requiredContext, `${path}.requiredContext`);
    assertUniqueStringArray(task.relevantAdrs, `${path}.relevantAdrs`);
    assertUniqueStringArray(task.acceptanceCriteria, `${path}.acceptanceCriteria`, true);
    assertUniqueStringArray(task.verification, `${path}.verification`, true);
    assertUniqueStringArray(task.exclusions, `${path}.exclusions`);
    for (const [ownedIndex, ownedPath] of task.ownedPaths.entries()) {
      assertProjectRelativePath(ownedPath, `${path}.ownedPaths[${ownedIndex}]`);
    }
    for (const [contextIndex, contextPath] of task.requiredContext.entries()) {
      assertProjectRelativePath(contextPath, `${path}.requiredContext[${contextIndex}]`);
    }
    for (const [adrIndex, adrPath] of task.relevantAdrs.entries()) {
      assertProjectRelativePath(adrPath, `${path}.relevantAdrs[${adrIndex}]`);
    }
    assertUniqueId(taskIds, task.id, `${path}.id`);

    if (!phaseIds.has(task.phaseId)) {
      throw new Error(`${path}.phaseId references unknown phase: ${task.phaseId}.`);
    }
    if (task.id.slice(1, 3) !== task.phaseId.slice(-2)) {
      throw new Error(`${path}.id must match its phaseId number.`);
    }
    tasks.push({ id: task.id, dependsOn: task.dependsOn, path });
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!taskIds.has(dependency)) {
        throw new Error(`${task.path}.dependsOn references unknown task: ${dependency}.`);
      }
      if (dependency === task.id) {
        throw new Error(`${task.path}.dependsOn cannot reference itself.`);
      }
    }
    dependencies.set(task.id, task.dependsOn);
  }
  return dependencies;
}

function assertRisks(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new Error("plan.risks must be an array.");
  }

  const ids = new Set<string>();
  for (const [index, risk] of value.entries()) {
    const path = `plan.risks[${index}]`;
    if (!isRecord(risk)) {
      throw new Error(`${path} must be an object.`);
    }
    assertOnlyKeys(risk, path, ["id", "description", "mitigation"]);
    assertNonEmptyString(risk.id, `${path}.id`);
    assertNonEmptyString(risk.description, `${path}.description`);
    assertNonEmptyString(risk.mitigation, `${path}.mitigation`);
    assertUniqueId(ids, risk.id, `${path}.id`);
  }
}

function assertRevisionHistory(
  value: unknown,
  revision: number,
): asserts value is readonly PlanningRevisionRecord[] {
  if (!Array.isArray(value)) {
    throw new Error("revisions must be an array.");
  }

  let previous = 1;
  for (const [index, record] of value.entries()) {
    const path = `revisions[${index}]`;
    if (!isRecord(record)) {
      throw new Error(`${path} must be an object.`);
    }
    assertOnlyKeys(record, path, [
      "revision",
      "previousRevision",
      "reason",
      "requestedBy",
      "requestedAt",
      "reopenedTasks",
      "retiredTasks",
    ]);
    assertPositiveInteger(record.revision, `${path}.revision`);
    assertPositiveInteger(record.previousRevision, `${path}.previousRevision`);
    assertNonEmptyString(record.reason, `${path}.reason`);
    assertNonEmptyString(record.requestedBy, `${path}.requestedBy`);
    assertDateTime(record.requestedAt, `${path}.requestedAt`);
    assertUniqueStringArray(record.reopenedTasks, `${path}.reopenedTasks`);
    assertUniqueStringArray(record.retiredTasks, `${path}.retiredTasks`);
    for (const [field, ids] of [
      ["reopenedTasks", record.reopenedTasks],
      ["retiredTasks", record.retiredTasks],
    ] as const) {
      for (const [idIndex, id] of ids.entries()) {
        assertPattern(id, `${path}.${field}[${idIndex}]`, TASK_ID_PATTERN);
      }
    }

    if (record.previousRevision !== previous) {
      throw new Error(
        `${path}.previousRevision must be ${previous}, the revision it supersedes.`,
      );
    }
    if (record.revision <= record.previousRevision) {
      throw new Error(`${path}.revision must increase beyond its predecessor.`);
    }
    previous = record.revision;
  }

  if (previous !== revision) {
    throw new Error(
      `revisions must end at the current planning revision ${revision}, not ${previous}.`,
    );
  }
}

function assertApproval(value: unknown): asserts value is PlanningApproval {
  if (!isRecord(value)) {
    throw new Error("approval must be an object or null.");
  }
  assertOnlyKeys(value, "approval", ["revision", "approvedAt", "approvedBy"]);
  assertPositiveInteger(value.revision, "approval.revision");
  assertDateTime(value.approvedAt, "approval.approvedAt");
  assertNonEmptyString(value.approvedBy, "approval.approvedBy");
}

function assertDateTime(value: unknown, path: string): asserts value is string {
  assertNonEmptyString(value, path);
  if (!DATE_TIME_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${path} must be a valid date-time string.`);
  }
}

function assertAcyclicTaskGraph(tasks: ReadonlyMap<string, readonly string[]>): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (taskId: string): void => {
    if (visiting.has(taskId)) {
      throw new Error(`plan.tasks dependency graph contains a cycle involving ${taskId}.`);
    }
    if (visited.has(taskId)) {
      return;
    }

    visiting.add(taskId);
    for (const dependency of tasks.get(taskId) ?? []) {
      visit(dependency);
    }
    visiting.delete(taskId);
    visited.add(taskId);
  };

  for (const taskId of tasks.keys()) {
    visit(taskId);
  }
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  path: string,
  allowed: readonly string[],
): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) {
    throw new Error(`${path} contains unsupported property: ${unexpected}.`);
  }
}

function assertPositiveInteger(value: unknown, path: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${path} must be a positive integer.`);
  }
}

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string.`);
  }
}

function assertPattern(value: unknown, path: string, pattern: RegExp): asserts value is string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${path} has an invalid format.`);
  }
}

function assertEnum<T extends string>(
  value: unknown,
  path: string,
  options: readonly T[],
): asserts value is T {
  if (typeof value !== "string" || !options.includes(value as T)) {
    throw new Error(`${path} must be one of: ${options.join(", ")}.`);
  }
}

function assertUniqueStringArray(
  value: unknown,
  path: string,
  requireNonEmpty = false,
): asserts value is string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  }
  if (requireNonEmpty && value.length === 0) {
    throw new Error(`${path} must be a non-empty array.`);
  }
  for (const [index, item] of value.entries()) {
    assertNonEmptyString(item, `${path}[${index}]`);
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`${path} must not contain duplicates.`);
  }
}

function assertUniqueId(ids: Set<string>, id: string, path: string): void {
  if (ids.has(id)) {
    throw new Error(`${path} must be unique: ${id}.`);
  }
  ids.add(id);
}

function assertProjectRelativePath(value: string, path: string): void {
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.includes("\0") ||
    segments.length === 0 ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`${path} must be a project-relative path without traversal.`);
  }
}

function canonicalProjectPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

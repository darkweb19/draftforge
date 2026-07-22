export const PROJECT_STATE_SCHEMA_VERSION = 1 as const;

export type WorkflowStatus = "not_started" | "in_progress" | "blocked" | "complete";
export type TaskStatus = "backlog" | "ready" | "active" | "blocked" | "review" | "done";

export interface PhaseState {
  readonly id: string;
  readonly name: string;
  readonly status: WorkflowStatus;
}

export interface TaskState {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly taskFile: string;
  readonly dependsOn: readonly string[];
}

export interface ProjectState {
  readonly $schema?: string;
  readonly schemaVersion: typeof PROJECT_STATE_SCHEMA_VERSION;
  readonly project: {
    readonly name: string;
    readonly draftFile: string;
  };
  readonly workflow: {
    readonly phaseId: string;
    readonly phaseName: string;
    readonly stage: string;
    readonly status: WorkflowStatus;
    readonly currentTask: string | null;
    readonly nextTask: string | null;
  };
  readonly phases: readonly PhaseState[];
  readonly tasks: readonly TaskState[];
  readonly decisions: readonly string[];
  readonly handoff: {
    readonly updatedAt: string;
    readonly updatedBy: string;
    readonly summary: string;
    readonly decisionsLocked: readonly string[];
    readonly openQuestions: readonly string[];
    readonly blockers: readonly string[];
    readonly nextActions: readonly string[];
    readonly gotchas: readonly string[];
  };
}

export function assertProjectState(value: unknown): asserts value is ProjectState {
  if (!isRecord(value)) {
    throw new Error("Project state must be a JSON object.");
  }

  assertOnlyKeys(value, "Project state", [
    "$schema",
    "schemaVersion",
    "project",
    "workflow",
    "phases",
    "tasks",
    "decisions",
    "handoff",
  ]);

  if (value.$schema !== undefined && typeof value.$schema !== "string") {
    throw new Error("Project state $schema must be a string.");
  }

  if (value.schemaVersion !== PROJECT_STATE_SCHEMA_VERSION) {
    throw new Error(`Unsupported project state schema version: ${String(value.schemaVersion)}`);
  }

  assertProject(value.project);
  assertWorkflow(value.workflow);
  const phaseIds = assertPhases(value.phases);
  const taskIds = assertTasks(value.tasks);
  assertStringArray(value.decisions, "decisions", true);
  assertHandoff(value.handoff);

  const workflow = value.workflow as Record<string, unknown>;
  if (!phaseIds.has(workflow.phaseId as string)) {
    throw new Error(`workflow.phaseId references unknown phase: ${String(workflow.phaseId)}.`);
  }

  for (const field of ["currentTask", "nextTask"] as const) {
    const taskId = workflow[field];
    if (typeof taskId === "string" && !taskIds.has(taskId)) {
      throw new Error(`workflow.${field} references unknown task: ${taskId}.`);
    }
  }

  for (const [index, task] of (value.tasks as readonly Record<string, unknown>[]).entries()) {
    for (const dependency of task.dependsOn as readonly string[]) {
      if (!taskIds.has(dependency)) {
        throw new Error(`tasks[${index}].dependsOn references unknown task: ${dependency}.`);
      }
      if (dependency === task.id) {
        throw new Error(`tasks[${index}].dependsOn cannot reference itself.`);
      }
    }
  }
}

const WORKFLOW_STATUSES: readonly WorkflowStatus[] = ["not_started", "in_progress", "blocked", "complete"];
const TASK_STATUSES: readonly TaskStatus[] = ["backlog", "ready", "active", "blocked", "review", "done"];
const PHASE_ID_PATTERN = /^phase-[0-9]{2}$/;
const TASK_ID_PATTERN = /^P[0-9]{2}-T[0-9]{2}$/;

function assertProject(value: unknown): void {
  if (!isRecord(value)) {
    throw new Error("Project state requires project object.");
  }
  assertOnlyKeys(value, "project", ["name", "draftFile"]);
  assertNonEmptyString(value.name, "project.name");
  assertNonEmptyString(value.draftFile, "project.draftFile");
}

function assertWorkflow(value: unknown): void {
  if (!isRecord(value)) {
    throw new Error("Project state requires workflow object.");
  }
  assertOnlyKeys(value, "workflow", [
    "phaseId",
    "phaseName",
    "stage",
    "status",
    "currentTask",
    "nextTask",
  ]);
  assertPattern(value.phaseId, "workflow.phaseId", PHASE_ID_PATTERN);
  assertNonEmptyString(value.phaseName, "workflow.phaseName");
  assertNonEmptyString(value.stage, "workflow.stage");
  assertEnum(value.status, "workflow.status", WORKFLOW_STATUSES);
  assertNullableString(value.currentTask, "workflow.currentTask");
  assertNullableString(value.nextTask, "workflow.nextTask");
}

function assertPhases(value: unknown): ReadonlySet<string> {
  if (!Array.isArray(value)) {
    throw new Error("Project state requires phases array.");
  }

  const ids = new Set<string>();
  for (const [index, phase] of value.entries()) {
    const path = `phases[${index}]`;
    if (!isRecord(phase)) {
      throw new Error(`${path} must be an object.`);
    }
    assertOnlyKeys(phase, path, ["id", "name", "status"]);
    assertPattern(phase.id, `${path}.id`, PHASE_ID_PATTERN);
    assertNonEmptyString(phase.name, `${path}.name`);
    assertEnum(phase.status, `${path}.status`, WORKFLOW_STATUSES);
    assertUniqueId(ids, phase.id as string, `${path}.id`);
  }
  return ids;
}

function assertTasks(value: unknown): ReadonlySet<string> {
  if (!Array.isArray(value)) {
    throw new Error("Project state requires tasks array.");
  }

  const ids = new Set<string>();
  for (const [index, task] of value.entries()) {
    const path = `tasks[${index}]`;
    if (!isRecord(task)) {
      throw new Error(`${path} must be an object.`);
    }
    assertOnlyKeys(task, path, ["id", "title", "status", "taskFile", "dependsOn"]);
    assertPattern(task.id, `${path}.id`, TASK_ID_PATTERN);
    assertNonEmptyString(task.title, `${path}.title`);
    assertEnum(task.status, `${path}.status`, TASK_STATUSES);
    assertNonEmptyString(task.taskFile, `${path}.taskFile`);
    assertStringArray(task.dependsOn, `${path}.dependsOn`, true);
    assertUniqueId(ids, task.id as string, `${path}.id`);
  }
  return ids;
}

function assertHandoff(value: unknown): void {
  if (!isRecord(value)) {
    throw new Error("Project state requires handoff metadata.");
  }
  assertOnlyKeys(value, "handoff", [
    "updatedAt",
    "updatedBy",
    "summary",
    "decisionsLocked",
    "openQuestions",
    "blockers",
    "nextActions",
    "gotchas",
  ]);
  assertNonEmptyString(value.updatedAt, "handoff.updatedAt");
  if (Number.isNaN(Date.parse(value.updatedAt as string))) {
    throw new Error("handoff.updatedAt must be a valid date-time string.");
  }
  assertNonEmptyString(value.updatedBy, "handoff.updatedBy");
  if (typeof value.summary !== "string") {
    throw new Error("handoff.summary must be a string.");
  }
  for (const field of ["decisionsLocked", "openQuestions", "blockers", "nextActions", "gotchas"] as const) {
    assertStringArray(value[field], `handoff.${field}`, false);
  }
}

function assertOnlyKeys(value: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) {
    throw new Error(`${path} contains unsupported property: ${unexpected}.`);
  }
}

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
  if (!isNonEmptyString(value)) {
    throw new Error(`${path} must be a non-empty string.`);
  }
}

function assertPattern(value: unknown, path: string, pattern: RegExp): asserts value is string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${path} has an invalid format.`);
  }
}

function assertNullableString(value: unknown, path: string): void {
  if (value !== null && typeof value !== "string") {
    throw new Error(`${path} must be a string or null.`);
  }
}

function assertEnum<T extends string>(value: unknown, path: string, options: readonly T[]): asserts value is T {
  if (typeof value !== "string" || !options.includes(value as T)) {
    throw new Error(`${path} must be one of: ${options.join(", ")}.`);
  }
}

function assertStringArray(value: unknown, path: string, unique: boolean): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${path} must be an array of strings.`);
  }
  if (unique && new Set(value).size !== value.length) {
    throw new Error(`${path} must not contain duplicates.`);
  }
}

function assertUniqueId(ids: Set<string>, id: string, path: string): void {
  if (ids.has(id)) {
    throw new Error(`${path} must be unique: ${id}.`);
  }
  ids.add(id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

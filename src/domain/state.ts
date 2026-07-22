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

  if (value.schemaVersion !== PROJECT_STATE_SCHEMA_VERSION) {
    throw new Error(`Unsupported project state schema version: ${String(value.schemaVersion)}`);
  }

  if (!isRecord(value.project) || !isNonEmptyString(value.project.name)) {
    throw new Error("Project state requires project.name.");
  }

  if (!isNonEmptyString(value.project.draftFile)) {
    throw new Error("Project state requires project.draftFile.");
  }

  if (!isRecord(value.workflow) || !isNonEmptyString(value.workflow.phaseId)) {
    throw new Error("Project state requires workflow.phaseId.");
  }

  if (!Array.isArray(value.phases) || !Array.isArray(value.tasks)) {
    throw new Error("Project state requires phases and tasks arrays.");
  }

  if (!isRecord(value.handoff) || !isNonEmptyString(value.handoff.updatedAt)) {
    throw new Error("Project state requires handoff metadata.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

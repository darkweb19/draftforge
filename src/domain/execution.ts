export const EXECUTION_SCHEMA_VERSION = 1 as const;

export type AttemptLifecycle = "claimed" | "running" | "review" | "blocked";

export interface AttemptReference {
  readonly runId: string;
  readonly attemptId: string;
}

export interface TaskBudget {
  /** The only budget enforced during Phase 4. */
  readonly timeMinutes?: number;
  /** Recorded for Phase 5 accounting. */
  readonly tokenLimit?: number;
  /** Recorded for Phase 5 accounting, in USD. */
  readonly costLimitUsd?: number;
}

export interface AttemptEvidencePointers {
  readonly eventLog: string;
  readonly result: string | null;
}

/** Durable detail for the small reference retained in canonical task state. */
export interface ExecutionAttemptManifest {
  readonly $schema?: string;
  readonly schemaVersion: typeof EXECUTION_SCHEMA_VERSION;
  readonly runId: string;
  readonly attemptId: string;
  readonly taskId: string;
  readonly contractHash: string;
  /** Filled by the workspace boundary in P04-T02. */
  readonly baseCommit: string | null;
  readonly workspace: {
    readonly id: string;
    readonly path: string;
  };
  readonly lifecycle: AttemptLifecycle;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly budget: TaskBudget | null;
  readonly evidence: AttemptEvidencePointers;
}

const ATTEMPT_LIFECYCLES: readonly AttemptLifecycle[] = [
  "claimed",
  "running",
  "review",
  "blocked",
];
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export function assertAttemptReference(value: unknown): asserts value is AttemptReference {
  if (!isRecord(value)) {
    throw new Error("Task attempt must be an object or null.");
  }
  assertOnlyKeys(value, "Task attempt", ["runId", "attemptId"]);
  assertIdentifier(value.runId, "Task attempt runId");
  assertIdentifier(value.attemptId, "Task attempt attemptId");
}

export function assertTaskBudget(value: unknown): asserts value is TaskBudget {
  if (!isRecord(value)) {
    throw new Error("Task budget must be an object.");
  }
  assertOnlyKeys(value, "Task budget", ["timeMinutes", "tokenLimit", "costLimitUsd"]);
  if (value.timeMinutes !== undefined) {
    assertPositiveInteger(value.timeMinutes, "Task budget timeMinutes");
  }
  if (value.tokenLimit !== undefined) {
    assertPositiveInteger(value.tokenLimit, "Task budget tokenLimit");
  }
  if (value.costLimitUsd !== undefined) {
    if (typeof value.costLimitUsd !== "number" || !Number.isFinite(value.costLimitUsd) || value.costLimitUsd <= 0) {
      throw new Error("Task budget costLimitUsd must be a positive finite number.");
    }
  }
  if (Object.keys(value).length === 0) {
    throw new Error("Task budget must declare at least one limit.");
  }
}

export function assertExecutionAttemptManifest(
  value: unknown,
): asserts value is ExecutionAttemptManifest {
  if (!isRecord(value)) {
    throw new Error("Execution attempt manifest must be a JSON object.");
  }
  assertOnlyKeys(value, "Execution attempt manifest", [
    "$schema",
    "schemaVersion",
    "runId",
    "attemptId",
    "taskId",
    "contractHash",
    "baseCommit",
    "workspace",
    "lifecycle",
    "createdAt",
    "updatedAt",
    "budget",
    "evidence",
  ]);
  if (value.$schema !== undefined && typeof value.$schema !== "string") {
    throw new Error("Execution attempt manifest $schema must be a string.");
  }
  if (value.schemaVersion !== EXECUTION_SCHEMA_VERSION) {
    throw new Error(`Unsupported execution schema version: ${String(value.schemaVersion)}.`);
  }
  assertIdentifier(value.runId, "Execution attempt runId");
  assertIdentifier(value.attemptId, "Execution attempt attemptId");
  if (typeof value.taskId !== "string" || !/^P[0-9]{2}-T[0-9]{2}$/.test(value.taskId)) {
    throw new Error("Execution attempt taskId has an invalid format.");
  }
  if (typeof value.contractHash !== "string" || !SHA256.test(value.contractHash)) {
    throw new Error("Execution attempt contractHash must be a SHA-256 hash.");
  }
  if (value.baseCommit !== null && typeof value.baseCommit !== "string") {
    throw new Error("Execution attempt baseCommit must be a string or null.");
  }
  assertWorkspace(value.workspace);
  if (typeof value.lifecycle !== "string" || !ATTEMPT_LIFECYCLES.includes(value.lifecycle as AttemptLifecycle)) {
    throw new Error(`Execution attempt lifecycle must be one of: ${ATTEMPT_LIFECYCLES.join(", ")}.`);
  }
  assertDate(value.createdAt, "Execution attempt createdAt");
  assertDate(value.updatedAt, "Execution attempt updatedAt");
  if (value.budget !== null) {
    assertTaskBudget(value.budget);
  }
  assertEvidence(value.evidence);
}

function assertWorkspace(value: unknown): void {
  if (!isRecord(value)) {
    throw new Error("Execution attempt workspace must be an object.");
  }
  assertOnlyKeys(value, "Execution attempt workspace", ["id", "path"]);
  assertIdentifier(value.id, "Execution attempt workspace id");
  if (typeof value.path !== "string" || value.path.trim().length === 0 || value.path.startsWith("/") || value.path.includes("..")) {
    throw new Error("Execution attempt workspace path must be a safe project-relative path.");
  }
}

function assertEvidence(value: unknown): void {
  if (!isRecord(value)) {
    throw new Error("Execution attempt evidence must be an object.");
  }
  assertOnlyKeys(value, "Execution attempt evidence", ["eventLog", "result"]);
  if (typeof value.eventLog !== "string" || value.eventLog.trim().length === 0) {
    throw new Error("Execution attempt evidence eventLog must be a non-empty path.");
  }
  if (value.result !== null && (typeof value.result !== "string" || value.result.trim().length === 0)) {
    throw new Error("Execution attempt evidence result must be a path or null.");
  }
}

function assertIdentifier(value: unknown, path: string): void {
  if (typeof value !== "string" || !SAFE_IDENTIFIER.test(value) || value === "." || value === "..") {
    throw new Error(`${path} must contain only letters, numbers, dots, underscores, or hyphens.`);
  }
}

function assertDate(value: unknown, path: string): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`${path} must be a valid date-time string.`);
  }
}

function assertPositiveInteger(value: unknown, path: string): void {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${path} must be a positive integer.`);
  }
}

function assertOnlyKeys(value: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) {
    throw new Error(`${path} contains unsupported property: ${unexpected}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

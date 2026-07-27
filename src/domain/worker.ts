export type WorkerResultStatus = "completed" | "blocked";

export interface WorkerCommandResult {
  readonly command: string;
  readonly exitCode: number | null;
  readonly summary: string;
}

export interface WorkerResult {
  readonly taskId: string;
  readonly attemptId: string;
  readonly status: WorkerResultStatus;
  readonly summary: string;
  /** A worker claim only; Git remains authoritative. */
  readonly changedPaths: readonly string[];
  readonly commandsRun: readonly WorkerCommandResult[];
  readonly evidence: readonly string[];
  readonly risks: readonly string[];
  readonly suggestedFollowUps: readonly string[];
}

const RESULT_KEYS = [
  "taskId",
  "attemptId",
  "status",
  "summary",
  "changedPaths",
  "commandsRun",
  "evidence",
  "risks",
  "suggestedFollowUps",
] as const;
const COMMAND_KEYS = ["command", "exitCode", "summary"] as const;
const TASK_ID = /^P[0-9]{2}-T[0-9]{2}$/;
const ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GLOB = /[*?[\]{}!]/u;

export function assertWorkerResult(value: unknown): asserts value is WorkerResult {
  if (!isRecord(value)) {
    throw new Error("Worker result must be a JSON object.");
  }
  assertOnlyKeys(value, "Worker result", RESULT_KEYS);
  assertRequiredKeys(value, "Worker result", RESULT_KEYS);
  if (typeof value.taskId !== "string" || !TASK_ID.test(value.taskId)) {
    throw new Error("Worker result taskId has an invalid format.");
  }
  if (
    typeof value.attemptId !== "string" ||
    !ATTEMPT_ID.test(value.attemptId) ||
    value.attemptId === "." ||
    value.attemptId === ".."
  ) {
    throw new Error("Worker result attemptId has an invalid format.");
  }
  if (value.status !== "completed" && value.status !== "blocked") {
    throw new Error('Worker result status must be "completed" or "blocked".');
  }
  assertNonEmptyString(value.summary, "Worker result summary");
  assertRepositoryPaths(value.changedPaths, "Worker result changedPaths");
  assertCommands(value.commandsRun);
  assertStringArray(value.evidence, "Worker result evidence");
  assertStringArray(value.risks, "Worker result risks");
  assertStringArray(value.suggestedFollowUps, "Worker result suggestedFollowUps");
}

function assertCommands(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new Error("Worker result commandsRun must be an array.");
  }
  for (const [index, command] of value.entries()) {
    const path = `Worker result commandsRun[${index}]`;
    if (!isRecord(command)) {
      throw new Error(`${path} must be an object.`);
    }
    assertOnlyKeys(command, path, COMMAND_KEYS);
    assertRequiredKeys(command, path, COMMAND_KEYS);
    assertNonEmptyString(command.command, `${path}.command`);
    if (
      command.exitCode !== null &&
      (
        typeof command.exitCode !== "number" ||
        !Number.isInteger(command.exitCode) ||
        command.exitCode < 0
      )
    ) {
      throw new Error(`${path}.exitCode must be a non-negative integer or null.`);
    }
    assertNonEmptyString(command.summary, `${path}.summary`);
  }
}

function assertRepositoryPaths(value: unknown, path: string): void {
  assertStringArray(value, path);
  const normalized = (value as readonly string[]).map((item) => normalizeWorkerPath(item));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${path} must not contain duplicate paths.`);
  }
}

/** Strict repository-relative path validation for untrusted worker claims. */
export function normalizeWorkerPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/u, "");
  const segments = normalized.split("/");
  if (
    value.trim().length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.includes("\0") ||
    GLOB.test(normalized) ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(`Worker changed path must be repository-relative: ${value}.`);
  }
  return normalized;
}

function assertStringArray(value: unknown, path: string): asserts value is readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.trim().length === 0)
  ) {
    throw new Error(`${path} must be an array of non-empty strings.`);
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`${path} must not contain duplicates.`);
  }
}

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string.`);
  }
}

function assertOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  path: string,
  allowed: readonly string[],
): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) {
    throw new Error(`${path} contains unsupported property: ${unexpected}.`);
  }
}

function assertRequiredKeys(
  value: Readonly<Record<string, unknown>>,
  path: string,
  required: readonly string[],
): void {
  const missing = required.find((key) => !(key in value));
  if (missing !== undefined) {
    throw new Error(`${path} is missing required property: ${missing}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

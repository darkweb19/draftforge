export const EXECUTION_SCHEMA_VERSION = 1 as const;

export type AttemptLifecycle =
  | "claimed"
  | "running"
  | "verifying"
  | "reviewing"
  | "repairing"
  | "review"
  | "blocked"
  | "integrated";

/**
 * The closed ADR-0010 non-acceptance taxonomy. Classification routes recovery
 * (repair vs. terminal block), so it is durable canonical state rather than
 * re-derived by scanning events.
 */
export type FailureClassification =
  | "contract-violation"
  | "scope-violation"
  | "verification-failure"
  | "review-rejection"
  | "secret-detected"
  | "integration-conflict"
  | "harness-failure"
  | "timeout"
  | "unknown";

export const FAILURE_CLASSIFICATIONS: readonly FailureClassification[] = [
  "contract-violation",
  "scope-violation",
  "verification-failure",
  "review-rejection",
  "secret-detected",
  "integration-conflict",
  "harness-failure",
  "timeout",
  "unknown",
];

/** Everything else is terminal for automation and requires a human reopen. */
export const REPAIRABLE_CLASSIFICATIONS: readonly FailureClassification[] = [
  "verification-failure",
  "review-rejection",
];

export function assertFailureClassification(
  value: unknown,
  path: string,
): asserts value is FailureClassification {
  if (
    typeof value !== "string" ||
    !FAILURE_CLASSIFICATIONS.includes(value as FailureClassification)
  ) {
    throw new Error(`${path} must be one of: ${FAILURE_CLASSIFICATIONS.join(", ")}.`);
  }
}

export function isRepairableClassification(value: FailureClassification): boolean {
  return REPAIRABLE_CLASSIFICATIONS.includes(value);
}

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

/** One declared verification command's exit evidence. */
export interface VerificationCommandResult {
  /** The literal declared command string, e.g. "npm run check". */
  readonly command: string;
  /** null when the child never reported an exit status. */
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly timedOut: boolean;
  /** false records uncertain termination, matching the Phase 4 contract. */
  readonly terminated: boolean;
  /** Project-relative path to the redacted, truncated transcript. */
  readonly transcriptPath: string;
}

export interface AttemptVerification {
  readonly status: "passed" | "failed";
  /** null only when status is "passed". */
  readonly classification: FailureClassification | null;
  readonly commands: readonly VerificationCommandResult[];
  readonly completedAt: string;
}

/** A locator only. Never the matched value, never surrounding content. */
export interface SecretFinding {
  readonly ruleId: string;
  /** Repository-relative. */
  readonly path: string;
  /** 1-based. */
  readonly line: number;
}

export interface AttemptScan {
  readonly status: "clean" | "detected";
  readonly findings: readonly SecretFinding[];
  readonly scannedAt: string;
}

export interface AttemptVerdict {
  readonly verdict: "accept" | "reject" | "block";
  /** null only when the effective outcome is acceptance. */
  readonly classification: FailureClassification | null;
  readonly findingCount: number;
  /** Project-relative path to the persisted full verdict evidence, or null. */
  readonly evidencePath: string | null;
  readonly recordedAt: string;
}

/** null means unknown and is never replaced by an estimate. */
export interface AttemptUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
  readonly calls: number;
}

export interface AttemptIntegration {
  readonly status: "integrated" | "conflict";
  readonly projectBranch: string;
  /** The project branch head recorded before the merge: the rollback point. */
  readonly rollbackCommit: string;
  /** null on conflict. */
  readonly integrationCommit: string | null;
  readonly integratedAt: string;
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
  // Optional so existing Phase 4 manifests still validate when these keys are
  // absent; DraftForge always writes them explicitly as `null` on new
  // manifests once P05-T02 through P05-T04 populate them.
  readonly verification?: AttemptVerification | null;
  readonly scan?: AttemptScan | null;
  readonly verdict?: AttemptVerdict | null;
  readonly usage?: AttemptUsage | null;
  readonly integration?: AttemptIntegration | null;
}

const ATTEMPT_LIFECYCLES: readonly AttemptLifecycle[] = [
  "claimed",
  "running",
  "verifying",
  "reviewing",
  "repairing",
  "review",
  "blocked",
  "integrated",
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
    "verification",
    "scan",
    "verdict",
    "usage",
    "integration",
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
  if (value.verification !== undefined && value.verification !== null) {
    assertAttemptVerification(value.verification);
  }
  if (value.scan !== undefined && value.scan !== null) {
    assertAttemptScan(value.scan);
  }
  if (value.verdict !== undefined && value.verdict !== null) {
    assertAttemptVerdict(value.verdict);
  }
  if (value.usage !== undefined && value.usage !== null) {
    assertAttemptUsage(value.usage);
  }
  if (value.integration !== undefined && value.integration !== null) {
    assertAttemptIntegration(value.integration);
  }
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

export function assertVerificationCommandResult(value: unknown): asserts value is VerificationCommandResult {
  if (!isRecord(value)) {
    throw new Error("Verification command result must be an object.");
  }
  assertOnlyKeys(value, "Verification command result", [
    "command",
    "exitCode",
    "durationMs",
    "timedOut",
    "terminated",
    "transcriptPath",
  ]);
  if (typeof value.command !== "string" || value.command.trim().length === 0) {
    throw new Error("Verification command result command must be a non-empty string.");
  }
  if (value.exitCode !== null && !Number.isInteger(value.exitCode)) {
    throw new Error("Verification command result exitCode must be an integer or null.");
  }
  if (!Number.isInteger(value.durationMs) || (value.durationMs as number) < 0) {
    throw new Error("Verification command result durationMs must be a non-negative integer.");
  }
  if (typeof value.timedOut !== "boolean") {
    throw new Error("Verification command result timedOut must be a boolean.");
  }
  if (typeof value.terminated !== "boolean") {
    throw new Error("Verification command result terminated must be a boolean.");
  }
  assertSafeProjectRelativePath(value.transcriptPath, "Verification command result transcriptPath");
}

export function assertAttemptVerification(value: unknown): asserts value is AttemptVerification {
  if (!isRecord(value)) {
    throw new Error("Attempt verification must be an object.");
  }
  assertOnlyKeys(value, "Attempt verification", ["status", "classification", "commands", "completedAt"]);
  assertEnum(value.status, "Attempt verification status", ["passed", "failed"]);
  if (value.status === "passed") {
    if (value.classification !== null) {
      throw new Error("Attempt verification classification must be null when status is passed.");
    }
  } else {
    assertFailureClassification(value.classification, "Attempt verification classification");
  }
  if (!Array.isArray(value.commands)) {
    throw new Error("Attempt verification commands must be an array.");
  }
  for (const command of value.commands) {
    assertVerificationCommandResult(command);
  }
  assertDate(value.completedAt, "Attempt verification completedAt");
}

export function assertSecretFinding(value: unknown): asserts value is SecretFinding {
  if (!isRecord(value)) {
    throw new Error("Secret finding must be an object.");
  }
  assertOnlyKeys(value, "Secret finding", ["ruleId", "path", "line"]);
  if (typeof value.ruleId !== "string" || value.ruleId.trim().length === 0) {
    throw new Error("Secret finding ruleId must be a non-empty string.");
  }
  assertSafeProjectRelativePath(value.path, "Secret finding path");
  if (!Number.isInteger(value.line) || (value.line as number) < 1) {
    throw new Error("Secret finding line must be a 1-based integer.");
  }
}

export function assertAttemptScan(value: unknown): asserts value is AttemptScan {
  if (!isRecord(value)) {
    throw new Error("Attempt scan must be an object.");
  }
  assertOnlyKeys(value, "Attempt scan", ["status", "findings", "scannedAt"]);
  assertEnum(value.status, "Attempt scan status", ["clean", "detected"]);
  if (!Array.isArray(value.findings)) {
    throw new Error("Attempt scan findings must be an array.");
  }
  for (const finding of value.findings) {
    assertSecretFinding(finding);
  }
  if (value.status === "detected" && value.findings.length === 0) {
    throw new Error("Attempt scan findings must be non-empty when status is detected.");
  }
  if (value.status === "clean" && value.findings.length > 0) {
    throw new Error("Attempt scan findings must be empty when status is clean.");
  }
  assertDate(value.scannedAt, "Attempt scan scannedAt");
}

export function assertAttemptVerdict(value: unknown): asserts value is AttemptVerdict {
  if (!isRecord(value)) {
    throw new Error("Attempt verdict must be an object.");
  }
  assertOnlyKeys(value, "Attempt verdict", [
    "verdict",
    "classification",
    "findingCount",
    "evidencePath",
    "recordedAt",
  ]);
  assertEnum(value.verdict, "Attempt verdict verdict", ["accept", "reject", "block"]);
  if (value.verdict === "accept") {
    if (value.classification !== null) {
      throw new Error("Attempt verdict classification must be null when verdict is accept.");
    }
  } else {
    assertFailureClassification(value.classification, "Attempt verdict classification");
  }
  if (!Number.isInteger(value.findingCount) || (value.findingCount as number) < 0) {
    throw new Error("Attempt verdict findingCount must be a non-negative integer.");
  }
  if (value.evidencePath !== null) {
    assertSafeProjectRelativePath(value.evidencePath, "Attempt verdict evidencePath");
  }
  assertDate(value.recordedAt, "Attempt verdict recordedAt");
}

export function assertAttemptUsage(value: unknown): asserts value is AttemptUsage {
  if (!isRecord(value)) {
    throw new Error("Attempt usage must be an object.");
  }
  assertOnlyKeys(value, "Attempt usage", [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "costUsd",
    "calls",
  ]);
  assertNullableNonNegativeInteger(value.inputTokens, "Attempt usage inputTokens");
  assertNullableNonNegativeInteger(value.outputTokens, "Attempt usage outputTokens");
  assertNullableNonNegativeInteger(value.totalTokens, "Attempt usage totalTokens");
  if (value.costUsd !== null && (typeof value.costUsd !== "number" || !Number.isFinite(value.costUsd) || value.costUsd < 0)) {
    throw new Error("Attempt usage costUsd must be a non-negative finite number or null.");
  }
  if (!Number.isInteger(value.calls) || (value.calls as number) < 0) {
    throw new Error("Attempt usage calls must be a non-negative integer.");
  }
}

export function assertAttemptIntegration(value: unknown): asserts value is AttemptIntegration {
  if (!isRecord(value)) {
    throw new Error("Attempt integration must be an object.");
  }
  assertOnlyKeys(value, "Attempt integration", [
    "status",
    "projectBranch",
    "rollbackCommit",
    "integrationCommit",
    "integratedAt",
  ]);
  assertEnum(value.status, "Attempt integration status", ["integrated", "conflict"]);
  if (typeof value.projectBranch !== "string" || value.projectBranch.trim().length === 0) {
    throw new Error("Attempt integration projectBranch must be a non-empty string.");
  }
  if (typeof value.rollbackCommit !== "string" || value.rollbackCommit.trim().length === 0) {
    throw new Error("Attempt integration rollbackCommit must be a non-empty string.");
  }
  if (value.status === "conflict") {
    if (value.integrationCommit !== null) {
      throw new Error("Attempt integration integrationCommit must be null when status is conflict.");
    }
  } else if (typeof value.integrationCommit !== "string" || value.integrationCommit.trim().length === 0) {
    throw new Error("Attempt integration integrationCommit must be a non-empty string when status is integrated.");
  }
  assertDate(value.integratedAt, "Attempt integration integratedAt");
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

function assertNullableNonNegativeInteger(value: unknown, path: string): void {
  if (value !== null && (!Number.isInteger(value) || (value as number) < 0)) {
    throw new Error(`${path} must be a non-negative integer or null.`);
  }
}

function assertEnum<T extends string>(value: unknown, path: string, options: readonly T[]): asserts value is T {
  if (typeof value !== "string" || !options.includes(value as T)) {
    throw new Error(`${path} must be one of: ${options.join(", ")}.`);
  }
}

/** Reuses the workspace-path safety rule: project-relative, no leading slash, no `..`. */
function assertSafeProjectRelativePath(value: unknown, path: string): void {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.startsWith("/") ||
    value.includes("..")
  ) {
    throw new Error(`${path} must be a safe project-relative path.`);
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

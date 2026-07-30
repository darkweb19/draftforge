import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import {
  EXECUTION_SCHEMA_VERSION,
  assertExecutionAttemptManifest,
  type AttemptEvidencePointers,
  type AttemptIntegration,
  type AttemptLifecycle,
  type AttemptReference,
  type AttemptScan,
  type AttemptUsage,
  type AttemptVerdict,
  type AttemptVerification,
  type ExecutionAttemptManifest,
  type TaskBudget,
} from "../domain/execution.js";
import {
  configuredSecretsFromEnv,
  redactConfiguredSecrets,
  redactForLog,
} from "./events.js";
import { writeFileAtomic } from "./files.js";

const RUNS_DIRECTORY = ".draftforge/runs";

export function attemptManifestPath(reference: AttemptReference): string {
  assertReference(reference);
  return `${RUNS_DIRECTORY}/${reference.runId}/attempts/${reference.attemptId}.json`;
}

export function attemptEventPath(reference: AttemptReference): string {
  assertReference(reference);
  return `${RUNS_DIRECTORY}/${reference.runId}/attempts/${reference.attemptId}.events.jsonl`;
}

export function attemptResultPath(reference: AttemptReference): string {
  assertReference(reference);
  return `${RUNS_DIRECTORY}/${reference.runId}/attempts/${reference.attemptId}.result.json`;
}

export function hashTaskContract(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

export function createExecutionAttemptManifest(input: {
  readonly reference: AttemptReference;
  readonly taskId: string;
  readonly contractHash: string;
  readonly now: Date;
  readonly budget?: TaskBudget;
}): ExecutionAttemptManifest {
  if (Number.isNaN(input.now.getTime())) {
    throw new Error("Attempt timestamp must be a valid date.");
  }
  const path = attemptManifestPath(input.reference);
  const manifest: ExecutionAttemptManifest = {
    $schema: "../../schema/execution.schema.json",
    schemaVersion: EXECUTION_SCHEMA_VERSION,
    runId: input.reference.runId,
    attemptId: input.reference.attemptId,
    taskId: input.taskId,
    contractHash: input.contractHash,
    baseCommit: null,
    workspace: {
      id: `worktree-${input.taskId.toLowerCase()}`,
      path: `${RUNS_DIRECTORY}/${input.reference.runId}/worktrees/${input.taskId}`,
    },
    lifecycle: "claimed",
    createdAt: input.now.toISOString(),
    updatedAt: input.now.toISOString(),
    budget: input.budget ?? null,
    evidence: {
      eventLog: attemptEventPath(input.reference),
      result: null,
    },
    // Always written explicitly as `null` on creation so a manifest's presence
    // of a key is meaningful, not merely a schema-optionality artifact.
    verification: null,
    scan: null,
    verdict: null,
    usage: null,
    integration: null,
  };
  assertExecutionAttemptManifest(manifest);
  // Keep this local calculation coupled to manifest validation; it prevents an
  // accidental path layout change from becoming a silent API change.
  if (path !== attemptManifestPath({ runId: manifest.runId, attemptId: manifest.attemptId })) {
    throw new Error("Attempt manifest path is not stable.");
  }
  return manifest;
}

/** Atomic, idempotent create: a second write is valid only when bytes match. */
export async function writeExecutionAttemptManifest(
  root: string,
  manifest: ExecutionAttemptManifest,
): Promise<void> {
  assertExecutionAttemptManifest(manifest);
  const reference = { runId: manifest.runId, attemptId: manifest.attemptId };
  const path = resolveUnderRoot(root, attemptManifestPath(reference));
  const contents = `${JSON.stringify(manifest, null, 2)}\n`;
  try {
    const existing = await readFile(path, "utf8");
    if (existing === contents) {
      return;
    }
    throw new Error(`Execution attempt manifest already exists with different contents: ${attemptManifestPath(reference)}.`);
  } catch (error: unknown) {
    if (!hasCode(error, "ENOENT")) {
      throw error;
    }
  }
  await writeFileAtomic(path, contents);
}

export async function readExecutionAttemptManifest(
  root: string,
  reference: AttemptReference,
): Promise<ExecutionAttemptManifest> {
  const path = resolveUnderRoot(root, attemptManifestPath(reference));
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT")) {
      throw new Error(`Execution attempt manifest is missing at ${attemptManifestPath(reference)}.`, { cause: error });
    }
    throw error;
  }
  assertExecutionAttemptManifest(value);
  if (value.runId !== reference.runId || value.attemptId !== reference.attemptId) {
    throw new Error("Execution attempt manifest does not match its path.");
  }
  return value;
}

export async function updateExecutionAttemptManifest(
  root: string,
  reference: AttemptReference,
  input: {
    readonly lifecycle?: AttemptLifecycle;
    readonly baseCommit?: string | null;
    readonly verification?: AttemptVerification | null;
    readonly scan?: AttemptScan | null;
    readonly verdict?: AttemptVerdict | null;
    readonly usage?: AttemptUsage | null;
    readonly integration?: AttemptIntegration | null;
    readonly now: Date;
  },
): Promise<ExecutionAttemptManifest> {
  if (Number.isNaN(input.now.getTime())) {
    throw new Error("Attempt timestamp must be a valid date.");
  }
  const previous = await readExecutionAttemptManifest(root, reference);
  const next: ExecutionAttemptManifest = {
    ...previous,
    ...(input.lifecycle === undefined ? {} : { lifecycle: input.lifecycle }),
    ...(input.baseCommit === undefined ? {} : { baseCommit: input.baseCommit }),
    ...(input.verification === undefined ? {} : { verification: input.verification }),
    ...(input.scan === undefined ? {} : { scan: input.scan }),
    ...(input.verdict === undefined ? {} : { verdict: input.verdict }),
    ...(input.usage === undefined ? {} : { usage: input.usage }),
    ...(input.integration === undefined ? {} : { integration: input.integration }),
    updatedAt: input.now.toISOString(),
  };
  assertExecutionAttemptManifest(next);
  await writeFileAtomic(resolveUnderRoot(root, attemptManifestPath(reference)), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** Result data is durable before a later task state transition can consume it. */
export async function writeAttemptResult(
  root: string,
  reference: AttemptReference,
  result: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ExecutionAttemptManifest> {
  const manifest = await readExecutionAttemptManifest(root, reference);
  const resultPath = attemptResultPath(reference);
  const contents = `${JSON.stringify(redactForLog(redactConfiguredSecrets(result, configuredSecretsFromEnv(env))), null, 2)}\n`;
  const outputPath = resolveUnderRoot(root, resultPath);
  try {
    const previous = await readFile(outputPath, "utf8");
    if (previous !== contents) {
      throw new Error(`Attempt result already exists with different contents: ${resultPath}.`);
    }
  } catch (error: unknown) {
    if (!hasCode(error, "ENOENT")) {
      throw error;
    }
    await writeFileAtomic(outputPath, contents);
  }
  const evidence: AttemptEvidencePointers = { ...manifest.evidence, result: resultPath };
  const next: ExecutionAttemptManifest = { ...manifest, evidence, updatedAt: new Date().toISOString() };
  assertExecutionAttemptManifest(next);
  await writeFileAtomic(resolveUnderRoot(root, attemptManifestPath(reference)), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export async function appendAttemptEvent(
  root: string,
  reference: AttemptReference,
  event: { readonly id: string; readonly timestamp: string; readonly type: string; readonly data: Readonly<Record<string, unknown>> },
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(event.id) || event.id === "." || event.id === "..") {
    throw new Error("Attempt event id must contain only letters, numbers, dots, underscores, or hyphens.");
  }
  if (Number.isNaN(Date.parse(event.timestamp)) || event.type.trim().length === 0) {
    throw new Error("Attempt event requires a timestamp and non-empty type.");
  }
  const manifest = await readExecutionAttemptManifest(root, reference);
  const path = resolveUnderRoot(root, manifest.evidence.eventLog);
  const redacted = redactForLog(redactConfiguredSecrets(event, configuredSecretsFromEnv(env)));
  const contents = `${JSON.stringify(redacted)}\n`;
  let previous = "";
  try {
    previous = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (!hasCode(error, "ENOENT")) {
      throw error;
    }
  }
  const found = previous.trimEnd().split("\n").filter(Boolean).some((line) => {
    try {
      const parsed: unknown = JSON.parse(line);
      return typeof parsed === "object" && parsed !== null && "id" in parsed && parsed.id === event.id;
    } catch {
      return false;
    }
  });
  if (!found) {
    await writeFileAtomic(path, `${previous}${contents}`);
  }
}

function resolveUnderRoot(root: string, projectPath: string): string {
  const resolvedRoot = resolve(root);
  const output = resolve(resolvedRoot, projectPath);
  const relativePath = relative(resolvedRoot, output);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith("../")) {
    throw new Error(`Execution path must stay inside the project: ${projectPath}.`);
  }
  return output;
}

function assertReference(reference: AttemptReference): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(reference.runId) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(reference.attemptId)) {
    throw new Error("Execution attempt reference is invalid.");
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

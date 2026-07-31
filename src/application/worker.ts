import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AttemptReference, AttemptLifecycle } from "../domain/execution.js";
import {
  assertWorkerResult,
  normalizeWorkerPath,
  type WorkerResult,
} from "../domain/worker.js";
import type { ProjectState, TaskStatus } from "../domain/state.js";
import {
  appendAttemptEvent,
  attemptResultPath,
  hashTaskContract,
  readExecutionAttemptManifest,
  updateExecutionAttemptManifest,
  writeAttemptResult,
} from "../state/execution.js";
import { appendRunEvent, type RunEvent } from "../state/events.js";
import { readProjectState, writeProjectState, writeSession } from "../state/files.js";
import { withProjectLock } from "../state/lock.js";
import { transitionTask } from "../state/transitions.js";
import type { ClaimedTaskAttempt } from "./scheduler.js";
import {
  isReservedWorkerPath,
  readTaskContract,
  type TaskContract,
} from "./task-contract.js";
import { buildWorkerPrompt } from "./worker-prompt.js";
import type { ModelRunner } from "./ports.js";
import type { WorkspaceLocation, WorkspacePort } from "./workspace.js";

export class WorkerCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerCapabilityError";
  }
}

export class StaleWorkerClaimError extends Error {
  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options);
    this.name = "StaleWorkerClaimError";
  }
}

export interface ExecuteClaimedWorkerInput {
  readonly root: string;
  readonly claimed: ClaimedTaskAttempt;
  readonly runner: ModelRunner;
  readonly workspace: WorkspacePort;
  readonly actor: string;
  readonly now?: Date;
  readonly env?: NodeJS.ProcessEnv;
  readonly agentRulePaths?: readonly string[];
  readonly caseSensitive?: boolean;
  /** A repair attempt deliberately continues in the retained rejected worktree. */
  readonly repairWorkspace?: WorkspaceLocation;
  readonly repairFindings?: readonly { readonly summary: string; readonly path: string; readonly line?: number }[];
}

export interface WorkerExecutionOutcome {
  readonly taskId: string;
  readonly attempt: AttemptReference;
  readonly transition: "active" | "review" | "blocked";
  readonly authoritativeChangedPaths: readonly string[];
  readonly scopeViolations: readonly string[];
  readonly result: WorkerResult | null;
}

export interface WorkerEvidenceArtifact {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly attemptId: string;
  readonly outcome: "active" | "review" | "blocked";
  readonly reason:
    | "completed"
    | "worker-reported-blocked"
    | "execution-failed"
    | "scope-violation"
    | "termination-uncertain";
  readonly result: WorkerResult | null;
  readonly authoritativeChangedPaths: readonly string[];
  readonly scopeViolations: readonly string[];
  readonly failure: string | null;
  readonly termination: {
    readonly processId: number | null;
    readonly definitelyTerminated: false;
  } | null;
}

/**
 * Must be called by run orchestration before `claimTaskAttempt`. It performs no
 * I/O and rejects text-only or capability-opaque worker routes actionably.
 */
export function assertWorkspaceCapableWorkerRoute(runner: ModelRunner): void {
  const capabilities = runner.capabilities?.("worker");
  if (capabilities?.workspaceAccess !== true) {
    throw new WorkerCapabilityError(
      "The configured worker route is text-only or does not declare workspace access. Select a workspace-capable codex-cli or claude-cli worker before claiming a task.",
    );
  }
}

/** Strictly parse one JSON value; Markdown fences and surrounding prose fail. */
export function parseWorkerResult(
  raw: string,
  expected: { readonly taskId: string; readonly attemptId: string },
): WorkerResult {
  const text = raw.trim();
  if (text.length === 0) {
    throw new Error("Worker response was empty.");
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (cause: unknown) {
    throw new Error("Worker response is not valid JSON.", { cause });
  }
  assertWorkerResult(value);
  if (value.taskId !== expected.taskId || value.attemptId !== expected.attemptId) {
    throw new Error(
      `Worker result identity is stale: expected ${expected.taskId}/${expected.attemptId}.`,
    );
  }
  return value;
}

/**
 * Execute exactly one already-claimed attempt. Every failure after the claim is
 * captured as sanitized durable evidence before an identity-checked transition.
 */
export async function executeClaimedWorker(
  input: ExecuteClaimedWorkerInput,
): Promise<WorkerExecutionOutcome> {
  assertWorkspaceCapableWorkerRoute(input.runner);
  assertExecutionInput(input);
  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime())) {
    throw new Error("Worker execution timestamp must be a valid date.");
  }
  const env = input.env ?? process.env;
  const reference = {
    runId: input.claimed.manifest.runId,
    attemptId: input.claimed.manifest.attemptId,
  };
  const workspaceAttempt = {
    runId: reference.runId,
    taskId: input.claimed.task.id,
    attemptId: reference.attemptId,
  };
  // The seam accepts either a fresh claim (no base commit yet) or a resumed
  // running attempt (a base commit already recorded from before the crash).
  // Anything else cannot safely start a worker.
  const initialLifecycle = input.claimed.manifest.lifecycle;
  const initialBaseCommit = input.claimed.manifest.baseCommit;
  if (initialLifecycle === "claimed") {
    if (initialBaseCommit !== null) {
      throw new Error("Worker execution requires a freshly claimed attempt manifest to carry no base commit.");
    }
  } else if (initialLifecycle === "running") {
    if (initialBaseCommit === null) {
      throw new Error("Worker execution requires a resumed running attempt manifest to carry a base commit.");
    }
  } else {
    throw new Error(`Worker execution cannot start from attempt lifecycle: ${initialLifecycle}.`);
  }
  await assertClaimStillCurrent(input.root, input.claimed, initialLifecycle, initialBaseCommit);

  let location: WorkspaceLocation | undefined;
  let result: WorkerResult | null = null;
  let failure: string | null = null;
  let authoritativeChangedPaths: readonly string[] = [];
  let scopeViolations: readonly string[] = [];
  let expectedBaseCommit: string | null = null;
  let startedProcessId: number | undefined;
  let stage: WorkerExecutionStage = "workspace-setup";

  try {
    location = input.repairWorkspace ?? await input.workspace.createOrRecover(workspaceAttempt);
    if (
      location.attempt.runId !== workspaceAttempt.runId ||
      location.attempt.taskId !== workspaceAttempt.taskId ||
      location.attempt.attemptId !== workspaceAttempt.attemptId
    ) {
      throw new Error("Repair workspace identity does not match the new attempt.");
    }
    if (initialLifecycle === "running" && location.baseCommit !== initialBaseCommit) {
      // A resumed attempt trusts its recorded base commit; a mismatch means the
      // recovered workspace is not the one this attempt was claimed against, so
      // this is a hard error rather than a silent overwrite.
      throw new Error(
        `Recovered workspace base commit does not match the attempt's recorded base commit: expected ${initialBaseCommit ?? "null"}, found ${location.baseCommit}.`,
      );
    }
    stage = "attempt-manifest-update";
    const runningManifest = await updateExecutionAttemptManifest(input.root, reference, {
      lifecycle: "running",
      baseCommit: location.baseCommit,
      now,
    });
    expectedBaseCommit = location.baseCommit;
    stage = "prompt-construction";
    const promptRequest = await buildWorkerPrompt({
      worktreeRoot: location.path,
      contract: input.claimed.contract,
      manifest: runningManifest,
      workspace: location,
      ...(input.agentRulePaths === undefined ? {} : { agentRulePaths: input.agentRulePaths }),
      ...(input.repairFindings === undefined ? {} : { repairFindings: input.repairFindings }),
    });
    await assertClaimStillCurrent(
      input.root,
      input.claimed,
      "running",
      location.baseCommit,
    );
    const request = {
      ...promptRequest,
      onProcessStart(process: { readonly processId: number }) {
        startedProcessId = process.processId;
      },
    };
    // One application call plus retryPolicy:none is intentional: a retry is an
    // explicit resume of this same durable attempt, never a reliability retry.
    stage = "model-invocation";
    const response = await input.runner.run(request);
    stage = "result-validation";
    result = parseWorkerResult(response.text, {
      taskId: input.claimed.task.id,
      attemptId: reference.attemptId,
    });
    stage = "workspace-inspection";
    authoritativeChangedPaths = normalizeChangedPaths(
      await input.workspace.changedPaths(workspaceAttempt, location.baseCommit),
    );
    scopeViolations = await workerScopeViolations(
      location.path,
      authoritativeChangedPaths,
      input.claimed.contract,
      input.caseSensitive ?? process.platform !== "win32",
    );
  } catch (error: unknown) {
    if (error instanceof StaleWorkerClaimError) {
      throw error;
    }
    if (stage === "model-invocation" && isTerminationUncertain(error)) {
      const processId = processIdFrom(error) ?? startedProcessId ?? null;
      const artifact: WorkerEvidenceArtifact = {
        schemaVersion: 1,
        taskId: input.claimed.task.id,
        attemptId: reference.attemptId,
        outcome: "active",
        reason: "termination-uncertain",
        result: null,
        authoritativeChangedPaths: [],
        scopeViolations: [],
        failure: "Worker process termination could not be confirmed.",
        termination: {
          processId,
          definitelyTerminated: false,
        },
      };
      await appendAttemptEvent(
        input.root,
        reference,
        {
          id: "worker-termination-uncertain",
          timestamp: now.toISOString(),
          type: "worker.termination-uncertain",
          data: {
            taskId: artifact.taskId,
            outcome: artifact.outcome,
            reason: artifact.reason,
            failure: artifact.failure,
            termination: artifact.termination,
          },
        },
        env,
      );
      return {
        taskId: input.claimed.task.id,
        attempt: reference,
        transition: "active",
        authoritativeChangedPaths: [],
        scopeViolations: [],
        result: null,
      };
    }
    failure = stageFailure(stage);
    if (location !== undefined) {
      try {
        authoritativeChangedPaths = normalizeChangedPaths(
          await input.workspace.changedPaths(
            workspaceAttempt,
            expectedBaseCommit ?? location.baseCommit,
          ),
        );
        scopeViolations = await workerScopeViolations(
          location.path,
          authoritativeChangedPaths,
          input.claimed.contract,
          input.caseSensitive ?? process.platform !== "win32",
        );
      } catch {
        // The primary failure remains authoritative. An uninspectable workspace
        // is blocked and preserved for explicit resume/inspection.
      }
    }
  }

  const transition = decideTransition(result, failure, scopeViolations);
  const artifact: WorkerEvidenceArtifact = {
    schemaVersion: 1,
    taskId: input.claimed.task.id,
    attemptId: reference.attemptId,
    outcome: transition,
    reason: outcomeReason(result, failure, scopeViolations),
    result,
    authoritativeChangedPaths,
    scopeViolations,
    failure,
    termination: null,
  };

  // Result and command evidence intentionally precede lifecycle/task mutation.
  // If either evidence write fails, the canonical task remains active for
  // reconciliation against the same attempt and worktree.
  await persistWorkerEvidence(input.root, reference, artifact, result, now, env);
  await transitionClaimedWorker(
    input.root,
    input.claimed.task.id,
    reference,
    transition,
    input.actor,
    now,
    transition as AttemptLifecycle,
    env,
    {
      attemptId: reference.attemptId,
      resultArtifact: attemptResultPath(reference),
      outcomeReason: artifact.reason,
    },
  );

  return {
    taskId: input.claimed.task.id,
    attempt: reference,
    transition,
    authoritativeChangedPaths,
    scopeViolations,
    result,
  };
}

export function changedPathScopeViolations(
  changedPaths: readonly string[],
  contract: TaskContract,
  caseSensitive = process.platform !== "win32",
): readonly string[] {
  const owned = contract.ownedPaths.map((path) => comparisonPath(path, caseSensitive));
  return changedPaths.filter((path) => {
    const normalized = normalizeWorkerPath(path);
    if (isReservedWorkerPath(normalized, caseSensitive)) {
      return true;
    }
    const compared = comparisonPath(normalized, caseSensitive);
    return !owned.some((owner) => compared === owner || compared.startsWith(`${owner}/`));
  });
}

async function workerScopeViolations(
  worktreeRoot: string,
  changedPaths: readonly string[],
  contract: TaskContract,
  caseSensitive: boolean,
): Promise<readonly string[]> {
  const violations = [...changedPathScopeViolations(changedPaths, contract, caseSensitive)];
  // `.draftforge/runs/` is ignored by Git. Check this single reserved boundary
  // explicitly so an ignored worker-created control tree cannot evade the
  // authoritative diff check; no unrelated repository traversal occurs.
  if (await pathExists(resolve(worktreeRoot, ".draftforge", "runs"))) {
    violations.push(".draftforge/runs");
  }
  if (await pathExists(resolve(worktreeRoot, ".draftforge", "config.local.json"))) {
    violations.push(".draftforge/config.local.json");
  }
  return [...new Set(violations)];
}

function normalizeChangedPaths(paths: readonly string[]): readonly string[] {
  return [...new Set(paths.map((path) => normalizeWorkerPath(path)))].sort();
}

function decideTransition(
  result: WorkerResult | null,
  failure: string | null,
  scopeViolations: readonly string[],
): "review" | "blocked" {
  return failure === null &&
    result?.status === "completed" &&
    scopeViolations.length === 0
    ? "review"
    : "blocked";
}

function outcomeReason(
  result: WorkerResult | null,
  failure: string | null,
  scopeViolations: readonly string[],
): WorkerEvidenceArtifact["reason"] {
  if (failure !== null) {
    return "execution-failed";
  }
  if (scopeViolations.length > 0) {
    return "scope-violation";
  }
  return result?.status === "completed" ? "completed" : "worker-reported-blocked";
}

async function transitionClaimedWorker(
  root: string,
  taskId: string,
  reference: AttemptReference,
  to: Extract<TaskStatus, "review" | "blocked">,
  actor: string,
  now: Date,
  lifecycle: AttemptLifecycle,
  env: NodeJS.ProcessEnv,
  metadata: Readonly<Record<string, unknown>>,
): Promise<ProjectState> {
  return withProjectLock(root, "worker result transition", async () => {
    const state = await readProjectState(root);
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    if (
      task?.status !== "active" ||
      task.attempt?.runId !== reference.runId ||
      task.attempt.attemptId !== reference.attemptId
    ) {
      throw new Error(
        `Cannot apply worker result: active task ${taskId} no longer owns attempt ${reference.runId}/${reference.attemptId}.`,
      );
    }
    await updateExecutionAttemptManifest(root, reference, { lifecycle, now });
    const next = transitionTask(state, taskId, to);
    const event: RunEvent = {
      schemaVersion: 1,
      timestamp: now.toISOString(),
      type: "task.transition",
      data: {
        taskId,
        from: "active",
        to,
        actor,
        metadata,
      },
    };
    await appendRunEvent(root, reference.runId, event, env);
    await writeProjectState(root, next);
    await writeSession(root, next);
    return next;
  });
}

async function assertClaimStillCurrent(
  root: string,
  claimed: ClaimedTaskAttempt,
  expectedLifecycle: "claimed" | "running",
  expectedBaseCommit: string | null,
): Promise<void> {
  try {
    await withProjectLock(root, "worker claim verification", async () => {
      const state = await readProjectState(root);
      const task = state.tasks.find((candidate) => candidate.id === claimed.task.id);
      const reference = claimed.task.attempt;
      if (
        task?.status !== "active" ||
        reference === null ||
        task.attempt?.runId !== reference.runId ||
        task.attempt.attemptId !== reference.attemptId ||
        task.taskFile !== claimed.task.taskFile
      ) {
        throw new StaleWorkerClaimError("Worker claim no longer matches canonical task state.");
      }
      const manifest = await readExecutionAttemptManifest(root, reference);
      if (
        manifest.runId !== reference.runId ||
        manifest.attemptId !== reference.attemptId ||
        manifest.taskId !== task.id ||
        manifest.lifecycle !== expectedLifecycle ||
        manifest.baseCommit !== expectedBaseCommit ||
        manifest.contractHash !== claimed.manifest.contractHash ||
        manifest.workspace.id !== claimed.manifest.workspace.id ||
        manifest.workspace.path !== claimed.manifest.workspace.path
      ) {
        throw new StaleWorkerClaimError("Worker claim no longer matches its durable attempt manifest.");
      }
      const contract = await readTaskContract(root, task);
      const contents = await readFile(resolve(root, task.taskFile), "utf8");
      if (
        hashTaskContract(contents) !== manifest.contractHash ||
        JSON.stringify(contract) !== JSON.stringify(claimed.contract)
      ) {
        throw new StaleWorkerClaimError("Worker task contract changed after the attempt was claimed.");
      }
    });
  } catch (error: unknown) {
    if (error instanceof StaleWorkerClaimError) {
      throw error;
    }
    throw new StaleWorkerClaimError(
      "Worker claim could not be revalidated against canonical task state.",
      { cause: error },
    );
  }
}

async function persistWorkerEvidence(
  root: string,
  reference: AttemptReference,
  artifact: WorkerEvidenceArtifact,
  result: WorkerResult | null,
  now: Date,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await writeAttemptResult(root, reference, artifact, env);
  await appendAttemptEvent(
    root,
    reference,
    {
      // The log is already attempt-scoped. Keep the event id stable and within
      // the 128-character execution-event identifier boundary even when the
      // attempt id itself uses its full allowed length.
      id: "worker-result",
      timestamp: now.toISOString(),
      type: "worker.result",
      data: {
        taskId: artifact.taskId,
        outcome: artifact.outcome,
        reason: artifact.reason,
        authoritativeChangedPaths: artifact.authoritativeChangedPaths,
        scopeViolations: artifact.scopeViolations,
        commandsRun: result?.commandsRun ?? [],
        suggestedFollowUps: result?.suggestedFollowUps ?? [],
        termination: artifact.termination,
      },
    },
    env,
  );
}

function isTerminationUncertain(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "definitelyTerminated" in error &&
    error.definitelyTerminated === false
  );
}

function processIdFrom(error: unknown): number | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "processId" in error &&
    typeof error.processId === "number"
  ) {
    return error.processId;
  }
  return undefined;
}

function assertExecutionInput(input: ExecuteClaimedWorkerInput): void {
  const { task, manifest } = input.claimed;
  if (
    task.status !== "active" ||
    task.attempt?.runId !== manifest.runId ||
    task.attempt.attemptId !== manifest.attemptId ||
    task.id !== manifest.taskId ||
    input.claimed.contract.id !== task.id
  ) {
    throw new Error("Worker execution requires one matching active task, contract, and attempt.");
  }
  if (input.actor.trim().length === 0) {
    throw new Error("Worker execution actor must be a non-empty string.");
  }
}

function comparisonPath(path: string, caseSensitive: boolean): string {
  const normalized = normalizeWorkerPath(path);
  return caseSensitive ? normalized : normalized.toLowerCase();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

type WorkerExecutionStage =
  | "workspace-setup"
  | "attempt-manifest-update"
  | "prompt-construction"
  | "model-invocation"
  | "result-validation"
  | "workspace-inspection";

function stageFailure(stage: WorkerExecutionStage): string {
  const messages: Record<WorkerExecutionStage, string> = {
    "workspace-setup": "Worker workspace setup failed.",
    "attempt-manifest-update": "Worker attempt manifest update failed.",
    "prompt-construction": "Worker prompt construction failed.",
    "model-invocation": "Worker model invocation failed.",
    "result-validation": "Worker result envelope validation failed.",
    "workspace-inspection": "Worker workspace inspection failed.",
  };
  return messages[stage];
}

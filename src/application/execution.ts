import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ProjectConfig } from "../config/config.js";
import type { AttemptReference, ExecutionAttemptManifest } from "../domain/execution.js";
import type { PlanningArtifact } from "../domain/planning.js";
import type { ProjectState, TaskState, TaskStatus } from "../domain/state.js";
import { appendRunEvent, type RunEvent } from "../state/events.js";
import {
  appendAttemptEvent,
  attemptEventPath,
  attemptResultPath,
  hashTaskContract,
  readExecutionAttemptManifest,
  updateExecutionAttemptManifest,
} from "../state/execution.js";
import { readProjectState, writeProjectState, writeSession } from "../state/files.js";
import { withProjectLock } from "../state/lock.js";
import { readPlanningArtifact } from "../state/planning.js";
import { transitionTask } from "../state/transitions.js";
import type { ModelRunner } from "./ports.js";
import { claimTaskAttempt, type ClaimedTaskAttempt } from "./scheduler.js";
import { ownedPathsConflict, readTaskContract, type TaskContract } from "./task-contract.js";
import {
  assertWorkspaceCapableWorkerRoute,
  executeClaimedWorker,
  type WorkerExecutionOutcome,
} from "./worker.js";
import type { WorkspacePort } from "./workspace.js";

export type ExecutionMode = "run" | "resume";

/** How one task was acted on during a single `run` or `resume` invocation. */
export type TaskDisposition = "dispatched" | "resumed" | "finalized";

export type DeferralReason =
  | "dependency"
  | "owned-path-conflict"
  | "capacity"
  | "in-flight"
  | "worker-process-live"
  | "run-required"
  | "unreconciled";

export interface TaskExecutionRecord {
  readonly taskId: string;
  readonly attempt: AttemptReference;
  readonly disposition: TaskDisposition;
  /** Canonical task status after the action. */
  readonly status: TaskStatus;
  readonly detail: string;
}

export interface DeferredTaskRecord {
  readonly taskId: string;
  readonly reason: DeferralReason;
  readonly detail: string;
}

export interface ExecutionSummary {
  readonly mode: ExecutionMode;
  readonly runId: string;
  readonly maxConcurrency: number;
  readonly records: readonly TaskExecutionRecord[];
  readonly deferred: readonly DeferredTaskRecord[];
  /** Tasks awaiting an independent reviewer decision; Phase 5 owns acceptance. */
  readonly reviewReady: readonly string[];
  readonly blocked: readonly string[];
  /** `runId/attemptId` of in-flight manifests no canonical task claims. */
  readonly orphanAttempts: readonly string[];
}

export interface ExecutionInput {
  readonly root: string;
  readonly mode: ExecutionMode;
  readonly config: ProjectConfig;
  readonly runner: ModelRunner;
  readonly workspace: WorkspacePort;
  readonly actor: string;
  readonly runId?: string;
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
  readonly caseSensitive?: boolean;
  readonly agentRulePaths?: readonly string[];
}

/** A precondition the operator must fix; never a partially applied run. */
export class ExecutionRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionRefusedError";
  }
}

interface ExecutionContext {
  readonly root: string;
  readonly mode: ExecutionMode;
  readonly config: ProjectConfig;
  readonly runner: ModelRunner;
  readonly workspace: WorkspacePort;
  readonly actor: string;
  readonly runId: string;
  readonly now: () => Date;
  readonly env: NodeJS.ProcessEnv;
  readonly caseSensitive: boolean;
  readonly agentRulePaths: readonly string[] | undefined;
}

type DispatchOutcome =
  | { readonly kind: "record"; readonly record: TaskExecutionRecord }
  | { readonly kind: "deferred"; readonly deferral: DeferredTaskRecord };

type PersistedResult =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly detail: string }
  | {
      readonly kind: "valid";
      readonly outcome: Extract<TaskStatus, "review" | "blocked">;
      readonly reason: string;
    };

/**
 * Reconcile durable attempts, then either claim new work (`run`) or continue
 * interrupted attempts (`resume`). Every model and worktree side effect happens
 * with the project lock released.
 */
export async function executeProject(input: ExecutionInput): Promise<ExecutionSummary> {
  const root = resolve(input.root);
  const now = input.now ?? ((): Date => new Date());

  // Both refusals happen before any task state changes.
  await assertApprovedPlan(root);
  assertWorkspaceCapableWorkerRoute(input.runner);

  const context: ExecutionContext = {
    root,
    mode: input.mode,
    config: input.config,
    runner: input.runner,
    workspace: input.workspace,
    actor: input.actor,
    runId: input.runId ?? defaultRunId(now()),
    now,
    env: input.env ?? process.env,
    caseSensitive: input.caseSensitive ?? process.platform !== "win32",
    agentRulePaths: input.agentRulePaths,
  };
  assertRunId(context.runId);

  const reconciliation = await reconcileAttempts(context);
  const claims = context.mode === "run" ? await claimReadyTasks(context) : [];

  // Deferral reasons are captured while every claim is still `active`, so an
  // owned-path conflict is not misreported as idle capacity once the dispatch
  // that caused it has already reached review.
  const deferred = [
    ...reconciliation.deferred,
    ...(await describeUndispatchedWork(context, await readProjectState(root))),
  ];

  const dispatched = await Promise.all([
    ...reconciliation.resumable.map(async (candidate) =>
      resumeAttempt(context, candidate.task, candidate.manifest),
    ),
    ...claims.map(async (claimed) => dispatch(context, claimed, "dispatched")),
  ]);

  const state = await readProjectState(root);
  // A crash between the canonical state write and the handoff write leaves a
  // stale SESSION.md that no later transition would repair on its own.
  await withProjectLock(root, "execution handoff render", async () => {
    await writeSession(root, await readProjectState(root));
  });

  return {
    mode: context.mode,
    runId: context.runId,
    maxConcurrency: context.config.roles.worker.maxConcurrency,
    records: [
      ...reconciliation.records,
      ...dispatched.flatMap((outcome) => (outcome.kind === "record" ? [outcome.record] : [])),
    ],
    deferred: [
      ...deferred,
      ...dispatched.flatMap((outcome) => (outcome.kind === "deferred" ? [outcome.deferral] : [])),
    ],
    reviewReady: state.tasks.filter((task) => task.status === "review").map((task) => task.id),
    blocked: state.tasks.filter((task) => task.status === "blocked").map((task) => task.id),
    orphanAttempts: reconciliation.orphanAttempts,
  };
}

export function executionExitCode(summary: ExecutionSummary): 0 | 1 {
  const failed =
    summary.records.some((record) => record.status === "blocked") ||
    summary.deferred.some((record) => record.reason === "unreconciled");
  return failed ? 1 : 0;
}

export function executionDidWork(summary: ExecutionSummary): boolean {
  return summary.records.length > 0;
}

async function assertApprovedPlan(root: string): Promise<void> {
  let artifact: PlanningArtifact;
  try {
    artifact = await readPlanningArtifact(root);
  } catch (error: unknown) {
    throw new ExecutionRefusedError(
      `Delegated execution requires an approved plan: ${messageOf(error)}`,
    );
  }
  if (artifact.status !== "approved" || artifact.approval === null) {
    throw new ExecutionRefusedError(
      `Planning revision ${artifact.revision} is ${artifact.status}, not approved. Run \`draftforge plan --approve --by <actor>\` before dispatching workers.`,
    );
  }
}

interface ResumableAttempt {
  readonly task: TaskState;
  readonly manifest: ExecutionAttemptManifest;
}

interface ReconciliationOutcome {
  readonly records: readonly TaskExecutionRecord[];
  readonly deferred: readonly DeferredTaskRecord[];
  readonly orphanAttempts: readonly string[];
  /** Interrupted attempts `resume` may continue; always empty for `run`. */
  readonly resumable: readonly ResumableAttempt[];
}

/**
 * Resolve every durable crash boundary from the manifest plus its persisted
 * result. An event is evidence, never authority: acceptance is inferred from a
 * validated result artifact alone.
 */
async function reconcileAttempts(context: ExecutionContext): Promise<ReconciliationOutcome> {
  const state = await readProjectState(context.root);
  const records: TaskExecutionRecord[] = [];
  const deferred: DeferredTaskRecord[] = [];
  const resumable: ResumableAttempt[] = [];

  for (const task of state.tasks) {
    const reference = task.attempt;
    if (reference === null) {
      if (task.status === "active") {
        deferred.push({
          taskId: task.id,
          reason: "unreconciled",
          detail: "Active task carries no attempt reference; resolve it by hand before dispatching.",
        });
      }
      continue;
    }
    if (task.status !== "active" && task.status !== "review" && task.status !== "blocked") {
      continue;
    }

    let manifest: ExecutionAttemptManifest;
    try {
      manifest = await readExecutionAttemptManifest(context.root, reference);
    } catch (error: unknown) {
      if (task.status === "active") {
        deferred.push({
          taskId: task.id,
          reason: "unreconciled",
          detail: `Attempt manifest is unreadable: ${messageOf(error)}`,
        });
      }
      continue;
    }

    const result = await readPersistedResult(context.root, manifest);

    if (task.status !== "active") {
      // Crash after the canonical state write: the terminal manifest lifecycle
      // is the only thing still trailing the task.
      if (result.kind === "valid" && manifest.lifecycle !== task.status) {
        await updateExecutionAttemptManifest(context.root, reference, {
          lifecycle: task.status,
          now: context.now(),
        });
        records.push({
          taskId: task.id,
          attempt: reference,
          disposition: "finalized",
          status: task.status,
          detail: "Attempt manifest lifecycle was resynchronized with canonical state.",
        });
      }
      continue;
    }

    if (result.kind === "invalid") {
      deferred.push({ taskId: task.id, reason: "unreconciled", detail: result.detail });
      continue;
    }
    if (result.kind === "valid") {
      const status = await finalizeAttemptFromRecord(context, task, reference, result.outcome);
      records.push({
        taskId: task.id,
        attempt: reference,
        disposition: "finalized",
        status,
        detail: `Persisted worker result (${result.reason}) was finalized without another model call.`,
      });
      continue;
    }

    const contractDrift = await contractDriftDetail(context.root, task, manifest);
    if (contractDrift !== null) {
      deferred.push({ taskId: task.id, reason: "unreconciled", detail: contractDrift });
      continue;
    }
    if (await hasWorkerResultEvent(context.root, reference)) {
      // Result artifacts are written before their event, so an event without an
      // artifact means evidence was lost. Neither accept nor redispatch.
      deferred.push({
        taskId: task.id,
        reason: "unreconciled",
        detail: "Attempt recorded a worker result event but its result artifact is missing; inspect the attempt before resuming.",
      });
      continue;
    }
    if (context.mode === "run") {
      deferred.push({
        taskId: task.id,
        reason: "in-flight",
        detail: `Attempt ${reference.attemptId} is unfinished and occupies a worker slot; run \`draftforge resume\` to continue it.`,
      });
      continue;
    }

    const uncertain = await uncertainProcessId(context.root, reference);
    if (uncertain !== null) {
      const liveness = await context.workspace.processLiveness({ processId: uncertain });
      if (liveness !== "not-found") {
        deferred.push({
          taskId: task.id,
          reason: "worker-process-live",
          detail: `Worker process ${uncertain} is ${liveness}; the attempt and its worktree were preserved instead of redispatched.`,
        });
        continue;
      }
    }
    resumable.push({ task, manifest });
  }

  return {
    records,
    deferred,
    resumable,
    orphanAttempts: await findOrphanAttempts(context.root, state),
  };
}

/**
 * Re-dispatch one interrupted attempt against its own identity and worktree.
 * The manifest is passed through as-is: a `claimed` manifest still carries no
 * base commit (fresh dispatch), and a `running` manifest already carries the
 * base commit recorded before the crash, which the worker seam trusts and
 * cross-checks against the recovered workspace instead of rederiving it.
 */
async function resumeAttempt(
  context: ExecutionContext,
  task: TaskState,
  manifest: ExecutionAttemptManifest,
): Promise<DispatchOutcome> {
  const reference: AttemptReference = { runId: manifest.runId, attemptId: manifest.attemptId };
  let contract: TaskContract;
  try {
    contract = await readTaskContract(context.root, task);
    await confirmResumeOwnership(context, task, manifest, reference);
  } catch (error: unknown) {
    return {
      kind: "deferred",
      deferral: {
        taskId: task.id,
        reason: "unreconciled",
        detail: `Attempt could not be prepared for resume: ${messageOf(error)}`,
      },
    };
  }

  const claimed: ClaimedTaskAttempt = {
    task: { ...task, status: "active", attempt: reference },
    contract,
    manifest,
  };
  return dispatch(context, claimed, "resumed");
}

/**
 * Re-check ownership under the project lock before resuming: a task that no
 * longer owns this attempt must never be redispatched. Records durable
 * evidence of the resume (`worker.attempt.resumed`) with the lifecycle and
 * base commit as they stood before the resume, since that is what previously
 * justified the rewind this replaces.
 */
async function confirmResumeOwnership(
  context: ExecutionContext,
  task: TaskState,
  manifest: ExecutionAttemptManifest,
  reference: AttemptReference,
): Promise<void> {
  return withProjectLock(context.root, "attempt resume ownership check", async () => {
    const state = await readProjectState(context.root);
    const current = state.tasks.find((candidate) => candidate.id === task.id);
    if (
      current?.status !== "active" ||
      current.attempt?.runId !== reference.runId ||
      current.attempt.attemptId !== reference.attemptId
    ) {
      throw new Error(
        `Cannot resume ${task.id}: it no longer owns attempt ${reference.runId}/${reference.attemptId}.`,
      );
    }
    const now = context.now();
    await appendAttemptEvent(
      context.root,
      reference,
      {
        id: "worker-attempt-resumed",
        timestamp: now.toISOString(),
        type: "worker.attempt.resumed",
        data: {
          taskId: task.id,
          previousLifecycle: manifest.lifecycle,
          previousBaseCommit: manifest.baseCommit,
        },
      },
      context.env,
    );
  });
}

/** Claim under the lock, one task at a time; nothing else runs concurrently. */
async function claimReadyTasks(context: ExecutionContext): Promise<readonly ClaimedTaskAttempt[]> {
  const claims: ClaimedTaskAttempt[] = [];
  for (;;) {
    const claimed = await claimTaskAttempt(context.root, {
      runId: context.runId,
      actor: context.actor,
      config: context.config,
      now: context.now(),
      caseSensitive: context.caseSensitive,
    });
    if (claimed === null) {
      return claims;
    }
    claims.push(claimed);
  }
}

async function dispatch(
  context: ExecutionContext,
  claimed: ClaimedTaskAttempt,
  disposition: Extract<TaskDisposition, "dispatched" | "resumed">,
): Promise<DispatchOutcome> {
  const reference: AttemptReference = {
    runId: claimed.manifest.runId,
    attemptId: claimed.manifest.attemptId,
  };
  let outcome: WorkerExecutionOutcome;
  try {
    outcome = await executeClaimedWorker({
      root: context.root,
      claimed,
      runner: context.runner,
      workspace: context.workspace,
      actor: context.actor,
      now: context.now(),
      env: context.env,
      caseSensitive: context.caseSensitive,
      ...(context.agentRulePaths === undefined ? {} : { agentRulePaths: context.agentRulePaths }),
    });
  } catch (error: unknown) {
    // The worker seam keeps the task active and its evidence durable when it
    // refuses; surface it without failing the sibling dispatches.
    return {
      kind: "deferred",
      deferral: {
        taskId: claimed.task.id,
        reason: "unreconciled",
        detail: `Attempt ${reference.attemptId} was not applied: ${messageOf(error)}`,
      },
    };
  }
  return {
    kind: "record",
    record: {
      taskId: claimed.task.id,
      attempt: reference,
      disposition,
      // A worker result never advances past review; Phase 5 owns acceptance.
      status: outcome.transition,
      detail:
        outcome.transition === "active"
          ? "Worker termination could not be confirmed; the attempt and its worktree were preserved."
          : outcome.scopeViolations.length > 0
            ? `Changed paths outside the contract: ${outcome.scopeViolations.join(", ")}.`
            : `Authoritative changed paths: ${outcome.authoritativeChangedPaths.length}.`,
    },
  };
}

async function finalizeAttemptFromRecord(
  context: ExecutionContext,
  task: TaskState,
  reference: AttemptReference,
  outcome: Extract<TaskStatus, "review" | "blocked">,
): Promise<TaskStatus> {
  return withProjectLock(context.root, "attempt reconciliation", async () => {
    const state = await readProjectState(context.root);
    const current = state.tasks.find((candidate) => candidate.id === task.id);
    if (current === undefined) {
      throw new Error(`Unknown task: ${task.id}.`);
    }
    if (current.status !== "active") {
      // Another reconciliation already applied this record.
      return current.status;
    }
    if (
      current.attempt?.runId !== reference.runId ||
      current.attempt.attemptId !== reference.attemptId
    ) {
      throw new Error(
        `Cannot reconcile ${task.id}: it no longer owns attempt ${reference.runId}/${reference.attemptId}.`,
      );
    }
    const now = context.now();
    await updateExecutionAttemptManifest(context.root, reference, { lifecycle: outcome, now });
    const next = transitionTask(state, task.id, outcome);
    const event: RunEvent = {
      schemaVersion: 1,
      timestamp: now.toISOString(),
      type: "task.transition",
      data: {
        taskId: task.id,
        from: "active",
        to: outcome,
        actor: context.actor,
        metadata: {
          attemptId: reference.attemptId,
          resultArtifact: attemptResultPath(reference),
          reconciled: true,
        },
      },
    };
    await appendRunEvent(context.root, reference.runId, event, context.env);
    await writeProjectState(context.root, next);
    await writeSession(context.root, next);
    return outcome;
  });
}

async function describeUndispatchedWork(
  context: ExecutionContext,
  state: ProjectState,
): Promise<readonly DeferredTaskRecord[]> {
  const phase = state.workflow.phaseId.slice(-2);
  const deferred: DeferredTaskRecord[] = [];
  const active = state.tasks.filter((task) => task.status === "active");
  const slots = Math.max(0, context.config.roles.worker.maxConcurrency - active.length);
  const activeContracts = new Map<string, TaskContract>();
  for (const task of active) {
    const contract = await readContractIfValid(context.root, task);
    if (contract !== null) {
      activeContracts.set(task.id, contract);
    }
  }

  for (const task of state.tasks) {
    if (task.id.slice(1, 3) !== phase || (task.status !== "ready" && task.status !== "backlog")) {
      continue;
    }
    const pending = task.dependsOn.filter(
      (dependency) =>
        state.tasks.find((candidate) => candidate.id === dependency)?.status !== "done",
    );
    if (pending.length > 0) {
      deferred.push({
        taskId: task.id,
        reason: "dependency",
        detail: `Waiting on ${pending.join(", ")}.`,
      });
      continue;
    }
    if (task.status !== "ready") {
      continue;
    }
    if (context.mode === "resume") {
      deferred.push({
        taskId: task.id,
        reason: "run-required",
        detail: "Resume continues existing attempts only; run `draftforge run` to claim it.",
      });
      continue;
    }
    const contract = await readContractIfValid(context.root, task);
    if (contract === null) {
      deferred.push({
        taskId: task.id,
        reason: "unreconciled",
        detail: "Task contract could not be parsed; the task was not claimed.",
      });
      continue;
    }
    const blocking = [...activeContracts].find(([, candidate]) =>
      ownedPathsConflict(contract.ownedPaths, candidate.ownedPaths, context.caseSensitive),
    );
    deferred.push(
      blocking === undefined
        ? {
            taskId: task.id,
            reason: "capacity",
            detail: `No worker slot is free (${active.length}/${context.config.roles.worker.maxConcurrency} active, ${slots} free).`,
          }
        : {
            taskId: task.id,
            reason: "owned-path-conflict",
            detail: `Owned paths overlap active ${blocking[0]}.`,
          },
    );
  }
  return deferred;
}

async function readContractIfValid(root: string, task: TaskState): Promise<TaskContract | null> {
  try {
    return await readTaskContract(root, task);
  } catch {
    return null;
  }
}

async function contractDriftDetail(
  root: string,
  task: TaskState,
  manifest: ExecutionAttemptManifest,
): Promise<string | null> {
  try {
    const contents = await readFile(resolve(root, task.taskFile), "utf8");
    if (hashTaskContract(contents) !== manifest.contractHash) {
      return "Task contract changed after the attempt was claimed; the attempt was preserved instead of resumed.";
    }
    return null;
  } catch (error: unknown) {
    return `Task contract could not be read for the in-flight attempt: ${messageOf(error)}`;
  }
}

async function readPersistedResult(
  root: string,
  manifest: ExecutionAttemptManifest,
): Promise<PersistedResult> {
  const reference: AttemptReference = { runId: manifest.runId, attemptId: manifest.attemptId };
  let raw: string;
  try {
    raw = await readFile(resolve(root, attemptResultPath(reference)), "utf8");
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT")) {
      return { kind: "absent" };
    }
    return { kind: "invalid", detail: `Attempt result is unreadable: ${messageOf(error)}` };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { kind: "invalid", detail: "Attempt result artifact is not valid JSON." };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { kind: "invalid", detail: "Attempt result artifact is not a JSON object." };
  }
  const record = value as Record<string, unknown>;
  if (record.taskId !== manifest.taskId || record.attemptId !== manifest.attemptId) {
    return { kind: "invalid", detail: "Attempt result artifact belongs to a different attempt." };
  }
  if (record.outcome === "active") {
    // Preserved evidence for an attempt whose worker never reported an outcome.
    return { kind: "absent" };
  }
  if (record.outcome !== "review" && record.outcome !== "blocked") {
    return { kind: "invalid", detail: "Attempt result artifact declares an unsupported outcome." };
  }
  return {
    kind: "valid",
    outcome: record.outcome,
    reason: typeof record.reason === "string" ? record.reason : "unspecified",
  };
}

async function attemptEvents(
  root: string,
  reference: AttemptReference,
): Promise<readonly Record<string, unknown>[]> {
  let raw: string;
  try {
    raw = await readFile(resolve(root, attemptEventPath(reference)), "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        const value: unknown = JSON.parse(line);
        return typeof value === "object" && value !== null && !Array.isArray(value)
          ? [value as Record<string, unknown>]
          : [];
      } catch {
        return [];
      }
    });
}

async function hasWorkerResultEvent(
  root: string,
  reference: AttemptReference,
): Promise<boolean> {
  return (await attemptEvents(root, reference)).some((event) => event.type === "worker.result");
}

async function uncertainProcessId(
  root: string,
  reference: AttemptReference,
): Promise<number | null> {
  for (const event of await attemptEvents(root, reference)) {
    if (event.type !== "worker.termination-uncertain") {
      continue;
    }
    const data = event.data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      continue;
    }
    const termination = (data as Record<string, unknown>).termination;
    if (typeof termination !== "object" || termination === null || Array.isArray(termination)) {
      continue;
    }
    const processId = (termination as Record<string, unknown>).processId;
    if (typeof processId === "number" && Number.isInteger(processId)) {
      return processId;
    }
  }
  return null;
}

/**
 * Manifests still claimed or running that no canonical task owns. They are
 * reported, never acted on: canonical state decides what is dispatchable.
 */
async function findOrphanAttempts(
  root: string,
  state: ProjectState,
): Promise<readonly string[]> {
  const owned = new Set(
    state.tasks.flatMap((task) =>
      task.attempt === null ? [] : [`${task.attempt.runId}/${task.attempt.attemptId}`],
    ),
  );
  const runsRoot = resolve(root, ".draftforge", "runs");
  let runIds: readonly string[];
  try {
    runIds = (await readdir(runsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const orphans: string[] = [];
  for (const runId of runIds) {
    let files: readonly string[];
    try {
      files = (await readdir(resolve(runsRoot, runId, "attempts"), { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !entry.name.endsWith(".result.json"))
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const file of files) {
      const attemptId = file.slice(0, -".json".length);
      if (owned.has(`${runId}/${attemptId}`)) {
        continue;
      }
      try {
        const manifest = await readExecutionAttemptManifest(root, { runId, attemptId });
        if (manifest.lifecycle === "claimed" || manifest.lifecycle === "running") {
          orphans.push(`${runId}/${attemptId}`);
        }
      } catch {
        orphans.push(`${runId}/${attemptId}`);
      }
    }
  }
  return orphans.sort((left, right) => left.localeCompare(right, "en"));
}

function defaultRunId(now: Date): string {
  return `run-${now.toISOString().replaceAll(/[^0-9A-Za-z]/gu, "")}`;
}

function assertRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId) || runId === "." || runId === "..") {
    throw new Error("runId must contain only letters, numbers, dots, underscores, or hyphens.");
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

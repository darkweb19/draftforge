import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ProjectConfig } from "../config/config.js";
import type { AttemptReference, ExecutionAttemptManifest } from "../domain/execution.js";
import { assertProjectState, type ProjectState, type TaskState } from "../domain/state.js";
import {
  ownedPathsConflict,
  readTaskContract,
  type TaskContract,
} from "./task-contract.js";
import {
  createExecutionAttemptManifest,
  hashTaskContract,
  writeExecutionAttemptManifest,
} from "../state/execution.js";
import { appendRunEvent, type RunEvent } from "../state/events.js";
import { readProjectState, writeProjectState, writeSession } from "../state/files.js";
import { withProjectLock } from "../state/lock.js";

export interface SchedulerOptions {
  /** Tests and cross-platform callers can explicitly select repository semantics. */
  readonly caseSensitive?: boolean;
}

export interface SchedulableTask {
  readonly task: TaskState;
  readonly contract: TaskContract;
}

export interface ClaimTaskAttemptInput extends SchedulerOptions {
  readonly runId: string;
  readonly actor: string;
  readonly config: ProjectConfig;
  readonly now?: Date;
  readonly attemptId?: string;
}

export interface ClaimedTaskAttempt {
  readonly task: TaskState;
  readonly contract: TaskContract;
  readonly manifest: ExecutionAttemptManifest;
}

/**
 * Move dependency-satisfied tasks in the active phase into ready. This pure
 * helper intentionally leaves active/review work alone, making it safe to run
 * under every claim lock.
 */
export function recomputeTaskReadiness(state: ProjectState): ProjectState {
  assertProjectState(state);
  const tasks = state.tasks.map((task) => {
    if (
      task.status === "backlog" &&
      task.id.slice(1, 3) === state.workflow.phaseId.slice(-2) &&
      task.dependsOn.every((dependency) => state.tasks.find((candidate) => candidate.id === dependency)?.status === "done")
    ) {
      return { ...task, status: "ready" as const };
    }
    return task;
  });
  const nextTask = tasks.find((task) => task.status === "ready")?.id ?? null;
  const next: ProjectState = {
    ...state,
    workflow: { ...state.workflow, nextTask },
    tasks,
  };
  assertProjectState(next);
  return next;
}

/** Select available work without making a claim or performing side effects. */
export function selectSchedulableTasks(
  state: ProjectState,
  contracts: ReadonlyMap<string, TaskContract>,
  maxConcurrency: number,
  options: SchedulerOptions = {},
): readonly SchedulableTask[] {
  assertProjectState(state);
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error("Worker maxConcurrency must be a positive integer.");
  }
  const caseSensitive = options.caseSensitive ?? process.platform !== "win32";
  // Older snapshots can migrate an interrupted active task to an explicit
  // null attempt. Count it conservatively instead of accidentally overbooking
  // the worker pool while a human reconciles that legacy state.
  const active = state.tasks.filter((task) => task.status === "active");
  const slots = Math.max(0, maxConcurrency - active.length);
  if (slots === 0) {
    return [];
  }

  const activeContracts = active.map((task) => {
    const contract = contracts.get(task.id);
    if (contract === undefined) {
      throw new Error(`Active task ${task.id} has no validated contract.`);
    }
    return contract;
  });
  const selected: SchedulableTask[] = [];
  for (const task of state.tasks) {
    if (selected.length === slots || task.status !== "ready" || task.attempt !== null && task.attempt !== undefined) {
      continue;
    }
    if (task.id.slice(1, 3) !== state.workflow.phaseId.slice(-2)) {
      continue;
    }
    if (!task.dependsOn.every((dependency) => state.tasks.find((candidate) => candidate.id === dependency)?.status === "done")) {
      continue;
    }
    const contract = contracts.get(task.id);
    if (contract === undefined) {
      throw new Error(`Ready task ${task.id} has no validated contract.`);
    }
    if (
      activeContracts.some((activeContract) => ownedPathsConflict(contract.ownedPaths, activeContract.ownedPaths, caseSensitive)) ||
      selected.some((candidate) => ownedPathsConflict(contract.ownedPaths, candidate.contract.ownedPaths, caseSensitive))
    ) {
      continue;
    }
    selected.push({ task, contract });
  }
  return selected;
}

/**
 * Claim exactly one ready task. The only side effects performed under the
 * project lock are reading contracts and atomically persisting its manifest,
 * state and event; worktree/model side effects happen after this function.
 */
export async function claimTaskAttempt(
  root: string,
  input: ClaimTaskAttemptInput,
): Promise<ClaimedTaskAttempt | null> {
  assertClaimInput(input);
  return withProjectLock(root, "task attempt claim", async () => {
    const now = input.now ?? new Date();
    if (Number.isNaN(now.getTime())) {
      throw new Error("Attempt timestamp must be a valid date.");
    }
    const current = await readProjectState(root);
    const state = recomputeTaskReadiness(current);
    const contracts = await readActiveContracts(root, state);
    const candidate = selectSchedulableTasks(
      state,
      contracts,
      input.config.roles.worker.maxConcurrency,
      input,
    )[0];
    if (candidate === undefined) {
      if (state !== current) {
        await writeProjectState(root, state);
        await writeSession(root, state);
      }
      return null;
    }
    const reference: AttemptReference = {
      runId: input.runId,
      attemptId: input.attemptId ?? `${candidate.task.id.toLowerCase()}-${randomUUID()}`,
    };
    const contractContents = await readFile(resolve(root, candidate.task.taskFile), "utf8");
    const manifest = createExecutionAttemptManifest({
      reference,
      taskId: candidate.task.id,
      contractHash: hashTaskContract(contractContents),
      now,
      budget: effectiveTaskBudget(candidate.contract.budget, input.config.limits.taskTimeoutMinutes),
    });
    // This write precedes canonical state reference by design, providing the
    // crash boundary required for explicit resume.
    await writeExecutionAttemptManifest(root, manifest);
    const claimedTask: TaskState = { ...candidate.task, status: "active", attempt: reference };
    const tasks = state.tasks.map((task) => task.id === claimedTask.id ? claimedTask : task);
    const next: ProjectState = {
      ...state,
      workflow: {
        ...state.workflow,
        status: "in_progress",
        currentTask: claimedTask.id,
        nextTask: tasks.find((task) => task.status === "ready" && task.id !== claimedTask.id)?.id ?? null,
      },
      tasks,
    };
    assertProjectState(next);
    const event: RunEvent = {
      schemaVersion: 1,
      timestamp: now.toISOString(),
      type: "task.attempt.claimed",
      data: {
        taskId: claimedTask.id,
        runId: reference.runId,
        attemptId: reference.attemptId,
        contractHash: manifest.contractHash,
      },
    };
    await appendRunEvent(root, input.runId, event);
    await writeProjectState(root, next);
    await writeSession(root, next);
    return { task: claimedTask, contract: candidate.contract, manifest };
  });
}

export function effectiveTaskBudget(
  budget: TaskContract["budget"],
  fallbackTimeMinutes: number,
): NonNullable<TaskContract["budget"]> {
  if (!Number.isInteger(fallbackTimeMinutes) || fallbackTimeMinutes < 1) {
    throw new Error("Task timeout fallback must be a positive integer.");
  }
  return { ...budget, timeMinutes: budget?.timeMinutes ?? fallbackTimeMinutes };
}

async function readActiveContracts(
  root: string,
  state: ProjectState,
): Promise<ReadonlyMap<string, TaskContract>> {
  const candidates = state.tasks.filter((task) =>
    task.status === "ready" || task.status === "active",
  );
  const entries = await Promise.all(candidates.map(async (task) => [task.id, await readTaskContract(root, task)] as const));
  return new Map(entries);
}

function assertClaimInput(input: ClaimTaskAttemptInput): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.runId) || input.runId === "." || input.runId === "..") {
    throw new Error("runId must contain only letters, numbers, dots, underscores, or hyphens.");
  }
  if (input.attemptId !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.attemptId) || input.attemptId === "." || input.attemptId === "..")) {
    throw new Error("attemptId must contain only letters, numbers, dots, underscores, or hyphens.");
  }
  if (input.actor.trim().length === 0) {
    throw new Error("Attempt claim actor must be a non-empty string.");
  }
}

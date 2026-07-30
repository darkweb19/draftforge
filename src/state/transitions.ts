import type { ProjectState, TaskState, TaskStatus } from "../domain/state.js";
import { appendRunEvent, type RunEvent } from "./events.js";
import { readProjectState, writeProjectState, writeSession } from "./files.js";
import { withProjectLock } from "./lock.js";

const ALLOWED_TRANSITIONS = {
  backlog: ["ready"],
  ready: ["active"],
  active: ["review", "blocked"],
  review: ["done", "blocked", "active"],
  blocked: ["ready"],
  done: [],
} as const satisfies Record<TaskStatus, readonly TaskStatus[]>;

/** Automation performs every transition except a `blocked -> ready` reopen. */
export type ActorKind = "automation" | "human";

export interface TaskTransitionInput {
  readonly taskId: string;
  readonly to: TaskStatus;
  readonly runId: string;
  readonly actor: string;
  readonly now?: Date;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly actorKind?: ActorKind;
}

export function transitionTask(
  state: ProjectState,
  taskId: string,
  to: TaskStatus,
  actorKind: ActorKind = "automation",
): ProjectState {
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  if (task === undefined) {
    throw new Error(`Unknown task: ${taskId}.`);
  }

  const allowed = ALLOWED_TRANSITIONS[task.status] as readonly TaskStatus[];
  if (!allowed.includes(to)) {
    throw new Error(`Illegal task transition for ${taskId}: ${task.status} -> ${to}.`);
  }

  if (task.status === "blocked" && to === "ready" && actorKind !== "human") {
    throw new Error(
      `${taskId} cannot reopen from blocked to ready by automation; this reopen must be performed by a human or architect action.`,
    );
  }

  if (to === "ready") {
    const incomplete = task.dependsOn.filter(
      (dependencyId) => state.tasks.find((candidate) => candidate.id === dependencyId)?.status !== "done",
    );
    if (incomplete.length > 0) {
      throw new Error(`${taskId} cannot become ready until dependencies are done: ${incomplete.join(", ")}.`);
    }
  }

  const tasks = state.tasks.map((candidate) =>
    candidate.id === taskId ? { ...candidate, status: to } : candidate,
  );

  return {
    ...state,
    workflow: transitionWorkflow(state, taskId, task.status, to, tasks),
    tasks,
  };
}

export async function applyTaskTransition(root: string, input: TaskTransitionInput): Promise<ProjectState> {
  return withProjectLock(root, "task transition", async () => {
    const state = await readProjectState(root);
    const previous = state.tasks.find((task) => task.id === input.taskId);
    if (previous === undefined) {
      throw new Error(`Unknown task: ${input.taskId}.`);
    }

    const actorKind: ActorKind = input.actorKind ?? "automation";
    const next = transitionTask(state, input.taskId, input.to, actorKind);
    const now = input.now ?? new Date();
    if (Number.isNaN(now.getTime())) {
      throw new Error("Transition timestamp must be a valid date.");
    }
    if (input.actor.trim().length === 0) {
      throw new Error("Transition actor must be a non-empty string.");
    }

    const event: RunEvent = {
      schemaVersion: 1,
      timestamp: now.toISOString(),
      type: "task.transition",
      data: {
        taskId: input.taskId,
        from: previous.status,
        to: input.to,
        actor: input.actor,
        actorKind,
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      },
    };

    await appendRunEvent(root, input.runId, event);
    await writeProjectState(root, next);
    await writeSession(root, next);
    return next;
  });
}

function transitionWorkflow(
  state: ProjectState,
  taskId: string,
  from: TaskStatus,
  to: TaskStatus,
  tasks: readonly TaskState[],
): ProjectState["workflow"] {
  if (to === "ready") {
    if (from === "blocked") {
      // A reopen resumes the project and misreports nothing as blocked; leaving
      // the reopened task recorded as `currentTask` would misreport progress.
      return {
        ...state.workflow,
        status: "in_progress",
        currentTask: state.workflow.currentTask === taskId ? null : state.workflow.currentTask,
        nextTask: state.workflow.nextTask ?? taskId,
      };
    }
    return { ...state.workflow, nextTask: state.workflow.nextTask ?? taskId };
  }
  if (to === "active") {
    return {
      ...state.workflow,
      status: "in_progress",
      currentTask: taskId,
      nextTask: state.workflow.nextTask === taskId ? null : state.workflow.nextTask,
    };
  }
  if (to === "review") {
    return { ...state.workflow, currentTask: taskId };
  }
  if (to === "blocked") {
    return { ...state.workflow, status: "blocked", currentTask: taskId };
  }

  const nextTask = tasks.find((task) => task.status === "ready")?.id ?? null;
  return {
    ...state.workflow,
    // Completing a task does not implicitly complete or advance its phase;
    // that is a separate, recorded orchestration decision.
    status: "in_progress",
    currentTask: state.workflow.currentTask === taskId ? null : state.workflow.currentTask,
    nextTask,
  };
}

/**
 * Deterministic doubles for Phase 4 orchestration tests. Nothing here spawns a
 * process, touches the network, or reads a provider credential.
 */
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import type { ModelRequest, ModelResponse, ModelRunner } from "../../../src/application/ports.js";
import type {
  CreateOrRecoverWorkspaceOptions,
  ProcessLiveness,
  WorkspaceAttempt,
  WorkspaceCleanupResult,
  WorkspaceInspection,
  WorkspaceLocation,
  WorkspacePort,
} from "../../../src/application/workspace.js";
import { materializeProject, type ProjectSpec } from "./project.js";

export const BASE_COMMIT = "b".repeat(40);

/** Create an isolated sample project that is always removed, including on failure. */
export async function createExecutionProject(t: TestContext, spec: ProjectSpec): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "draftforge-execution-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await materializeProject(root, spec);
  return root;
}

export type WorkerBehaviour =
  | { readonly kind: "completed"; readonly changedPaths?: readonly string[] }
  | { readonly kind: "blocked"; readonly summary?: string }
  | { readonly kind: "raw"; readonly text: string }
  | { readonly kind: "throw"; readonly error: unknown };

export interface FakeWorkerRunnerOptions {
  readonly workspaceAccess?: boolean;
  /** Awaited after a request is observed and before its response is produced. */
  readonly onStart?: (taskId: string) => Promise<void>;
}

export class FakeWorkerRunner implements ModelRunner {
  readonly requests: ModelRequest[] = [];
  readonly startOrder: string[] = [];
  readonly finishOrder: string[] = [];
  peakConcurrency = 0;
  #inFlight = 0;
  readonly #behaviours: ReadonlyMap<string, WorkerBehaviour>;
  readonly #options: FakeWorkerRunnerOptions;

  constructor(
    behaviours: Readonly<Record<string, WorkerBehaviour>>,
    options: FakeWorkerRunnerOptions = {},
  ) {
    this.#behaviours = new Map(Object.entries(behaviours));
    this.#options = options;
  }

  capabilities(): { readonly workspaceAccess: boolean } {
    return { workspaceAccess: this.#options.workspaceAccess ?? true };
  }

  get callCount(): number {
    return this.requests.length;
  }

  async run(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const taskId = field(request.user, "Task ID");
    const attemptId = field(request.user, "Attempt ID");
    this.startOrder.push(taskId);
    this.#inFlight += 1;
    this.peakConcurrency = Math.max(this.peakConcurrency, this.#inFlight);
    try {
      await this.#options.onStart?.(taskId);
      const behaviour = this.#behaviours.get(taskId) ?? { kind: "completed" as const };
      if (behaviour.kind === "throw") {
        throw behaviour.error;
      }
      if (behaviour.kind === "raw") {
        return { text: behaviour.text };
      }
      return {
        text: JSON.stringify({
          taskId,
          attemptId,
          status: behaviour.kind === "completed" ? "completed" : "blocked",
          summary: behaviour.kind === "completed" ? "Implemented." : behaviour.summary ?? "Blocked.",
          changedPaths: behaviour.kind === "completed" ? [...(behaviour.changedPaths ?? [])] : [],
          commandsRun: [{ command: "npm test", exitCode: 0, summary: "Tests passed." }],
          evidence: ["Tests passed."],
          risks: [],
          suggestedFollowUps: [],
        }),
      };
    } finally {
      this.#inFlight -= 1;
      this.finishOrder.push(taskId);
    }
  }
}

export interface FakeWorkspaceOptions {
  /** Authoritative changed paths per task ID; defaults to no changes. */
  readonly changedPaths?: Readonly<Record<string, readonly string[]>>;
  /** Task IDs whose worktree recovery fails, simulating an interrupted worktree. */
  readonly unsafeTasks?: readonly string[];
  readonly liveness?: ProcessLiveness;
}

/**
 * Filesystem-backed workspace double. It uses the same deterministic worktree
 * path as `GitWorkspace` so worktree retention and reuse are observable without
 * requiring Git in every test.
 */
export class FakeWorkspace implements WorkspacePort {
  readonly createdTasks: string[] = [];
  readonly recoveredTasks: string[] = [];
  readonly livenessProbes: number[] = [];
  readonly #root: string;
  readonly #options: FakeWorkspaceOptions;

  constructor(root: string, options: FakeWorkspaceOptions = {}) {
    this.#root = resolve(root);
    this.#options = options;
  }

  worktreePath(attempt: WorkspaceAttempt): string {
    return resolve(this.#root, ".draftforge", "runs", attempt.runId, "worktrees", attempt.taskId);
  }

  async createOrRecover(
    attempt: WorkspaceAttempt,
    _options: CreateOrRecoverWorkspaceOptions = {},
  ): Promise<WorkspaceLocation> {
    if (this.#options.unsafeTasks?.includes(attempt.taskId) === true) {
      throw new Error(
        `Workspace at ${this.worktreePath(attempt)} cannot be inspected safely: interrupted worktree.`,
      );
    }
    const path = this.worktreePath(attempt);
    if (await exists(path)) {
      this.recoveredTasks.push(attempt.taskId);
    } else {
      this.createdTasks.push(attempt.taskId);
      await mkdir(path, { recursive: true });
      await writeFile(join(path, "AGENTS.md"), "# Agent rules\n\nStay inside the owned paths.\n", "utf8");
    }
    return {
      attempt,
      path,
      branch: `draftforge/${attempt.runId}/${attempt.taskId}/${attempt.attemptId}`,
      baseCommit: BASE_COMMIT,
    };
  }

  async inspect(attempt: WorkspaceAttempt): Promise<WorkspaceInspection> {
    const changedPaths = this.#changedPaths(attempt.taskId);
    if (!(await exists(this.worktreePath(attempt)))) {
      return { state: "missing", location: undefined, dirty: false, changedPaths: [], reason: undefined };
    }
    return {
      state: "ready",
      location: await this.createOrRecover(attempt),
      dirty: changedPaths.length > 0,
      changedPaths,
      reason: undefined,
    };
  }

  async changedPaths(attempt: WorkspaceAttempt): Promise<readonly string[]> {
    return this.#changedPaths(attempt.taskId);
  }

  async processLiveness(process: { readonly processId: number }): Promise<ProcessLiveness> {
    this.livenessProbes.push(process.processId);
    return this.#options.liveness ?? "not-found";
  }

  async cleanup(): Promise<WorkspaceCleanupResult> {
    return { outcome: "preserved", reason: "Phase 4 retains every attempt worktree." };
  }

  #changedPaths(taskId: string): readonly string[] {
    return this.#options.changedPaths?.[taskId] ?? [];
  }
}

/** Releases all waiters once `size` of them have arrived; fails instead of hanging. */
export function createBarrier(size: number, timeoutMs = 5_000): { arrive: () => Promise<void> } {
  let arrived = 0;
  let release = (): void => {};
  const reached = new Promise<void>((resolveReached) => {
    release = resolveReached;
  });
  return {
    async arrive(): Promise<void> {
      arrived += 1;
      if (arrived >= size) {
        release();
      }
      let timer: NodeJS.Timeout | undefined;
      const expiry = new Promise<never>((_, rejectExpiry) => {
        timer = setTimeout(
          () => rejectExpiry(new Error(`Barrier of ${size} was never reached; only ${arrived} arrived.`)),
          timeoutMs,
        );
      });
      try {
        await Promise.race([reached, expiry]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function field(prompt: string, label: string): string {
  const match = new RegExp(`^- ${label}: (.+)$`, "mu").exec(prompt);
  if (match?.[1] === undefined) {
    throw new Error(`Worker prompt did not declare ${label}.`);
  }
  return match[1].trim();
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

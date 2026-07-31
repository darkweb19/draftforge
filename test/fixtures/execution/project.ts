/**
 * Deterministic Phase 4 sample projects.
 *
 * The same builder feeds the automated tests and the manual built-CLI gate:
 *
 *   node --import tsx test/fixtures/execution/project.ts <variant> <target-dir>
 *
 * Every variant is chosen so the real CLI can be exercised end to end without
 * any provider call: it either refuses before dispatch, has nothing to claim,
 * or only reconciles a persisted result.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AdapterId, ProjectConfig } from "../../../src/config/config.js";
import type { AttemptLifecycle, AttemptReference } from "../../../src/domain/execution.js";
import {
  PROJECT_STATE_SCHEMA_VERSION,
  type ProjectState,
  type TaskState,
  type TaskStatus,
} from "../../../src/domain/state.js";
import { PLANNING_SCHEMA_VERSION, type PlanningArtifact } from "../../../src/domain/planning.js";
import {
  createExecutionAttemptManifest,
  hashTaskContract,
  writeExecutionAttemptManifest,
  writeAttemptResult,
  appendAttemptEvent,
} from "../../../src/state/execution.js";
import { serializeProjectState, writeSession } from "../../../src/state/files.js";

export const FIXTURE_TIME = new Date("2026-07-28T09:00:00.000Z");

export interface TaskSpec {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly ownedPaths: readonly string[];
  readonly dependsOn?: readonly string[];
  readonly attempt?: AttemptReference;
  readonly timeMinutes?: number;
}

export interface ProjectSpec {
  readonly name: string;
  readonly approved: boolean;
  readonly workerAdapter: AdapterId;
  readonly maxConcurrency: number;
  readonly tasks: readonly TaskSpec[];
}

export async function materializeProject(root: string, spec: ProjectSpec): Promise<void> {
  await mkdir(resolve(root, ".draftforge", "tasks"), { recursive: true });
  await write(resolve(root, "idea.md"), "# Idea\n\nA deterministic execution sample.\n");
  await write(resolve(root, "AGENTS.md"), "# Agent rules\n\nStay inside the owned paths.\n");
  await write(
    resolve(root, ".draftforge", "config.json"),
    `${JSON.stringify(projectConfig(spec), null, 2)}\n`,
  );
  await write(
    resolve(root, ".draftforge", "planning.json"),
    `${JSON.stringify(planningArtifact(spec), null, 2)}\n`,
  );
  for (const task of spec.tasks) {
    await write(resolve(root, ".draftforge", "tasks", `${task.id}.md`), taskContract(task));
  }
  const state = projectState(spec);
  await write(resolve(root, ".draftforge", "state.json"), serializeProjectState(state));
  await writeSession(root, state);
}

export function taskContract(task: TaskSpec): string {
  return [
    `# ${task.id} — ${task.title}`,
    "",
    "## Objective",
    "",
    `Deliver ${task.title}.`,
    "",
    "## Owned paths",
    "",
    ...task.ownedPaths.map((path) => `- ${path}`),
    "",
    "## Required context",
    "",
    "- None",
    "",
    "## Relevant ADRs",
    "",
    "- None",
    "",
    "## Dependencies",
    "",
    ...(task.dependsOn === undefined || task.dependsOn.length === 0
      ? ["- None"]
      : task.dependsOn.map((id) => `- ${id}`)),
    "",
    "## Acceptance criteria",
    "",
    `- ${task.title} exists.`,
    "",
    "## Verification",
    "",
    "- npm test",
    "",
    "## Exclusions",
    "",
    "- None",
    "",
    "## Budget",
    "",
    `- timeMinutes: ${task.timeMinutes ?? 5}`,
    "",
  ].join("\n");
}

export function projectState(spec: ProjectSpec): ProjectState {
  const tasks: readonly TaskState[] = spec.tasks.map((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    taskFile: `.draftforge/tasks/${task.id}.md`,
    dependsOn: task.dependsOn ?? [],
    attempt: task.attempt ?? null,
    review: null,
  }));
  return {
    schemaVersion: PROJECT_STATE_SCHEMA_VERSION,
    project: { name: spec.name, draftFile: "idea.md" },
    workflow: {
      phaseId: "phase-04",
      phaseName: "Delegated execution",
      stage: "implementation",
      status: "in_progress",
      currentTask: tasks.find((task) => task.status === "active")?.id ?? null,
      nextTask: tasks.find((task) => task.status === "ready")?.id ?? null,
    },
    phases: [{ id: "phase-04", name: "Delegated execution", status: "in_progress" }],
    tasks,
    decisions: [],
    handoff: {
      updatedAt: FIXTURE_TIME.toISOString(),
      updatedBy: "execution-fixture",
      summary: "Deterministic execution fixture.",
      decisionsLocked: [],
      openQuestions: [],
      blockers: [],
      nextActions: [],
      gotchas: [],
    },
  };
}

/**
 * Seed a durable attempt for a task that canonical state already reports as
 * active, reproducing one specific crash boundary.
 */
export interface SeededAttempt {
  readonly taskId: string;
  readonly reference: AttemptReference;
  /** Omit to stop at the claim boundary. */
  readonly lifecycle?: AttemptLifecycle;
  readonly baseCommit?: string;
  /** Persist a validated worker result artifact. */
  readonly result?: {
    readonly outcome: "review" | "blocked" | "active";
    readonly reason: string;
    readonly changedPaths?: readonly string[];
    readonly scopeViolations?: readonly string[];
  };
  /** Append the worker result event that normally follows the artifact. */
  readonly resultEvent?: boolean;
  readonly terminationUncertainProcessId?: number;
}

export async function seedAttempt(
  root: string,
  spec: ProjectSpec,
  seed: SeededAttempt,
): Promise<void> {
  const task = spec.tasks.find((candidate) => candidate.id === seed.taskId);
  if (task === undefined) {
    throw new Error(`Unknown fixture task: ${seed.taskId}.`);
  }
  const manifest = createExecutionAttemptManifest({
    reference: seed.reference,
    taskId: task.id,
    contractHash: hashTaskContract(taskContract(task)),
    now: FIXTURE_TIME,
    budget: { timeMinutes: task.timeMinutes ?? 5 },
  });
  const lifecycle = seed.lifecycle ?? "claimed";
  await writeExecutionAttemptManifest(root, {
    ...manifest,
    lifecycle,
    baseCommit: seed.baseCommit ?? (lifecycle === "claimed" ? null : "b".repeat(40)),
  });
  if (seed.result !== undefined) {
    await writeAttemptResult(
      root,
      seed.reference,
      {
        schemaVersion: 1,
        taskId: task.id,
        attemptId: seed.reference.attemptId,
        outcome: seed.result.outcome,
        reason: seed.result.reason,
        result: null,
        authoritativeChangedPaths: seed.result.changedPaths ?? [],
        scopeViolations: seed.result.scopeViolations ?? [],
        failure: null,
        termination: null,
      },
      {},
    );
  }
  if (seed.resultEvent === true) {
    await appendAttemptEvent(
      root,
      seed.reference,
      {
        id: "worker-result",
        timestamp: FIXTURE_TIME.toISOString(),
        type: "worker.result",
        data: { taskId: task.id, outcome: seed.result?.outcome ?? "review" },
      },
      {},
    );
  }
  if (seed.terminationUncertainProcessId !== undefined) {
    await appendAttemptEvent(
      root,
      seed.reference,
      {
        id: "worker-termination-uncertain",
        timestamp: FIXTURE_TIME.toISOString(),
        type: "worker.termination-uncertain",
        data: {
          taskId: task.id,
          outcome: "active",
          reason: "termination-uncertain",
          failure: "Worker process termination could not be confirmed.",
          termination: {
            processId: seed.terminationUncertainProcessId,
            definitelyTerminated: false,
          },
        },
      },
      {},
    );
  }
}

function projectConfig(spec: ProjectSpec): ProjectConfig {
  return {
    roles: {
      architect: { adapter: "codex-cli", model: "provider-default", reasoning: "high" },
      worker: {
        adapter: spec.workerAdapter,
        model: "provider-default",
        reasoning: "medium",
        maxConcurrency: spec.maxConcurrency,
      },
      reviewer: { adapter: "codex-cli", model: "provider-default", reasoning: "high" },
    },
    limits: { maxRepairAttempts: 2, taskTimeoutMinutes: 30 },
  };
}

function planningArtifact(spec: ProjectSpec): PlanningArtifact {
  const plan = {
    revision: 1,
    assumptions: ["The sample project is deterministic."],
    decisions: [],
    phases: [
      {
        id: "phase-04",
        name: "Delegated execution",
        objective: "Dispatch bounded worker tasks.",
        exitCriteria: ["Independent tasks run in parallel."],
      },
    ],
    tasks: spec.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      phaseId: "phase-04",
      objective: `Deliver ${task.title}.`,
      dependsOn: task.dependsOn ?? [],
      ownedPaths: [...task.ownedPaths],
      requiredContext: [],
      relevantAdrs: [],
      acceptanceCriteria: [`${task.title} exists.`],
      verification: ["npm test"],
      exclusions: [],
    })),
    risks: [],
    verification: ["npm run check"],
  } as const;

  if (!spec.approved) {
    return {
      schemaVersion: PLANNING_SCHEMA_VERSION,
      revision: 1,
      sourceFile: "idea.md",
      status: "draft",
      questions: { revision: 1, items: [] },
      plan,
      approval: null,
      revisions: [],
      supersededPlan: null,
    };
  }
  return {
    schemaVersion: PLANNING_SCHEMA_VERSION,
    revision: 1,
    sourceFile: "idea.md",
    status: "approved",
    questions: { revision: 1, items: [] },
    plan,
    approval: {
      revision: 1,
      approvedAt: FIXTURE_TIME.toISOString(),
      approvedBy: "execution-fixture",
    },
    revisions: [],
    supersededPlan: null,
  };
}

async function write(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

const ALPHA: TaskSpec = { id: "P04-T01", title: "Alpha", status: "ready", ownedPaths: ["src/alpha"] };
const BETA: TaskSpec = { id: "P04-T02", title: "Beta", status: "ready", ownedPaths: ["src/beta"] };

/** Variants the manual built-CLI gate uses; none of them reaches a provider. */
export const CLI_VARIANTS = {
  unapproved: {
    name: "Unapproved sample",
    approved: false,
    workerAdapter: "claude-cli",
    maxConcurrency: 2,
    tasks: [ALPHA, BETA],
  },
  "api-worker": {
    name: "API worker sample",
    approved: true,
    workerAdapter: "openai-api",
    maxConcurrency: 2,
    tasks: [ALPHA, BETA],
  },
  deferred: {
    name: "Deferred sample",
    approved: true,
    workerAdapter: "claude-cli",
    maxConcurrency: 1,
    tasks: [
      { ...ALPHA, status: "active", attempt: { runId: "run-seed", attemptId: "alpha-01" } },
      BETA,
    ],
  },
  resumable: {
    name: "Resumable sample",
    approved: true,
    workerAdapter: "claude-cli",
    maxConcurrency: 2,
    tasks: [
      { ...ALPHA, status: "active", attempt: { runId: "run-seed", attemptId: "alpha-01" } },
      BETA,
    ],
  },
  "no-work": {
    name: "No-work sample",
    approved: true,
    workerAdapter: "claude-cli",
    maxConcurrency: 2,
    tasks: [{ ...ALPHA, status: "done" }, { ...BETA, status: "review" }],
  },
  /** Safe for the built `review` CLI gate: no reviewer/provider call occurs. */
  "review-no-work": {
    name: "Review no-work sample",
    approved: true,
    workerAdapter: "claude-cli",
    maxConcurrency: 2,
    tasks: [{ ...ALPHA, status: "done" }, { ...BETA, status: "done" }],
  },
} as const satisfies Record<string, ProjectSpec>;

export type CliVariant = keyof typeof CLI_VARIANTS;

export async function materializeCliVariant(root: string, variant: CliVariant): Promise<void> {
  const spec = CLI_VARIANTS[variant];
  await materializeProject(root, spec);
  if (variant === "deferred") {
    // An unfinished attempt that still occupies the single worker slot.
    await seedAttempt(root, spec, {
      taskId: "P04-T01",
      reference: { runId: "run-seed", attemptId: "alpha-01" },
      lifecycle: "running",
    });
  }
  if (variant === "resumable") {
    // A validated result that survived the crash before its state transition.
    await seedAttempt(root, spec, {
      taskId: "P04-T01",
      reference: { runId: "run-seed", attemptId: "alpha-01" },
      lifecycle: "running",
      result: { outcome: "review", reason: "completed", changedPaths: ["src/alpha/index.ts"] },
      resultEvent: true,
    });
  }
}

const [variantArgument, targetArgument] = process.argv.slice(2);
const entryUrl = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (entryUrl === import.meta.url && variantArgument !== undefined && targetArgument !== undefined) {
  if (!Object.hasOwn(CLI_VARIANTS, variantArgument)) {
    throw new Error(`Unknown fixture variant: ${variantArgument}. Expected one of ${Object.keys(CLI_VARIANTS).join(", ")}.`);
  }
  await materializeCliVariant(resolve(targetArgument), variantArgument as CliVariant);
  process.stdout.write(`Materialized ${variantArgument} fixture at ${resolve(targetArgument)}\n`);
}

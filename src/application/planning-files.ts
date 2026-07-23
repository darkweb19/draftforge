import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  PlanningDecision,
  PlanningPlan,
  PlanningTask,
} from "../domain/planning.js";
import type { ProjectState, TaskStatus } from "../domain/state.js";
import { writeFileAtomic } from "../state/files.js";

export interface PlannedPlanningFile {
  readonly path: string;
  readonly contents: string;
  readonly mayReplaceInitialTemplate?: boolean;
  /** What a superseded plan rendered at this path, if DraftForge wrote it. */
  readonly replaces?: string;
}

/**
 * `state`, when given, supplies reconciled task and phase statuses so a revision
 * renders the progress it kept instead of a fresh-plan guess.
 */
export function planApprovedFiles(
  plan: PlanningPlan,
  state?: ProjectState,
): readonly PlannedPlanningFile[] {
  const activePhaseId = plan.phases[0]?.id;
  const taskStatus = new Map((state?.tasks ?? []).map((task) => [task.id, task.status]));
  const phaseStatus = new Map((state?.phases ?? []).map((phase) => [phase.id, phase.status]));
  return [
    {
      path: "PHASES.md",
      contents: renderPhases(plan, phaseStatus),
      mayReplaceInitialTemplate: true,
    },
    ...plan.decisions.map((decision) => ({
      path: normalizeProjectPath(decision.adrFile),
      contents: renderDecision(decision),
    })),
    ...plan.tasks.map((task) => ({
      path: `.draftforge/tasks/${task.id}.md`,
      contents: renderTask(
        task,
        taskStatus.get(task.id) ??
          (task.phaseId === activePhaseId && task.dependsOn.length === 0 ? "ready" : "backlog"),
      ),
    })),
  ];
}

/**
 * Mark files a superseded plan generated as replaceable. Content is compared
 * ignoring status lines, because status drifts with recorded progress while the
 * rest of a generated file does not.
 */
export function planRevisionFiles(
  files: readonly PlannedPlanningFile[],
  superseded: readonly PlannedPlanningFile[],
): readonly PlannedPlanningFile[] {
  const previous = new Map(superseded.map((file) => [normalizeProjectPath(file.path), file.contents]));
  return files.map((file) => {
    const replaces = previous.get(normalizeProjectPath(file.path));
    return replaces === undefined ? file : { ...file, replaces };
  });
}

export async function assertPlanningFilesWritable(
  root: string,
  files: readonly PlannedPlanningFile[],
): Promise<void> {
  const conflicts: string[] = [];
  for (const file of files) {
    await assertNoSymlinkedOutput(root, file.path);
    const path = safeOutputPath(root, file.path);
    const existing = await readFileOrNull(path);
    if (existing !== null && existing !== file.contents && !isReplaceable(existing, file)) {
      conflicts.push(file.path);
    }
  }

  if (conflicts.length > 0) {
    throw new Error(
      `Approved plan would overwrite existing project files: ${conflicts.join(", ")}.`,
    );
  }
}

/**
 * A generated file may be rewritten when its content still matches what
 * DraftForge wrote — for this plan or the one it supersedes — ignoring status
 * lines, which drift with recorded progress. Anything else is a user edit.
 */
function isReplaceable(existing: string, file: PlannedPlanningFile): boolean {
  if (file.mayReplaceInitialTemplate === true && isInitialPhasesTemplate(existing)) {
    return true;
  }
  const generated = [file.contents, ...(file.replaces === undefined ? [] : [file.replaces])];
  return generated.some((candidate) => withoutStatusLines(existing) === withoutStatusLines(candidate));
}

function withoutStatusLines(contents: string): string {
  return contents.replaceAll(/^Status: .*$/gm, "Status:");
}

export async function writePlanningFiles(
  root: string,
  files: readonly PlannedPlanningFile[],
): Promise<void> {
  for (const file of files) {
    await assertNoSymlinkedOutput(root, file.path);
    await writeFileAtomic(safeOutputPath(root, file.path), file.contents);
  }
}

const PHASE_STATUS_LABELS = {
  not_started: "not started",
  in_progress: "in progress",
  blocked: "blocked",
  complete: "complete",
} as const;

function renderPhases(
  plan: PlanningPlan,
  phaseStatus: ReadonlyMap<string, keyof typeof PHASE_STATUS_LABELS>,
): string {
  const sections = plan.phases.map(
    (phase, index) => `## ${phase.id} — ${phase.name}

Status: ${PHASE_STATUS_LABELS[phaseStatus.get(phase.id) ?? (index === 0 ? "in_progress" : "not_started")]}

${phase.objective}

### Exit gate

${renderList(phase.exitCriteria)}`,
  );
  return `# Delivery phases

Only one phase is active at a time. Task readiness remains authoritative in
\`.draftforge/state.json\`.

${sections.join("\n\n")}
`;
}

function renderDecision(decision: PlanningDecision): string {
  return `# ${decision.id}: ${decision.title}

Status: accepted

## Context

${decision.context}

## Decision

${decision.decision}

## Consequences

${renderList(decision.consequences)}
`;
}

function renderTask(task: PlanningTask, status: TaskStatus): string {
  return `# ${task.id} — ${task.title}

Status: ${status}

## Objective

${task.objective}

## Owned paths

${renderList(task.ownedPaths)}

## Required context

${renderList(task.requiredContext)}

## Relevant ADRs

${renderList(task.relevantAdrs)}

## Dependencies

${renderList(task.dependsOn)}

## Acceptance criteria

${renderList(task.acceptanceCriteria)}

## Verification

${renderList(task.verification)}

## Exclusions

${renderList(task.exclusions)}
`;
}

function renderList(items: readonly string[]): string {
  return items.length === 0 ? "- None" : items.map((item) => `- ${item}`).join("\n");
}

function safeOutputPath(root: string, projectPath: string): string {
  const path = resolve(root, normalizeProjectPath(projectPath));
  const projectRelative = relative(resolve(root), path);
  if (
    projectRelative.length === 0 ||
    projectRelative === ".." ||
    projectRelative.startsWith(`..\\`) ||
    projectRelative.startsWith("../") ||
    isAbsolute(projectRelative)
  ) {
    throw new Error(`Planning output must stay inside the project: ${projectPath}.`);
  }
  return path;
}

function normalizeProjectPath(path: string): string {
  return path.replaceAll("\\", "/");
}

async function assertNoSymlinkedOutput(root: string, projectPath: string): Promise<void> {
  const canonicalRoot = await realpath(root);
  let current = canonicalRoot;
  for (const segment of normalizeProjectPath(projectPath).split("/")) {
    current = resolve(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Planning output cannot use a symlink or junction: ${projectPath}.`);
      }
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
  }
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

function isInitialPhasesTemplate(contents: string): boolean {
  return (
    contents.startsWith("# Delivery phases") &&
    contents.includes("have not been planned yet.") &&
    contents.includes("draftforge plan idea.md")
  );
}

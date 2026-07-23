import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  PlanningDecision,
  PlanningPlan,
  PlanningTask,
} from "../domain/planning.js";
import { writeFileAtomic } from "../state/files.js";

export interface PlannedPlanningFile {
  readonly path: string;
  readonly contents: string;
  readonly mayReplaceInitialTemplate?: boolean;
}

export function planApprovedFiles(plan: PlanningPlan): readonly PlannedPlanningFile[] {
  const activePhaseId = plan.phases[0]?.id;
  return [
    {
      path: "PHASES.md",
      contents: renderPhases(plan),
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
        task.phaseId === activePhaseId && task.dependsOn.length === 0 ? "ready" : "backlog",
      ),
    })),
  ];
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
    if (
      existing !== null &&
      existing !== file.contents &&
      !(file.mayReplaceInitialTemplate === true && isInitialPhasesTemplate(existing))
    ) {
      conflicts.push(file.path);
    }
  }

  if (conflicts.length > 0) {
    throw new Error(
      `Approved plan would overwrite existing project files: ${conflicts.join(", ")}.`,
    );
  }
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

function renderPhases(plan: PlanningPlan): string {
  const sections = plan.phases.map(
    (phase, index) => `## ${phase.id} — ${phase.name}

Status: ${index === 0 ? "in progress" : "not started"}

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

function renderTask(task: PlanningTask, status: "ready" | "backlog"): string {
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

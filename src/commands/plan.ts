import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  approvePlanningArtifact,
  createPlanningArtifact,
  type PlanningApprovalResult,
} from "../application/planning.js";
import {
  assertPlanningFilesWritable,
  planApprovedFiles,
  writePlanningFiles,
} from "../application/planning-files.js";
import type { PlanningArtifact } from "../domain/planning.js";
import { readProjectState, writeProjectState, writeSession } from "../state/files.js";
import {
  readPlanningArtifact,
  writePlanningArtifact,
} from "../state/planning.js";
import { withProjectLock } from "../state/lock.js";

export type PlanOptions =
  | { readonly mode: "start"; readonly sourceFile: string }
  | { readonly mode: "status" }
  | {
      readonly mode: "approve";
      readonly approvedBy: string;
      readonly now?: Date;
    };

export type PlanResult =
  | { readonly mode: "start"; readonly artifact: PlanningArtifact; readonly resumed: boolean }
  | { readonly mode: "status"; readonly artifact: PlanningArtifact }
  | {
      readonly mode: "approve";
      readonly artifact: PlanningArtifact;
      readonly readyTaskIds: readonly string[];
    };

export async function runPlan(root: string, options: PlanOptions): Promise<PlanResult> {
  const projectRoot = resolve(root);

  if (options.mode === "start") {
    await readProjectState(projectRoot);
    const sourceFile = projectRelativePath(projectRoot, options.sourceFile);
    await assertReadableSource(projectRoot, sourceFile);

    const existing = await readPlanningArtifactIfPresent(projectRoot);
    if (existing !== null) {
      if (existing.sourceFile !== sourceFile) {
        throw new Error(
          `Planning already uses ${existing.sourceFile}; start a recorded revision before changing the source draft.`,
        );
      }
      return { mode: "start", artifact: existing, resumed: true };
    }

    const artifact = createPlanningArtifact(sourceFile);
    await writePlanningArtifact(projectRoot, artifact);
    return { mode: "start", artifact, resumed: false };
  }

  if (options.mode === "status") {
    return { mode: "status", artifact: await readPlanningArtifact(projectRoot) };
  }

  return withProjectLock(projectRoot, "plan approval", async () => {
    const artifact = await readPlanningArtifact(projectRoot);
    const state = await readProjectState(projectRoot);
    const result = approvePlanningArtifact(artifact, state, {
      approvedBy: options.approvedBy,
      now: options.now ?? new Date(),
    });
    if (result.artifact.plan === null) {
      throw new Error("Approved planning state is missing its plan.");
    }
    const files = planApprovedFiles(result.artifact.plan);
    const alreadyMaterialized = result.projectState === state;
    if (!alreadyMaterialized) {
      await assertPlanningFilesWritable(projectRoot, files);
    }

    // Publish consent before runnable state. A retry reconciles state if the
    // process stops between these per-file atomic writes.
    await writePlanningArtifact(projectRoot, result.artifact);
    if (!alreadyMaterialized) {
      await writePlanningFiles(projectRoot, files);
    }
    await writeProjectState(projectRoot, result.projectState);
    await writeSession(projectRoot, result.projectState);

    return approvalResult(result);
  });
}

function approvalResult(result: PlanningApprovalResult): PlanResult {
  return {
    mode: "approve",
    artifact: result.artifact,
    readyTaskIds: result.projectState.tasks
      .filter((task) => task.status === "ready")
      .map((task) => task.id),
  };
}

async function readPlanningArtifactIfPresent(root: string): Promise<PlanningArtifact | null> {
  try {
    return await readPlanningArtifact(root);
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

async function assertReadableSource(root: string, sourceFile: string): Promise<void> {
  try {
    await readFile(resolve(root, sourceFile), "utf8");
  } catch (error: unknown) {
    if (isNotFound(error)) {
      throw new Error(`Planning source does not exist: ${sourceFile}.`);
    }
    throw error;
  }
}

function projectRelativePath(root: string, sourceFile: string): string {
  if (sourceFile.trim().length === 0) {
    throw new Error("Planning source must be a non-empty path.");
  }

  const absolute = resolve(root, sourceFile);
  const projectRelative = relative(root, absolute);
  if (
    projectRelative.length === 0 ||
    projectRelative === ".." ||
    projectRelative.startsWith(`..\\`) ||
    projectRelative.startsWith("../") ||
    isAbsolute(projectRelative)
  ) {
    throw new Error("Planning source must stay inside the project.");
  }
  return projectRelative.replaceAll("\\", "/");
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}

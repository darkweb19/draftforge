import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  applyArchitectResponse,
  parseArchitectResponse,
  runArchitectTurn,
} from "../application/architect.js";
import { architectStage, buildArchitectPrompt } from "../application/architect-prompt.js";
import type { ModelRequest, ModelRunner } from "../application/ports.js";
import {
  approvePlanningArtifact,
  createPlanningArtifact,
  recordQuestionAnswers,
  startPlanningRevision,
  type PlanningApprovalResult,
} from "../application/planning.js";
import {
  assertPlanningFilesWritable,
  planApprovedFiles,
  planRevisionFiles,
  writePlanningFiles,
} from "../application/planning-files.js";
import type { ArchitectResponseKind } from "../domain/architect.js";
import type { PlanningArtifact, PlanningRevisionRecord } from "../domain/planning.js";
import { loadProjectConfig } from "../config/config.js";
import { createModelRunner } from "../providers/runner.js";
import { readProjectState, writeProjectState, writeSession } from "../state/files.js";
import {
  readPlanningArtifact,
  writePlanningArtifact,
} from "../state/planning.js";
import { withProjectLock } from "../state/lock.js";

export type PlanOptions =
  | { readonly mode: "start"; readonly sourceFile: string }
  | { readonly mode: "status" }
  | { readonly mode: "prompt" }
  | { readonly mode: "run" }
  | { readonly mode: "submit"; readonly responseFile: string }
  | { readonly mode: "answer"; readonly answers: Readonly<Record<string, string>> }
  | {
      readonly mode: "approve";
      readonly approvedBy: string;
      readonly now?: Date;
    }
  | {
      readonly mode: "revise";
      readonly reason: string;
      readonly requestedBy: string;
      readonly reopenTasks?: readonly string[];
      readonly retireTasks?: readonly string[];
      readonly now?: Date;
    };

export type PlanResult =
  | { readonly mode: "start"; readonly artifact: PlanningArtifact; readonly resumed: boolean }
  | { readonly mode: "status"; readonly artifact: PlanningArtifact }
  | {
      readonly mode: "prompt";
      readonly artifact: PlanningArtifact;
      readonly request: ModelRequest;
      readonly stage: ArchitectResponseKind;
    }
  | {
      readonly mode: "submit";
      readonly artifact: PlanningArtifact;
      readonly applied: ArchitectResponseKind;
    }
  | {
      readonly mode: "run";
      readonly artifact: PlanningArtifact;
      readonly applied: ArchitectResponseKind;
    }
  | {
      readonly mode: "answer";
      readonly artifact: PlanningArtifact;
      readonly answeredIds: readonly string[];
    }
  | {
      readonly mode: "approve";
      readonly artifact: PlanningArtifact;
      readonly readyTaskIds: readonly string[];
    }
  | {
      readonly mode: "revise";
      readonly artifact: PlanningArtifact;
      readonly record: PlanningRevisionRecord;
      readonly withdrawnTaskIds: readonly string[];
    };

export interface PlanDependencies {
  readonly runner?: ModelRunner;
}

export async function runPlan(
  root: string,
  options: PlanOptions,
  dependencies: PlanDependencies = {},
): Promise<PlanResult> {
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

  if (options.mode === "prompt") {
    const artifact = await readPlanningArtifact(projectRoot);
    const state = await readProjectState(projectRoot);
    const request = buildArchitectPrompt({
      artifact,
      projectName: state.project.name,
      sourceText: await readSourceText(projectRoot, artifact.sourceFile),
    });
    return { mode: "prompt", artifact, request, stage: architectStage(artifact) };
  }

  if (options.mode === "run") {
    return withProjectLock(projectRoot, "architect turn", async () => {
      const artifact = await readPlanningArtifact(projectRoot);
      const state = await readProjectState(projectRoot);
      const applied = architectStage(artifact);
      const runner =
        dependencies.runner ??
        createModelRunner(await loadProjectConfig(projectRoot));
      const next = await runArchitectTurn(
        {
          artifact,
          projectName: state.project.name,
          sourceText: await readSourceText(projectRoot, artifact.sourceFile),
        },
        runner,
      );
      await writePlanningArtifact(projectRoot, next);
      return { mode: "run", artifact: next, applied };
    });
  }

  if (options.mode === "submit") {
    return withProjectLock(projectRoot, "architect response", async () => {
      const artifact = await readPlanningArtifact(projectRoot);
      const response = parseArchitectResponse(
        await readResponseText(projectRoot, options.responseFile),
      );
      const next = applyArchitectResponse(artifact, response);
      await writePlanningArtifact(projectRoot, next);
      return { mode: "submit", artifact: next, applied: response.kind };
    });
  }

  if (options.mode === "answer") {
    return withProjectLock(projectRoot, "planning answers", async () => {
      const artifact = await readPlanningArtifact(projectRoot);
      const next = recordQuestionAnswers(artifact, options.answers);
      await writePlanningArtifact(projectRoot, next);
      return { mode: "answer", artifact: next, answeredIds: Object.keys(options.answers) };
    });
  }

  if (options.mode === "revise") {
    return withProjectLock(projectRoot, "plan revision", async () => {
      const artifact = await readPlanningArtifact(projectRoot);
      const state = await readProjectState(projectRoot);
      const result = startPlanningRevision(artifact, state, {
        reason: options.reason,
        requestedBy: options.requestedBy,
        now: options.now ?? new Date(),
        ...(options.reopenTasks === undefined ? {} : { reopenTasks: options.reopenTasks }),
        ...(options.retireTasks === undefined ? {} : { retireTasks: options.retireTasks }),
      });

      // Withdraw readiness before the new revision can attract a worker.
      await writeProjectState(projectRoot, result.projectState);
      await writeSession(projectRoot, result.projectState);
      await writePlanningArtifact(projectRoot, result.artifact);

      return {
        mode: "revise",
        artifact: result.artifact,
        record: result.record,
        withdrawnTaskIds: result.withdrawnTaskIds,
      };
    });
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
    const files = planRevisionFiles(
      planApprovedFiles(result.artifact.plan, result.projectState),
      result.artifact.supersededPlan === null
        ? []
        : planApprovedFiles(result.artifact.supersededPlan),
    );
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
  await readSourceText(root, sourceFile);
}

async function readSourceText(root: string, sourceFile: string): Promise<string> {
  try {
    return await readFile(resolve(root, sourceFile), "utf8");
  } catch (error: unknown) {
    if (isNotFound(error)) {
      throw new Error(`Planning source does not exist: ${sourceFile}.`);
    }
    throw error;
  }
}

async function readResponseText(root: string, responseFile: string): Promise<string> {
  if (responseFile.trim().length === 0) {
    throw new Error("Architect response file must be a non-empty path.");
  }
  try {
    return await readFile(resolve(root, responseFile), "utf8");
  } catch (error: unknown) {
    if (isNotFound(error)) {
      throw new Error(`Architect response file does not exist: ${responseFile}.`);
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

import { resolve } from "node:path";
import {
  executeProject,
  executionDidWork,
  executionExitCode,
  type ExecutionMode,
  type ExecutionSummary,
} from "../application/execution.js";
import type { ModelRunner } from "../application/ports.js";
import type { WorkspacePort } from "../application/workspace.js";
import { loadProjectConfig, type ProjectConfig } from "../config/config.js";
import { createModelRunner } from "../providers/runner.js";
import { GitWorkspace } from "../workspaces/git.js";

export interface RunOptions {
  readonly mode: ExecutionMode;
  readonly actor?: string;
}

/** Injection points mirroring `runPlan`: real defaults, test-replaceable. */
export interface RunDependencies {
  readonly config?: ProjectConfig;
  readonly runner?: ModelRunner;
  readonly workspace?: WorkspacePort;
  readonly runId?: string;
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
  readonly caseSensitive?: boolean;
  readonly agentRulePaths?: readonly string[];
}

export interface RunResult {
  readonly summary: ExecutionSummary;
  readonly lines: readonly string[];
  readonly exitCode: 0 | 1;
}

export const DEFAULT_RUN_ACTOR = "draftforge-scheduler";

export async function runExecution(
  root: string,
  options: RunOptions,
  dependencies: RunDependencies = {},
): Promise<RunResult> {
  const projectRoot = resolve(root);
  const config = dependencies.config ?? (await loadProjectConfig(projectRoot));
  const summary = await executeProject({
    root: projectRoot,
    mode: options.mode,
    config,
    runner: dependencies.runner ?? createModelRunner(config, dependencies.env === undefined ? {} : { env: dependencies.env }),
    workspace: dependencies.workspace ?? new GitWorkspace({ projectRoot }),
    actor: options.actor ?? DEFAULT_RUN_ACTOR,
    ...(dependencies.runId === undefined ? {} : { runId: dependencies.runId }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    ...(dependencies.env === undefined ? {} : { env: dependencies.env }),
    ...(dependencies.caseSensitive === undefined ? {} : { caseSensitive: dependencies.caseSensitive }),
    ...(dependencies.agentRulePaths === undefined ? {} : { agentRulePaths: dependencies.agentRulePaths }),
  });

  return { summary, lines: renderExecutionSummary(summary), exitCode: executionExitCode(summary) };
}

/** Every outcome class gets its own labelled line so scripts can grep for it. */
export function renderExecutionSummary(summary: ExecutionSummary): readonly string[] {
  const lines: string[] = [
    `Mode: ${summary.mode} (run ${summary.runId}; maxConcurrency ${summary.maxConcurrency})`,
    renderRecords(summary, "Dispatched", "dispatched"),
    renderRecords(summary, "Resumed", "resumed"),
    renderRecords(summary, "Reconciled", "finalized"),
  ];

  lines.push(
    summary.deferred.length === 0
      ? "Deferred: none"
      : `Deferred: ${summary.deferred.map((record) => `${record.taskId} (${record.reason})`).join(", ")}`,
  );
  for (const record of summary.deferred) {
    lines.push(`  ${record.taskId} [${record.reason}] ${record.detail}`);
  }

  lines.push(`Review-ready: ${renderIds(summary.reviewReady)}`);
  lines.push(`Blocked: ${renderIds(summary.blocked)}`);
  if (summary.orphanAttempts.length > 0) {
    lines.push(`Orphan attempts: ${summary.orphanAttempts.join(", ")}`);
  }

  if (!executionDidWork(summary)) {
    lines.push(
      summary.deferred.length === 0
        ? "No work: nothing was dispatched, resumed, or reconciled."
        : "No work: every candidate task was deferred.",
    );
  }
  lines.push(`Next: ${nextAction(summary)}`);
  return lines;
}

function renderRecords(
  summary: ExecutionSummary,
  label: string,
  disposition: ExecutionSummary["records"][number]["disposition"],
): string {
  const records = summary.records.filter((record) => record.disposition === disposition);
  return records.length === 0
    ? `${label}: none`
    : `${label}: ${records.map((record) => `${record.taskId} -> ${record.status}`).join(", ")}`;
}

function renderIds(ids: readonly string[]): string {
  return ids.length === 0 ? "none" : ids.join(", ");
}

function nextAction(summary: ExecutionSummary): string {
  if (summary.deferred.some((record) => record.reason === "unreconciled")) {
    return "inspect the attempts listed above under `.draftforge/runs/`, then re-run.";
  }
  if (summary.deferred.some((record) => record.reason === "in-flight")) {
    return "`draftforge resume` to continue the unfinished attempts.";
  }
  if (summary.reviewReady.length > 0) {
    return "`draftforge review` to run machine checks, reviewer judgment, and accepted-work integration.";
  }
  if (summary.blocked.length > 0) {
    return "read the blocked attempts' result artifacts under `.draftforge/runs/`.";
  }
  if (summary.deferred.length > 0) {
    return "`draftforge run` again once the blocking task releases its owned paths.";
  }
  return "`draftforge status`.";
}

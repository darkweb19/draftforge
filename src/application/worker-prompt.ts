import { realpath, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { ExecutionAttemptManifest } from "../domain/execution.js";
import type { WorkspaceLocation } from "./workspace.js";
import type { ModelRequest } from "./ports.js";
import type { TaskContract } from "./task-contract.js";

export interface WorkerPromptInput {
  /** Absolute path to the attempt worktree. */
  readonly worktreeRoot: string;
  readonly contract: TaskContract;
  readonly manifest: ExecutionAttemptManifest;
  readonly workspace: WorkspaceLocation;
  /** Repository instruction files approved for worker context. */
  readonly agentRulePaths?: readonly string[];
}

/**
 * Build the deliberately narrow worker request. File reads are limited to
 * repository rules plus paths explicitly named by the task contract.
 */
export async function buildWorkerPrompt(input: WorkerPromptInput): Promise<ModelRequest> {
  assertPromptIdentity(input);
  const root = await realpath(resolve(input.worktreeRoot));
  const rulePaths = input.agentRulePaths ?? ["AGENTS.md"];
  for (const rulePath of rulePaths) {
    const normalized = rulePath.replaceAll("\\", "/");
    const name = normalized.split("/").at(-1);
    if (name !== "AGENTS.md" && name !== "CLAUDE.md") {
      throw new Error(`Worker repository agent rule path is not an agent instruction file: ${rulePath}.`);
    }
  }
  const contextPaths = unique([
    ...input.contract.requiredContext,
    ...input.contract.relevantAdrs,
  ]);
  const [rules, contexts] = await Promise.all([
    readApprovedFiles(root, rulePaths, "repository agent rule"),
    readApprovedFiles(root, contextPaths, "task context"),
  ]);

  return {
    role: "worker",
    system: workerSystemPrompt(),
    user: [
      "# Workspace identity",
      "",
      `- Task ID: ${input.contract.id}`,
      `- Run ID: ${input.manifest.runId}`,
      `- Attempt ID: ${input.manifest.attemptId}`,
      `- Workspace ID: ${input.manifest.workspace.id}`,
      `- Working directory: ${input.workspace.path}`,
      `- Base commit: ${input.workspace.baseCommit}`,
      "",
      "# Budget",
      "",
      renderBudget(input.manifest),
      "",
      "# Assigned task contract",
      "",
      renderTaskContract(input.contract),
      "",
      "# Repository agent rules",
      "",
      renderFiles(rules),
      "",
      "# Required context and relevant ADRs",
      "",
      contexts.length === 0 ? "None." : renderFiles(contexts),
      "",
      "# Verification commands",
      "",
      input.contract.verification.map((command) => `- ${command}`).join("\n"),
      "",
      "# Required result envelope",
      "",
      "Return exactly one JSON object and no raw prose or Markdown fence:",
      '{',
      `  "taskId": "${input.contract.id}",`,
      `  "attemptId": "${input.manifest.attemptId}",`,
      '  "status": "completed" | "blocked",',
      '  "summary": "non-empty summary",',
      '  "changedPaths": ["repository/relative/path"],',
      '  "commandsRun": [{ "command": "npm test", "exitCode": 0, "summary": "what the command proved" }],',
      '  "evidence": ["concise evidence"],',
      '  "risks": ["remaining risk"],',
      '  "suggestedFollowUps": ["suggestion only; never expand this task"]',
      "}",
      "",
    ].join("\n"),
    workingDirectory: input.workspace.path,
    retryPolicy: "none",
    timeoutMs: workerTimeoutMs(input.manifest),
  };
}

interface ApprovedFile {
  readonly path: string;
  readonly contents: string;
}

async function readApprovedFiles(
  root: string,
  paths: readonly string[],
  kind: string,
): Promise<readonly ApprovedFile[]> {
  return Promise.all(paths.map(async (projectPath) => {
    const normalized = normalizeContextPath(projectPath, kind);
    const lexical = resolve(root, normalized);
    assertInside(root, lexical, projectPath, kind);
    let canonical: string;
    try {
      canonical = await realpath(lexical);
    } catch (error: unknown) {
      throw new Error(`Unable to read ${kind} ${projectPath}.`, { cause: error });
    }
    assertInside(root, canonical, projectPath, kind);
    let contents: string;
    try {
      contents = await readFile(canonical, "utf8");
    } catch (error: unknown) {
      throw new Error(`Unable to read ${kind} ${projectPath}.`, { cause: error });
    }
    return { path: normalized, contents: contents.trimEnd() };
  }));
}

function normalizeContextPath(value: string, kind: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/u, "");
  const segments = normalized.split("/");
  if (
    value.trim().length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.includes("\0") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(`Worker ${kind} must be a project-relative path: ${value}.`);
  }
  return normalized;
}

function assertInside(root: string, candidate: string, projectPath: string, kind: string): void {
  const fromRoot = relative(root, candidate);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith("../") || fromRoot.startsWith("..\\")) {
    throw new Error(`Worker ${kind} escapes the worktree: ${projectPath}.`);
  }
}

function assertPromptIdentity(input: WorkerPromptInput): void {
  if (
    input.contract.id !== input.manifest.taskId ||
    input.workspace.attempt.taskId !== input.contract.id ||
    input.workspace.attempt.runId !== input.manifest.runId ||
    input.workspace.attempt.attemptId !== input.manifest.attemptId
  ) {
    throw new Error("Worker prompt task, attempt, manifest, and workspace identities must match.");
  }
  if (input.workspace.path !== input.worktreeRoot) {
    throw new Error("Worker prompt worktree root must match the workspace path.");
  }
}

function renderTaskContract(contract: TaskContract): string {
  return [
    `## ${contract.id} — ${contract.title}`,
    "",
    "### Objective",
    contract.objective,
    "",
    "### Owned paths",
    renderList(contract.ownedPaths),
    "",
    "### Required context",
    renderList(contract.requiredContext),
    "",
    "### Relevant ADRs",
    renderList(contract.relevantAdrs),
    "",
    "### Dependencies",
    renderList(contract.dependsOn),
    "",
    "### Acceptance criteria",
    renderList(contract.acceptanceCriteria),
    "",
    "### Verification",
    renderList(contract.verification),
    "",
    "### Exclusions",
    renderList(contract.exclusions),
  ].join("\n");
}

function renderBudget(manifest: ExecutionAttemptManifest): string {
  const budget = manifest.budget;
  if (budget === null) {
    return "- None declared.";
  }
  return [
    `- Time limit (enforced): ${String(budget.timeMinutes ?? "not declared")} minutes`,
    `- Token limit (evidence only): ${String(budget.tokenLimit ?? "not declared")}`,
    `- Cost limit USD (evidence only): ${String(budget.costLimitUsd ?? "not declared")}`,
  ].join("\n");
}

function workerTimeoutMs(manifest: ExecutionAttemptManifest): number {
  const minutes = manifest.budget?.timeMinutes;
  if (minutes === undefined) {
    throw new Error("Worker attempt manifest is missing its effective time budget.");
  }
  const milliseconds = minutes * 60_000;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) {
    throw new Error("Worker attempt time budget cannot be represented safely in milliseconds.");
  }
  return milliseconds;
}

function renderFiles(files: readonly ApprovedFile[]): string {
  return files.map((file) => [
    `## ${file.path}`,
    "",
    file.contents,
  ].join("\n")).join("\n\n");
}

function renderList(values: readonly string[]): string {
  return values.length === 0 ? "- None" : values.map((value) => `- ${value}`).join("\n");
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function workerSystemPrompt(): string {
  return [
    "You are DraftForge's bounded worker.",
    "Modify only the assigned owned paths in the provided isolated worktree.",
    "Follow the supplied repository rules and approved architecture context.",
    "Do not expand scope, edit DraftForge control files, or accept your own task.",
    "Run the assigned verification and report a strict result envelope.",
  ].join("\n");
}

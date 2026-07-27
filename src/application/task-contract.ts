import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { assertTaskBudget, type TaskBudget } from "../domain/execution.js";
import type { TaskState } from "../domain/state.js";

export interface TaskContract {
  readonly id: string;
  readonly title: string;
  readonly objective: string;
  readonly ownedPaths: readonly string[];
  readonly requiredContext: readonly string[];
  readonly relevantAdrs: readonly string[];
  readonly dependsOn: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly verification: readonly string[];
  readonly exclusions: readonly string[];
  readonly budget?: TaskBudget;
}

const REQUIRED_SECTIONS = [
  "Objective",
  "Owned paths",
  "Required context",
  "Relevant ADRs",
  "Dependencies",
  "Acceptance criteria",
  "Verification",
  "Exclusions",
] as const;
const GLOB = /\*|\?|\[|\]|\{|\}|!/;

/** Parse the generated Markdown contract before it can be scheduled. */
export function parseTaskContract(contents: string, expected?: TaskState): TaskContract {
  const normalized = contents.replaceAll("\r\n", "\n");
  const heading = /^# (P[0-9]{2}-T[0-9]{2}) — (.+)$/m.exec(normalized);
  if (heading === null || heading[1] === undefined || heading[2] === undefined) {
    throw new Error("Task contract must start with a stable task ID and title.");
  }
  const sections = parseSections(normalized);
  for (const name of REQUIRED_SECTIONS) {
    if (!sections.has(name)) {
      throw new Error(`Task contract ${heading[1]} is missing required section: ${name}.`);
    }
  }
  for (const name of sections.keys()) {
    if (![...REQUIRED_SECTIONS, "Budget"].includes(name as (typeof REQUIRED_SECTIONS)[number] | "Budget")) {
      throw new Error(`Task contract ${heading[1]} contains unsupported section: ${name}.`);
    }
  }

  const contract: TaskContract = {
    id: heading[1],
    title: heading[2].trim(),
    objective: textSection(sections, "Objective", heading[1]),
    ownedPaths: pathList(sections, "Owned paths", heading[1], true),
    requiredContext: pathList(sections, "Required context", heading[1], false),
    relevantAdrs: pathList(sections, "Relevant ADRs", heading[1], false),
    dependsOn: idList(sections, "Dependencies", heading[1]),
    acceptanceCriteria: list(sections, "Acceptance criteria", heading[1], true),
    verification: list(sections, "Verification", heading[1], true),
    exclusions: list(sections, "Exclusions", heading[1], false),
    ...(sections.has("Budget") ? { budget: budgetSection(sections, heading[1]) } : {}),
  };
  assertNoReservedOwnership(contract.ownedPaths);
  if (expected !== undefined) {
    assertTaskContractMatchesState(contract, expected);
  }
  return contract;
}

/** Read only the contract named by canonical task state, never a caller path. */
export async function readTaskContract(root: string, task: TaskState): Promise<TaskContract> {
  const resolvedRoot = resolve(root);
  const projectPath = task.taskFile.replaceAll("\\", "/");
  const segments = projectPath.split("/");
  if (
    /^[A-Za-z]:/.test(projectPath) ||
    projectPath.startsWith("/") ||
    task.taskFile.startsWith("\\\\") ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`Task ${task.id} references a task file outside the project.`);
  }
  const path = resolve(resolvedRoot, projectPath);
  const pathFromRoot = relative(resolvedRoot, path);
  if (pathFromRoot === "" || pathFromRoot === ".." || pathFromRoot.startsWith("../")) {
    throw new Error(`Task ${task.id} references a task file outside the project.`);
  }
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT")) {
      throw new Error(`Task ${task.id} contract is missing at ${task.taskFile}.`, { cause: error });
    }
    throw error;
  }
  return parseTaskContract(contents, task);
}

export function assertTaskContractMatchesState(contract: TaskContract, task: TaskState): void {
  if (contract.id !== task.id) {
    throw new Error(`Task contract ID ${contract.id} does not match canonical task ${task.id}.`);
  }
  if (contract.title !== task.title) {
    throw new Error(`Task contract title for ${task.id} does not match canonical state.`);
  }
  if (!sameStringSet(contract.dependsOn, task.dependsOn)) {
    throw new Error(`Task contract dependencies for ${task.id} do not match canonical state.`);
  }
}

/** Segment-aware normalized repository paths for scheduler conflict checks. */
export function normalizeOwnedPath(value: string, caseSensitive = process.platform !== "win32"): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "");
  const segments = normalized.split("/");
  if (
    value.trim().length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.includes("\0") ||
    GLOB.test(normalized) ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(`Owned path must be a project-relative non-glob path: ${value}.`);
  }
  return caseSensitive ? normalized : normalized.toLowerCase();
}

export function ownedPathsConflict(
  first: readonly string[],
  second: readonly string[],
  caseSensitive = process.platform !== "win32",
): boolean {
  return first.some((left) =>
    second.some((right) => {
      const a = normalizeOwnedPath(left, caseSensitive);
      const b = normalizeOwnedPath(right, caseSensitive);
      return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
    }),
  );
}

function parseSections(contents: string): ReadonlyMap<string, string> {
  const sections = new Map<string, string>();
  const lines = contents.split("\n");
  let name: string | null = null;
  let body: string[] = [];
  const finishSection = (): void => {
    if (name === null) {
      return;
    }
    if (sections.has(name)) {
      throw new Error(`Task contract contains duplicate section: ${name}.`);
    }
    sections.set(name, body.join("\n").trim());
  };
  for (const line of lines) {
    const heading = /^## (.+)$/.exec(line);
    if (heading !== null && heading[1] !== undefined) {
      finishSection();
      name = heading[1].trim();
      body = [];
    } else if (name !== null) {
      body.push(line);
    }
  }
  finishSection();
  return sections;
}

function textSection(sections: ReadonlyMap<string, string>, name: string, taskId: string): string {
  const value = sections.get(name)?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`Task contract ${taskId} requires a non-empty ${name} section.`);
  }
  return value;
}

function list(
  sections: ReadonlyMap<string, string>,
  name: string,
  taskId: string,
  required: boolean,
): readonly string[] {
  const body = sections.get(name);
  if (body === undefined) {
    throw new Error(`Task contract ${taskId} is missing required section: ${name}.`);
  }
  if (body === "- None") {
    if (required) {
      throw new Error(`Task contract ${taskId} requires at least one ${name} entry.`);
    }
    return [];
  }
  const values = body.split("\n").map((line) => {
    const match = /^- (.+)$/.exec(line.trim());
    if (match === null || match[1] === undefined || match[1].trim().length === 0) {
      throw new Error(`Task contract ${taskId} ${name} must be a Markdown list.`);
    }
    return match[1].trim();
  });
  if ((required && values.length === 0) || new Set(values).size !== values.length) {
    throw new Error(`Task contract ${taskId} ${name} must contain unique entries.`);
  }
  return values;
}

function pathList(
  sections: ReadonlyMap<string, string>,
  name: string,
  taskId: string,
  required: boolean,
): readonly string[] {
  const values = list(sections, name, taskId, required);
  return values.map((value) => normalizeOwnedPath(value));
}

function idList(sections: ReadonlyMap<string, string>, name: string, taskId: string): readonly string[] {
  const values = list(sections, name, taskId, false);
  for (const value of values) {
    if (!/^P[0-9]{2}-T[0-9]{2}$/.test(value)) {
      throw new Error(`Task contract ${taskId} ${name} entries must be task IDs.`);
    }
  }
  return values;
}

function budgetSection(sections: ReadonlyMap<string, string>, taskId: string): TaskBudget {
  const body = sections.get("Budget");
  if (body === undefined) {
    throw new Error(`Task contract ${taskId} is missing Budget.`);
  }
  const budget: Record<string, unknown> = {};
  for (const line of body.split("\n")) {
    const match = /^- (timeMinutes|tokenLimit|costLimitUsd): (.+)$/.exec(line.trim());
    if (match === null || match[1] === undefined || match[2] === undefined) {
      throw new Error(`Task contract ${taskId} Budget must contain named numeric entries.`);
    }
    if (budget[match[1]] !== undefined) {
      throw new Error(`Task contract ${taskId} Budget contains duplicate ${match[1]}.`);
    }
    const number = Number(match[2]);
    if (!Number.isFinite(number)) {
      throw new Error(`Task contract ${taskId} Budget ${match[1]} must be numeric.`);
    }
    budget[match[1]] = number;
  }
  assertTaskBudget(budget);
  return budget;
}

export function isReservedWorkerPath(
  path: string,
  caseSensitive = process.platform !== "win32",
): boolean {
  const normalized = normalizeOwnedPath(path, caseSensitive);
  return (
    normalized === (caseSensitive ? "SESSION.md" : "session.md") ||
    normalized === ".draftforge/state.json" ||
    normalized === ".draftforge/config.local.json" ||
    normalized === ".draftforge" ||
    normalized === ".draftforge/runs" ||
    normalized.startsWith(".draftforge/runs/")
  );
}

function assertNoReservedOwnership(paths: readonly string[]): void {
  for (const path of paths) {
    if (isReservedWorkerPath(path)) {
      throw new Error(`Worker-owned path is reserved to the scheduler: ${path}.`);
    }
  }
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

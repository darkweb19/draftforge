import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type AdapterId = "codex-cli" | "claude-cli" | "openai-api" | "anthropic-api";
export type ReasoningLevel = "low" | "medium" | "high" | "xhigh";

export const CONFIG_PATH = ".draftforge/config.json";
export const LOCAL_CONFIG_PATH = ".draftforge/config.local.json";

const ADAPTER_IDS: readonly AdapterId[] = ["codex-cli", "claude-cli", "openai-api", "anthropic-api"];
const REASONING_LEVELS: readonly ReasoningLevel[] = ["low", "medium", "high", "xhigh"];

export interface RoleConfig {
  readonly adapter: AdapterId;
  readonly model: string;
  readonly reasoning: ReasoningLevel;
}

export interface WorkerRoleConfig extends RoleConfig {
  readonly maxConcurrency: number;
}

export interface ProjectConfig {
  readonly $schema?: string;
  readonly roles: {
    readonly architect: RoleConfig;
    readonly worker: WorkerRoleConfig;
    readonly reviewer: RoleConfig;
  };
  readonly limits: {
    readonly maxRepairAttempts: number;
    readonly taskTimeoutMinutes: number;
  };
}

/**
 * Provider-neutral defaults. `provider-default` lets an authenticated harness
 * choose its own current model, so `init` never has to guess a model ID.
 */
export function defaultProjectConfig(): ProjectConfig {
  return {
    $schema: "./schema/config.schema.json",
    roles: {
      architect: { adapter: "codex-cli", model: "provider-default", reasoning: "high" },
      worker: { adapter: "claude-cli", model: "provider-default", reasoning: "medium", maxConcurrency: 2 },
      reviewer: { adapter: "codex-cli", model: "provider-default", reasoning: "high" },
    },
    limits: {
      maxRepairAttempts: 2,
      taskTimeoutMinutes: 30,
    },
  };
}

export function assertProjectConfig(value: unknown): asserts value is ProjectConfig {
  if (!isRecord(value)) {
    throw new Error("Configuration must be a JSON object.");
  }

  assertOnlyKeys(value, "Configuration", ["$schema", "roles", "limits"]);
  if (value.$schema !== undefined && typeof value.$schema !== "string") {
    throw new Error("Configuration $schema must be a string.");
  }

  if (!isRecord(value.roles)) {
    throw new Error("Configuration requires a roles object.");
  }

  assertOnlyKeys(value.roles, "roles", ["architect", "worker", "reviewer"]);

  assertRole(value.roles.architect, "roles.architect");
  assertRole(value.roles.reviewer, "roles.reviewer");
  assertWorkerRole(value.roles.worker, "roles.worker");

  if (!isRecord(value.limits)) {
    throw new Error("Configuration requires a limits object.");
  }

  assertOnlyKeys(value.limits, "limits", ["maxRepairAttempts", "taskTimeoutMinutes"]);

  assertIntegerInRange(value.limits.maxRepairAttempts, "limits.maxRepairAttempts", 0, 10);
  assertIntegerInRange(value.limits.taskTimeoutMinutes, "limits.taskTimeoutMinutes", 1, Number.MAX_SAFE_INTEGER);
}

export async function loadProjectConfig(root: string): Promise<ProjectConfig> {
  const base = await readJsonFile(resolve(root, CONFIG_PATH), CONFIG_PATH, false);
  const local = await readJsonFile(resolve(root, LOCAL_CONFIG_PATH), LOCAL_CONFIG_PATH, true);
  const merged = local === undefined ? base : mergeConfig(base, local);

  try {
    assertProjectConfig(merged);
  } catch (error: unknown) {
    const source = local === undefined ? `in ${CONFIG_PATH}` : `after applying ${LOCAL_CONFIG_PATH}`;
    throw new Error(`Invalid DraftForge configuration ${source}: ${errorMessage(error)}`);
  }
  return merged;
}

function assertRole(value: unknown, path: string): void {
  if (!isRecord(value)) {
    throw new Error(`Configuration requires ${path}.`);
  }

  assertOnlyKeys(value, path, ["adapter", "model", "reasoning"]);

  if (!isAdapterId(value.adapter)) {
    throw new Error(`${path}.adapter must be one of: ${ADAPTER_IDS.join(", ")}.`);
  }

  if (typeof value.model !== "string" || value.model.trim().length === 0) {
    throw new Error(`${path}.model must be a non-empty string.`);
  }

  if (!isReasoningLevel(value.reasoning)) {
    throw new Error(`${path}.reasoning must be one of: ${REASONING_LEVELS.join(", ")}.`);
  }
}

function assertWorkerRole(value: unknown, path: string): void {
  if (!isRecord(value)) {
    throw new Error(`Configuration requires ${path}.`);
  }
  assertOnlyKeys(value, path, ["adapter", "model", "reasoning", "maxConcurrency"]);
  assertRoleFields(value, path);
  assertIntegerInRange(value.maxConcurrency, `${path}.maxConcurrency`, 1, 16);
}

function assertRoleFields(value: Record<string, unknown>, path: string): void {
  if (!isAdapterId(value.adapter)) {
    throw new Error(`${path}.adapter must be one of: ${ADAPTER_IDS.join(", ")}.`);
  }
  if (typeof value.model !== "string" || value.model.trim().length === 0) {
    throw new Error(`${path}.model must be a non-empty string.`);
  }
  if (!isReasoningLevel(value.reasoning)) {
    throw new Error(`${path}.reasoning must be one of: ${REASONING_LEVELS.join(", ")}.`);
  }
}

function assertIntegerInRange(value: unknown, path: string, min: number, max: number): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${path} must be an integer between ${min} and ${max}.`);
  }
}

function isAdapterId(value: unknown): value is AdapterId {
  return typeof value === "string" && (ADAPTER_IDS as readonly string[]).includes(value);
}

function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return typeof value === "string" && (REASONING_LEVELS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) {
    throw new Error(`${path} contains unsupported property: ${unexpected}.`);
  }
}

async function readJsonFile(
  path: string,
  displayPath: string,
  optional: boolean,
): Promise<unknown | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (optional && isNotFound(error)) {
      return undefined;
    }
    if (isNotFound(error)) {
      throw new Error(`Missing DraftForge configuration: ${displayPath}.`);
    }
    throw new Error(`Unable to read ${displayPath}: ${errorMessage(error)}`);
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    throw new Error(`Invalid JSON in ${displayPath}: ${errorMessage(error)}`);
  }
}

function mergeConfig(base: unknown, override: unknown): unknown {
  if (!isRecord(base) || !isRecord(override)) {
    return override;
  }

  const merged = Object.assign(Object.create(null) as Record<string, unknown>, base);
  for (const [key, value] of Object.entries(override)) {
    const existing = merged[key];
    merged[key] = isRecord(existing) && isRecord(value) ? mergeConfig(existing, value) : value;
  }
  return merged;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

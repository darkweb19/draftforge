export type AdapterId = "codex-cli" | "claude-cli" | "openai-api" | "anthropic-api";
export type ReasoningLevel = "low" | "medium" | "high" | "xhigh";

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

  if (!isRecord(value.roles)) {
    throw new Error("Configuration requires a roles object.");
  }

  assertRole(value.roles.architect, "roles.architect");
  assertRole(value.roles.reviewer, "roles.reviewer");
  assertWorkerRole(value.roles.worker, "roles.worker");

  if (!isRecord(value.limits)) {
    throw new Error("Configuration requires a limits object.");
  }

  assertIntegerInRange(value.limits.maxRepairAttempts, "limits.maxRepairAttempts", 0, 10);
  assertIntegerInRange(value.limits.taskTimeoutMinutes, "limits.taskTimeoutMinutes", 1, Number.MAX_SAFE_INTEGER);
}

function assertRole(value: unknown, path: string): void {
  if (!isRecord(value)) {
    throw new Error(`Configuration requires ${path}.`);
  }

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
  assertRole(value, path);
  assertIntegerInRange((value as Record<string, unknown>).maxConcurrency, `${path}.maxConcurrency`, 1, 16);
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

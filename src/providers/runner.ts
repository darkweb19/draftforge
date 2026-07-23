import type { AdapterId, ProjectConfig } from "../config/config.js";
import type { ModelRequest, ModelResponse, ModelRole, ModelRunner } from "../application/ports.js";
import type { ModelAdapter } from "./adapter.js";
import { resolveAdapter } from "./registry.js";
import { createRedactor, secretsFromEnv, withReliability } from "./reliability.js";

export interface RunnerReliabilityOptions {
  readonly attempts?: number;
  readonly delayMs?: number;
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface RunnerOptions {
  readonly resolveAdapter?: (id: AdapterId) => ModelAdapter;
  readonly env?: NodeJS.ProcessEnv;
  readonly reliability?: RunnerReliabilityOptions;
}

const MILLISECONDS_PER_MINUTE = 60_000;

/**
 * Build a role-routed `ModelRunner` from configuration. Each role resolves to
 * its configured adapter, model, and reasoning level, and every call is wrapped
 * in shared reliability (timeout, bounded retry, secret redaction).
 */
export function createModelRunner(config: ProjectConfig, options: RunnerOptions = {}): ModelRunner {
  const resolve = options.resolveAdapter ?? resolveAdapter;
  const redactor = createRedactor(secretsFromEnv(options.env));
  const reliability = options.reliability ?? {};
  const timeoutMs = reliability.timeoutMs ?? config.limits.taskTimeoutMinutes * MILLISECONDS_PER_MINUTE;

  return {
    async run(request: ModelRequest): Promise<ModelResponse> {
      const route = config.roles[request.role];
      const adapter = resolve(route.adapter);
      return withReliability(
        (signal) =>
          adapter.run({
            role: request.role,
            model: route.model,
            reasoning: route.reasoning,
            system: request.system,
            user: request.user,
            signal,
          }),
        {
          timeoutMs,
          redactor,
          ...(reliability.attempts === undefined ? {} : { attempts: reliability.attempts }),
          ...(reliability.delayMs === undefined ? {} : { delayMs: reliability.delayMs }),
          ...(reliability.sleep === undefined ? {} : { sleep: reliability.sleep }),
        },
      );
    },
  };
}

/** Exposed for callers that want to reason about a single role's route. */
export function roleRoute(config: ProjectConfig, role: ModelRole): AdapterId {
  return config.roles[role].adapter;
}

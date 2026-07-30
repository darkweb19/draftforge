import { randomUUID } from "node:crypto";
import type { AdapterId } from "../config/config.js";
import type { AttemptUsage, TaskBudget } from "../domain/execution.js";
import { costForUsage } from "../providers/pricing.js";
import type { ModelRequest, ModelResponse, ModelRole, ModelRunner, ReportedUsage } from "./ports.js";

/** One provider call's accounting record. `null` fields mean "unknown," never zero. */
export interface UsageCallRecord {
  /** Stable per-call identity; the de-duplication key in the durable ledger. */
  readonly callId: string;
  readonly role: ModelRole;
  readonly adapter: AdapterId;
  readonly model: string;
  readonly taskId: string | null;
  readonly runId: string;
  readonly attemptId: string | null;
  /** `null` when the provider reported nothing. */
  readonly usage: ReportedUsage | null;
  /** `null` when cost cannot be honestly derived (unpriced model or unknown usage). */
  readonly costUsd: number | null;
  readonly recordedAt: string;
}

/**
 * Sum call records into an `AttemptUsage`. Unknown never becomes a number: if
 * any contributing record has an unknown token count (or unknown cost), the
 * corresponding total is `null` rather than a partial, understated sum. An
 * empty record set sums to all-zero — there is no missing information to
 * propagate when nothing happened.
 */
export function aggregateUsage(records: readonly UsageCallRecord[]): AttemptUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let costUsd = 0;
  let inputKnown = true;
  let outputKnown = true;
  let totalKnown = true;
  let costKnown = true;

  for (const record of records) {
    const usage = record.usage;
    if (usage === null || usage.inputTokens === null) {
      inputKnown = false;
    } else {
      inputTokens += usage.inputTokens;
    }
    if (usage === null || usage.outputTokens === null) {
      outputKnown = false;
    } else {
      outputTokens += usage.outputTokens;
    }
    if (usage === null || usage.totalTokens === null) {
      totalKnown = false;
    } else {
      totalTokens += usage.totalTokens;
    }
    if (record.costUsd === null) {
      costKnown = false;
    } else {
      costUsd += record.costUsd;
    }
  }

  return {
    inputTokens: inputKnown ? inputTokens : null,
    outputTokens: outputKnown ? outputTokens : null,
    totalTokens: totalKnown ? totalTokens : null,
    costUsd: costKnown ? costUsd : null,
    calls: records.length,
  };
}

/** Thrown by `assertWithinBudget` so callers can classify it (e.g. as `harness-failure`). */
export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

/**
 * Check declared `tokenLimit` and `costLimitUsd` against accumulated usage
 * before a call is issued. Refuses (throws) rather than truncating work.
 *
 * Why an unknown accumulated total can never exceed a budget: DraftForge only
 * ever knows what a provider reported. A `null` total means some contributing
 * call's usage is unknown — there is no honest number to compare against the
 * limit, so the check is skipped rather than guessed. This is deliberate: it
 * favors "budget enforcement is best-effort under harness adapters" over
 * fabricating a number that was never reported.
 */
export function assertWithinBudget(
  accumulated: AttemptUsage,
  budget: TaskBudget | null,
  taskId: string | null,
): void {
  if (budget === null) {
    return;
  }
  const task = taskId ?? "(unknown task)";
  if (
    budget.tokenLimit !== undefined &&
    accumulated.totalTokens !== null &&
    accumulated.totalTokens > budget.tokenLimit
  ) {
    throw new BudgetExceededError(
      `Task ${task} exceeded its token budget: accumulated ${accumulated.totalTokens} tokens ` +
        `exceeds the declared limit of ${budget.tokenLimit}.`,
    );
  }
  if (
    budget.costLimitUsd !== undefined &&
    accumulated.costUsd !== null &&
    accumulated.costUsd > budget.costLimitUsd
  ) {
    throw new BudgetExceededError(
      `Task ${task} exceeded its cost budget: accumulated $${accumulated.costUsd.toFixed(4)} ` +
        `exceeds the declared limit of $${budget.costLimitUsd.toFixed(4)}.`,
    );
  }
}

export interface UsageAccountedRunnerOptions {
  readonly runId: string;
  readonly taskId: string | null;
  readonly attemptId: string | null;
  readonly budget: TaskBudget | null;
  /**
   * Resolves the adapter and resolved model for a role, matching how the
   * wrapped runner routes it (`createModelRunner` config). Kept as an
   * injected function rather than re-reading config here so this module
   * never depends on the config schema.
   */
  readonly resolveRoute: (role: ModelRole) => { readonly adapter: AdapterId; readonly model: string };
  /**
   * Persists one call record to the durable ledger. This is the seam P05-T05
   * wires to `appendUsageCall` in `src/state/usage.ts`; kept as a callback so
   * this module has no filesystem dependency and stays trivially testable.
   */
  readonly record: (record: UsageCallRecord) => Promise<void> | void;
  readonly now?: () => Date;
  readonly generateCallId?: () => string;
}

/**
 * Decorate a `ModelRunner` with budget enforcement and usage accounting.
 * Checks the accumulated budget before every call, then — only on success —
 * derives cost and records the call. A failed call is never recorded, and
 * this wrapper changes neither the wrapped runner's error behavior nor its
 * retry semantics; it only observes the call around the edges.
 */
export function createUsageAccountedRunner(runner: ModelRunner, options: UsageAccountedRunnerOptions): ModelRunner {
  const now = options.now ?? (() => new Date());
  const generateCallId = options.generateCallId ?? (() => randomUUID());
  const records: UsageCallRecord[] = [];

  return {
    // `capabilities` is optional and the project builds with
    // exactOptionalPropertyTypes, so it must be omitted rather than set to
    // undefined when the wrapped runner does not declare it.
    ...(runner.capabilities === undefined ? {} : { capabilities: runner.capabilities }),
    async run(request: ModelRequest): Promise<ModelResponse> {
      assertWithinBudget(aggregateUsage(records), options.budget, options.taskId);

      const response = await runner.run(request);

      const route = options.resolveRoute(request.role);
      const usage = response.usage ?? null;
      const record: UsageCallRecord = {
        callId: generateCallId(),
        role: request.role,
        adapter: route.adapter,
        model: route.model,
        taskId: options.taskId,
        runId: options.runId,
        attemptId: options.attemptId,
        usage,
        costUsd: costForUsage(route.model, response.usage),
        recordedAt: now().toISOString(),
      };
      records.push(record);
      await options.record(record);

      return response;
    },
  };
}

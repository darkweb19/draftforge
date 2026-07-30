import type { ReportedUsage } from "../application/ports.js";

/**
 * The single provider-layer price table, USD per million tokens, input and
 * output priced separately. These are published list prices captured at the
 * time this table was written — they drift, are never authoritative billing,
 * and `costForUsage` output must be treated as an estimate only.
 *
 * Coverage: the `DEFAULT_MODEL` this repo's adapters resolve `provider-default`
 * to (`gpt-5` in `src/providers/api/openai-api.ts`, `claude-sonnet-5` in
 * `src/providers/api/anthropic-api.ts`), plus the current Claude family.
 */
interface ModelPrice {
  readonly inputPerMillionUsd: number;
  readonly outputPerMillionUsd: number;
}

const PRICES: Readonly<Record<string, ModelPrice>> = {
  // OpenAI — repo default.
  "gpt-5": { inputPerMillionUsd: 1.25, outputPerMillionUsd: 10.0 },

  // Anthropic — repo default plus the current Claude family.
  "claude-sonnet-5": { inputPerMillionUsd: 3.0, outputPerMillionUsd: 15.0 },
  "claude-sonnet-4-6": { inputPerMillionUsd: 3.0, outputPerMillionUsd: 15.0 },
  "claude-opus-4-8": { inputPerMillionUsd: 5.0, outputPerMillionUsd: 25.0 },
  "claude-opus-4-7": { inputPerMillionUsd: 5.0, outputPerMillionUsd: 25.0 },
  "claude-opus-4-6": { inputPerMillionUsd: 5.0, outputPerMillionUsd: 25.0 },
  "claude-haiku-4-5": { inputPerMillionUsd: 1.0, outputPerMillionUsd: 5.0 },
};

const MILLION_TOKENS = 1_000_000;

/**
 * Exact match first; otherwise the longest table key that is a documented
 * dash-delimited prefix of `model` (e.g. a dated snapshot such as
 * `claude-sonnet-5-20260101` matches the `claude-sonnet-5` entry). Requiring
 * the trailing dash keeps a near-miss model (`claude-sonnet-50`) from
 * borrowing an unrelated entry's price.
 */
function resolvePrice(model: string): ModelPrice | null {
  const exact = PRICES[model];
  if (exact !== undefined) {
    return exact;
  }
  let best: { readonly key: string; readonly price: ModelPrice } | null = null;
  for (const [key, price] of Object.entries(PRICES)) {
    if (model.startsWith(`${key}-`) && (best === null || key.length > best.key.length)) {
      best = { key, price };
    }
  }
  return best === null ? null : best.price;
}

/**
 * Derive cost from reported usage against the single price table. Returns
 * `null` — never `0` — whenever cost cannot be honestly known: an unpriced
 * model, absent usage, or a missing token count the rate needs.
 */
export function costForUsage(model: string, usage: ReportedUsage | undefined): number | null {
  if (usage === undefined) {
    return null;
  }
  const price = resolvePrice(model);
  if (price === null) {
    return null;
  }
  if (usage.inputTokens === null || usage.outputTokens === null) {
    return null;
  }
  const inputCost = (usage.inputTokens / MILLION_TOKENS) * price.inputPerMillionUsd;
  const outputCost = (usage.outputTokens / MILLION_TOKENS) * price.outputPerMillionUsd;
  return inputCost + outputCost;
}

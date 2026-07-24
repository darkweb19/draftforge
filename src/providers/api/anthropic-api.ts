import type { ReasoningLevel } from "../../config/config.js";
import type { ModelAdapter } from "../adapter.js";
import { createRedactor } from "../reliability.js";
import { ApiAdapterError, defaultFetch, sendApiRequest } from "./http.js";
import type { FetchLike } from "./http.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const KEY_ENV = "ANTHROPIC_API_KEY";
const MAX_TOKENS = 8192;

/**
 * Anthropic's current default model. It lives in the provider layer — not config
 * or domain — so `provider-default` resolves here and a moving default is a
 * one-line change instead of a schema migration.
 */
const DEFAULT_MODEL = "claude-sonnet-5";

export interface AnthropicApiAdapterOptions {
  readonly fetch?: FetchLike;
  readonly env?: NodeJS.ProcessEnv;
  readonly redactor?: (text: string) => string;
}

export function createAnthropicApiAdapter(options: AnthropicApiAdapterOptions = {}): ModelAdapter {
  const fetchImpl = options.fetch ?? defaultFetch;
  const env = options.env ?? process.env;

  return {
    capabilities: {
      id: "anthropic-api",
      transport: "api",
      authMode: "api-key",
      roles: ["architect", "worker", "reviewer"],
    },
    async run(request) {
      const key = requireKey(env);
      const redactor = options.redactor ?? createRedactor([key]);
      const model = request.model === "provider-default" ? DEFAULT_MODEL : request.model;
      const body = {
        model,
        max_tokens: MAX_TOKENS,
        system: request.system,
        messages: [{ role: "user", content: request.user }],
        ...thinking(request.reasoning),
      };
      const raw = await sendApiRequest({
        provider: "Anthropic",
        url: ANTHROPIC_URL,
        headers: {
          "x-api-key": key,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
        },
        body,
        fetch: fetchImpl,
        redactor,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      return { text: extractText(raw) };
    },
  };
}

function requireKey(env: NodeJS.ProcessEnv): string {
  const key = env[KEY_ENV];
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new ApiAdapterError(
      `Missing ${KEY_ENV}; set it in the environment to use the Anthropic API adapter.`,
      false,
      { kind: "missing-key", provider: "Anthropic" },
    );
  }
  return key;
}

/**
 * Higher reasoning levels enable extended thinking with a token budget that
 * stays below `max_tokens`; low and medium keep the fast, non-thinking path.
 */
function thinking(level: ReasoningLevel): { thinking?: { type: "enabled"; budget_tokens: number } } {
  if (level === "high") {
    return { thinking: { type: "enabled", budget_tokens: 2048 } };
  }
  if (level === "xhigh") {
    return { thinking: { type: "enabled", budget_tokens: 4096 } };
  }
  return {};
}

function extractText(raw: string): string {
  const parsed = parseJson(raw);
  const blocks = readArray(readProperty(parsed, "content"));
  const text = blocks
    .filter((block) => readProperty(block, "type") === "text")
    .map((block) => readProperty(block, "text"))
    .filter((value): value is string => typeof value === "string")
    .join("");
  if (text.trim().length === 0) {
    throw new ApiAdapterError("Anthropic returned an empty message.", false, {
      kind: "empty-response",
      provider: "Anthropic",
    });
  }
  return text;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ApiAdapterError("Anthropic returned a response that was not valid JSON.", false, {
      kind: "bad-response",
      provider: "Anthropic",
    });
  }
}

function readProperty(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

function readArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

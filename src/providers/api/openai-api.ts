import type { ReasoningLevel } from "../../config/config.js";
import type { ReportedUsage } from "../../application/ports.js";
import type { ModelAdapter } from "../adapter.js";
import { createRedactor } from "../reliability.js";
import { ApiAdapterError, defaultFetch, sendApiRequest } from "./http.js";
import type { FetchLike } from "./http.js";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const KEY_ENV = "OPENAI_API_KEY";

/**
 * OpenAI's current default model. It lives in the provider layer — not config or
 * domain — so `provider-default` resolves here and a moving default is a
 * one-line change instead of a schema migration.
 */
const DEFAULT_MODEL = "gpt-5";

export interface OpenAiApiAdapterOptions {
  readonly fetch?: FetchLike;
  readonly env?: NodeJS.ProcessEnv;
  readonly redactor?: (text: string) => string;
}

export function createOpenAiApiAdapter(options: OpenAiApiAdapterOptions = {}): ModelAdapter {
  const fetchImpl = options.fetch ?? defaultFetch;
  const env = options.env ?? process.env;

  return {
    capabilities: {
      id: "openai-api",
      transport: "api",
      authMode: "api-key",
      roles: ["architect", "worker", "reviewer"],
      workspaceAccess: false,
    },
    async run(request) {
      if (request.workingDirectory !== undefined) {
        throw new ApiAdapterError(
          "OpenAI API is text-only and cannot execute in a local workspace.",
          false,
          { kind: "client", provider: "OpenAI" },
        );
      }
      const key = requireKey(env);
      const redactor = options.redactor ?? createRedactor([key]);
      const model = request.model === "provider-default" ? DEFAULT_MODEL : request.model;
      const body = {
        model,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
        reasoning_effort: reasoningEffort(request.reasoning),
      };
      const raw = await sendApiRequest({
        provider: "OpenAI",
        url: OPENAI_URL,
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body,
        fetch: fetchImpl,
        redactor,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const parsed = parseJson(raw);
      return { text: extractText(parsed), usage: extractUsage(parsed) };
    },
  };
}

function requireKey(env: NodeJS.ProcessEnv): string {
  const key = env[KEY_ENV];
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new ApiAdapterError(
      `Missing ${KEY_ENV}; set it in the environment to use the OpenAI API adapter.`,
      false,
      { kind: "missing-key", provider: "OpenAI" },
    );
  }
  return key;
}

/** OpenAI accepts low, medium, and high; DraftForge's xhigh maps to high. */
function reasoningEffort(level: ReasoningLevel): "low" | "medium" | "high" {
  return level === "low" ? "low" : level === "medium" ? "medium" : "high";
}

function extractText(parsed: unknown): string {
  const choices = readArray(readProperty(parsed, "choices"));
  const message = readProperty(choices[0], "message");
  const content = readProperty(message, "content");
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new ApiAdapterError("OpenAI returned an empty completion.", false, {
      kind: "empty-response",
      provider: "OpenAI",
    });
  }
  return content;
}

/**
 * OpenAI reports `prompt_tokens` / `completion_tokens` / `total_tokens`. A
 * field the provider omits, or a wire value that fails defensive validation
 * (non-integer, negative, non-numeric), stays `null` — never coerced, never 0.
 */
function extractUsage(parsed: unknown): ReportedUsage {
  const usage = readProperty(parsed, "usage");
  return {
    inputTokens: validatedCount(readProperty(usage, "prompt_tokens")),
    outputTokens: validatedCount(readProperty(usage, "completion_tokens")),
    totalTokens: validatedCount(readProperty(usage, "total_tokens")),
  };
}

function validatedCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ApiAdapterError("OpenAI returned a response that was not valid JSON.", false, {
      kind: "bad-response",
      provider: "OpenAI",
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

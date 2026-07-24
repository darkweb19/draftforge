import type { AdapterId } from "../config/config.js";
import type { ModelAdapter } from "./adapter.js";
import { createAnthropicApiAdapter } from "./api/anthropic-api.js";
import { createOpenAiApiAdapter } from "./api/openai-api.js";
import { createClaudeCliAdapter } from "./harness/claude-cli.js";
import { createCodexCliAdapter } from "./harness/codex-cli.js";

/**
 * Typed adapter registry. Harness entries use local CLI authentication; API
 * entries use environment-supplied keys over the runtime `fetch`.
 */
export type AdapterFactory = () => ModelAdapter;

const REGISTRY: Record<AdapterId, AdapterFactory> = {
  "codex-cli": createCodexCliAdapter,
  "claude-cli": createClaudeCliAdapter,
  "openai-api": createOpenAiApiAdapter,
  "anthropic-api": createAnthropicApiAdapter,
};

export function resolveAdapter(id: AdapterId): ModelAdapter {
  return REGISTRY[id]();
}

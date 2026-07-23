import type { AdapterId } from "../config/config.js";
import type { ModelAdapter } from "./adapter.js";
import { createClaudeCliAdapter } from "./harness/claude-cli.js";
import { createCodexCliAdapter } from "./harness/codex-cli.js";

/**
 * Typed adapter registry. Harness entries use local CLI authentication; P03-T03
 * replaces the remaining API placeholders with fetch-backed adapters.
 */
export type AdapterFactory = () => ModelAdapter;

const ARRIVING_IN: Record<AdapterId, string> = {
  "codex-cli": "available",
  "claude-cli": "available",
  "openai-api": "P03-T03",
  "anthropic-api": "P03-T03",
};

const REGISTRY: Record<AdapterId, AdapterFactory> = {
  "codex-cli": createCodexCliAdapter,
  "claude-cli": createClaudeCliAdapter,
  "openai-api": () => notImplemented("openai-api"),
  "anthropic-api": () => notImplemented("anthropic-api"),
};

export function resolveAdapter(id: AdapterId): ModelAdapter {
  return REGISTRY[id]();
}

function notImplemented(id: AdapterId): never {
  throw new Error(`Adapter "${id}" is not implemented yet; it arrives in ${ARRIVING_IN[id]}.`);
}

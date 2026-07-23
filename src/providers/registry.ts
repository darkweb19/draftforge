import type { AdapterId } from "../config/config.js";
import type { ModelAdapter } from "./adapter.js";

/**
 * Typed adapter registry. P03-T01 ships placeholder factories; P03-T02 replaces
 * the harness entries and P03-T03 replaces the API entries with real transports.
 */
export type AdapterFactory = () => ModelAdapter;

const ARRIVING_IN: Record<AdapterId, string> = {
  "codex-cli": "P03-T02",
  "claude-cli": "P03-T02",
  "openai-api": "P03-T03",
  "anthropic-api": "P03-T03",
};

const REGISTRY: Record<AdapterId, AdapterFactory> = {
  "codex-cli": () => notImplemented("codex-cli"),
  "claude-cli": () => notImplemented("claude-cli"),
  "openai-api": () => notImplemented("openai-api"),
  "anthropic-api": () => notImplemented("anthropic-api"),
};

export function resolveAdapter(id: AdapterId): ModelAdapter {
  return REGISTRY[id]();
}

function notImplemented(id: AdapterId): never {
  throw new Error(`Adapter "${id}" is not implemented yet; it arrives in ${ARRIVING_IN[id]}.`);
}

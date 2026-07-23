import type { AdapterId, ReasoningLevel } from "../config/config.js";
import type { ModelResponse, ModelRole } from "../application/ports.js";

/**
 * The provider adapter contract. Every harness or API implementation lives in
 * `src/providers/` and satisfies this interface; the role-routed runner
 * (`createModelRunner`) is the only thing application code depends on.
 */
export type AdapterTransport = "harness" | "api";
export type AdapterAuthMode = "local-cli" | "api-key";

/** Pure, side-effect-free description of an adapter. No network or process call. */
export interface AdapterCapabilities {
  readonly id: AdapterId;
  readonly transport: AdapterTransport;
  readonly authMode: AdapterAuthMode;
  readonly roles: readonly ModelRole[];
}

/** A single invocation already routed to a concrete adapter, model, and level. */
export interface AdapterRequest {
  readonly role: ModelRole;
  readonly model: string;
  readonly reasoning: ReasoningLevel;
  readonly system: string;
  readonly user: string;
  /** Aborted when the shared reliability wrapper's per-call timeout fires. */
  readonly signal?: AbortSignal;
}

export interface ModelAdapter {
  readonly capabilities: AdapterCapabilities;
  run(request: AdapterRequest): Promise<ModelResponse>;
}

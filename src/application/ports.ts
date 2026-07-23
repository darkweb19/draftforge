/**
 * The model-runner port. Adapters live in `src/providers/` and arrive in
 * Phase 3; application code depends only on this interface.
 */
export type ModelRole = "architect" | "worker" | "reviewer";

export interface ModelRequest {
  readonly role: ModelRole;
  readonly system: string;
  readonly user: string;
}

export interface ModelResponse {
  /** Raw text as returned by the provider, before any parsing. */
  readonly text: string;
}

export interface ModelRunner {
  run(request: ModelRequest): Promise<ModelResponse>;
}

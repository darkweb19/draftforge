/**
 * The model-runner port. Adapters live in `src/providers/` and arrive in
 * Phase 3; application code depends only on this interface.
 */
export type ModelRole = "architect" | "worker" | "reviewer";

export interface ModelCapabilities {
  /** Whether the transport can execute against a caller-selected local workspace. */
  readonly workspaceAccess: boolean;
}

export interface ModelProcessStart {
  readonly processId: number;
}

export interface ModelRequest {
  readonly role: ModelRole;
  readonly system: string;
  readonly user: string;
  /** Required for a worker call that may mutate an isolated worktree. */
  readonly workingDirectory?: string;
  /** Side-effecting workspace calls must opt out of transparent retries. */
  readonly retryPolicy?: "standard" | "none";
  /** A validated per-call override, used for the effective task budget. */
  readonly timeoutMs?: number;
  /** Reports the local harness process as soon as it is spawned. */
  readonly onProcessStart?: (process: ModelProcessStart) => void;
}

export interface ModelResponse {
  /** Raw text as returned by the provider, before any parsing. */
  readonly text: string;
}

export interface ModelRunner {
  /** Optional for injected legacy runners; worker execution requires it. */
  readonly capabilities?: (role: ModelRole) => ModelCapabilities;
  run(request: ModelRequest): Promise<ModelResponse>;
}

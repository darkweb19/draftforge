/**
 * Provider-independent boundary for a task attempt's isolated Git workspace.
 * The scheduler owns attempt persistence; this port only derives and protects
 * the local workspace that belongs to an already-stable attempt identity.
 */
export interface WorkspaceAttempt {
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
}

export interface WorkspaceLocation {
  readonly attempt: WorkspaceAttempt;
  readonly path: string;
  readonly branch: string;
  readonly baseCommit: string;
}

export type WorkspaceInspectionState = "missing" | "ready" | "unsafe";

export interface WorkspaceInspection {
  readonly state: WorkspaceInspectionState;
  readonly location: WorkspaceLocation | undefined;
  readonly dirty: boolean;
  readonly changedPaths: readonly string[];
  readonly reason: string | undefined;
}

export type ProcessLiveness = "alive" | "not-found" | "unknown";

export interface WorkspaceProcess {
  /** Operating-system process identity of a worker associated with this workspace. */
  readonly processId: number;
}

export type WorkspaceCleanupResult =
  | { readonly outcome: "removed" }
  | { readonly outcome: "preserved"; readonly reason: string };

export interface CreateOrRecoverWorkspaceOptions {
  /**
   * A live or indeterminate process is a safety stop: its worktree must not be
   * reused by another worker. Callers omit this only when no worker exists.
   */
  readonly activeProcess?: WorkspaceProcess;
}

export interface WorkspacePort {
  createOrRecover(
    attempt: WorkspaceAttempt,
    options?: CreateOrRecoverWorkspaceOptions,
  ): Promise<WorkspaceLocation>;
  inspect(attempt: WorkspaceAttempt): Promise<WorkspaceInspection>;
  changedPaths(attempt: WorkspaceAttempt): Promise<readonly string[]>;
  processLiveness(process: WorkspaceProcess): Promise<ProcessLiveness>;
  cleanup(
    attempt: WorkspaceAttempt,
    options?: CreateOrRecoverWorkspaceOptions,
  ): Promise<WorkspaceCleanupResult>;
}

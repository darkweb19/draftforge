import type { WorkspaceAttempt, WorkspaceLocation } from "./workspace.js";

/**
 * Review owns a deliberately small workspace boundary. It is distinct from
 * Phase 4's worker port because inspection and merging are scheduler actions,
 * not capabilities available to a model worker.
 */
export interface ReviewWorkspacePort {
  reviewSnapshot(
    attempt: WorkspaceAttempt,
    expectedBaseCommit: string,
  ): Promise<ReviewWorkspaceSnapshot>;
  prepareRepair(
    previous: WorkspaceAttempt,
    next: WorkspaceAttempt,
    expectedBaseCommit: string,
  ): Promise<WorkspaceLocation>;
  prepareIntegration(input: IntegrateAcceptedInput): Promise<IntegrationPreparation>;
  mergePreparedIntegration(intent: IntegrationIntent): Promise<IntegrationResult>;
}

export interface ReviewWorkspaceSnapshot {
  readonly location: WorkspaceLocation;
  readonly changedPaths: readonly string[];
  readonly patch: string;
  readonly untracked: readonly { readonly path: string; readonly contents: string }[];
}

export interface IntegrateAcceptedInput {
  readonly attempt: WorkspaceAttempt;
  readonly expectedBaseCommit: string;
  readonly taskId: string;
}

/** Recorded durably before a merge changes the project branch. */
export interface IntegrationIntent {
  readonly projectBranch: string;
  readonly rollbackCommit: string;
  readonly branchTip: string;
  readonly taskId: string;
}

export type IntegrationPreparation =
  | { readonly status: "prepared"; readonly intent: IntegrationIntent }
  | { readonly status: "conflict"; readonly projectBranch: string; readonly rollbackCommit: string; readonly detail: string };

export type IntegrationResult =
  | {
      readonly status: "integrated";
      readonly projectBranch: string;
      readonly rollbackCommit: string;
      readonly integrationCommit: string;
    }
  | {
      readonly status: "conflict";
      readonly projectBranch: string;
      readonly rollbackCommit: string;
      readonly detail: string;
    };

import { PROJECT_STATE_SCHEMA_VERSION, type ProjectState } from "../domain/state.js";

export const DRAFT_FILE = "idea.md";

export interface InitialStateInput {
  readonly projectName: string;
  readonly now: Date;
  readonly updatedBy: string;
}

/**
 * A freshly initialized project has no phases or tasks yet: planning happens in
 * `draftforge plan`, which is the first step recorded in the handoff.
 */
export function createInitialProjectState(input: InitialStateInput): ProjectState {
  return {
    $schema: "./schema/state.schema.json",
    schemaVersion: PROJECT_STATE_SCHEMA_VERSION,
    project: {
      name: input.projectName,
      draftFile: DRAFT_FILE,
    },
    workflow: {
      phaseId: "phase-00",
      phaseName: "Intake",
      stage: "idea",
      status: "not_started",
      currentTask: null,
      nextTask: null,
    },
    phases: [{ id: "phase-00", name: "Intake", status: "not_started" }],
    tasks: [],
    decisions: [],
    handoff: {
      updatedAt: input.now.toISOString(),
      updatedBy: input.updatedBy,
      summary: `Initialized ${input.projectName} with DraftForge. No planning has run yet.`,
      decisionsLocked: [],
      openQuestions: [],
      blockers: [],
      nextActions: [
        `Describe the project in ${DRAFT_FILE}.`,
        `Run \`draftforge plan ${DRAFT_FILE}\` to produce decisions and a task graph.`,
      ],
      gotchas: [],
    },
  };
}

import type { PlanningArtifact } from "../domain/planning.js";
import type { ArchitectResponseKind } from "../domain/architect.js";
import type { ModelRequest } from "./ports.js";

export interface ArchitectPromptInput {
  readonly artifact: PlanningArtifact;
  readonly projectName: string;
  /** Contents of the source draft named by `artifact.sourceFile`. */
  readonly sourceText: string;
}

/**
 * The stage is derived from planning state, never chosen by the caller, so a
 * prompt cannot ask for a plan while blocking questions are open.
 */
export function architectStage(artifact: PlanningArtifact): ArchitectResponseKind {
  if (artifact.status === "interview" && artifact.questions.items.length === 0) {
    return "questions";
  }
  if (artifact.questions.revision < artifact.revision) {
    // A revision re-opens the interview: the architect restates the batch for the
    // new revision, and recorded answers carry forward into it.
    return "questions";
  }
  const blocking = artifact.questions.items.filter(
    (question) => question.blocking && question.answer === null,
  );
  return blocking.length > 0 ? "questions" : "plan";
}

export function buildArchitectPrompt(input: ArchitectPromptInput): ModelRequest {
  const { artifact, projectName, sourceText } = input;
  if (projectName.trim().length === 0) {
    throw new Error("Architect prompt requires a project name.");
  }
  if (sourceText.trim().length === 0) {
    throw new Error(`Planning source ${artifact.sourceFile} is empty.`);
  }
  if (artifact.status === "approved") {
    throw new Error(
      `Planning revision ${artifact.revision} is approved; start a recorded plan revision before prompting the architect again.`,
    );
  }

  const stage = architectStage(artifact);
  const currentBatch = artifact.questions.revision === artifact.revision;
  const outstanding = artifact.questions.items.filter(
    (question) => question.blocking && question.answer === null,
  );
  if (stage === "questions" && currentBatch && outstanding.length > 0) {
    throw new Error(
      `Planning revision ${artifact.revision} already has a question batch; answer ${outstanding
        .map((question) => question.id)
        .join(", ")} before prompting the architect again.`,
    );
  }

  return {
    role: "architect",
    system: systemPrompt(),
    user: [
      `# Project: ${projectName}`,
      `Planning revision: ${artifact.revision}`,
      `Requested output: ${stage}`,
      "",
      `# Source draft (${artifact.sourceFile})`,
      "",
      sourceText.trimEnd(),
      "",
      revisionSection(artifact),
      "",
      answeredSection(artifact),
      "",
      stage === "questions" ? questionsInstructions() : planInstructions(),
      "",
    ].join("\n"),
  };
}

function systemPrompt(): string {
  return [
    "You are the architect role of DraftForge, a CLI that turns a product draft into",
    "decisions and a reviewable task graph executed by isolated worker agents.",
    "",
    "Rules:",
    "- Ask every material follow-up question in ONE batch. Never drip-feed questions.",
    "- Decide naming, structure, stack, and phase boundaries unless the draft constrains them.",
    "- State assumptions explicitly instead of asking about low-stakes details.",
    "- Produce tasks small enough for an isolated worker with non-overlapping owned paths.",
    "- Never write implementation code and never approve your own plan.",
    "",
    "Reply with a single JSON object and nothing else. No prose, no explanation.",
    "A fenced ```json block is accepted; anything else is rejected.",
  ].join("\n");
}

function revisionSection(artifact: PlanningArtifact): string {
  const record = artifact.revisions.at(-1);
  if (record === undefined || record.revision !== artifact.revision) {
    return "# Revision\n\nThis is the first planning revision.";
  }
  return [
    "# Revision",
    "",
    `Revision ${record.revision} supersedes ${record.previousRevision}, requested by ${record.requestedBy}.`,
    `Reason: ${record.reason}`,
    `Reopened tasks: ${listOrNone(record.reopenedTasks)}`,
    `Retired tasks: ${listOrNone(record.retiredTasks)}`,
    "",
    "Keep every task ID whose work is finished or in flight unless it is listed as",
    "retired above. Reuse existing IDs for work that is unchanged.",
  ].join("\n");
}

function listOrNone(ids: readonly string[]): string {
  return ids.length === 0 ? "none" : ids.join(", ");
}

function answeredSection(artifact: PlanningArtifact): string {
  const answered = artifact.questions.items.filter((question) => question.answer !== null);
  if (answered.length === 0) {
    return "# Answered questions\n\nNone yet.";
  }
  return [
    "# Answered questions",
    "",
    ...answered.map((question) => `- ${question.id}: ${question.prompt}\n  Answer: ${question.answer ?? ""}`),
  ].join("\n");
}

function questionsInstructions(): string {
  return [
    "# Required output",
    "",
    "Return the complete question batch for this revision:",
    "",
    "```json",
    "{",
    '  "kind": "questions",',
    '  "questions": {',
    `    "revision": <planning revision above>,`,
    '    "items": [',
    '      { "id": "Q1", "prompt": "…", "blocking": true, "answer": null }',
    "    ]",
    "  }",
    "}",
    "```",
    "",
    "Mark a question `blocking` only when the plan cannot be written without it.",
    "Every `answer` must be null; answers come from the user, not from you.",
  ].join("\n");
}

function planInstructions(): string {
  return [
    "# Required output",
    "",
    "Return the full plan for this revision:",
    "",
    "```json",
    "{",
    '  "kind": "plan",',
    '  "plan": {',
    '    "revision": <planning revision above>,',
    '    "assumptions": ["…"],',
    '    "decisions": [',
    "      {",
    '        "id": "ADR-001", "title": "…",',
    '        "adrFile": "docs/decisions/0001-slug.md",',
    '        "context": "…", "decision": "…", "consequences": ["…"]',
    "      }",
    "    ],",
    '    "phases": [',
    '      { "id": "phase-01", "name": "…", "objective": "…", "exitCriteria": ["…"] }',
    "    ],",
    '    "tasks": [',
    "      {",
    '        "id": "P01-T01", "title": "…", "phaseId": "phase-01", "objective": "…",',
    '        "dependsOn": [], "ownedPaths": ["src/"], "requiredContext": [],',
    '        "relevantAdrs": ["docs/decisions/0001-slug.md"],',
    '        "acceptanceCriteria": ["…"], "verification": ["npm test"], "exclusions": []',
    "      }",
    "    ],",
    '    "risks": [{ "id": "R1", "description": "…", "mitigation": "…" }],',
    '    "verification": ["npm test"]',
    "  }",
    "}",
    "```",
    "",
    "Constraints enforced on ingest:",
    "- Phase IDs match `phase-NN`; task IDs match `PNN-TNN` and share their phase number.",
    "- `dependsOn` references existing task IDs, is not self-referential, and is acyclic.",
    "- `adrFile`, `ownedPaths`, `requiredContext`, and `relevantAdrs` are project-relative",
    "  paths without `..`; ADR files live under `docs/decisions/` and end in `.md`.",
    "- The first phase is the active phase and must contain at least one task with no",
    "  dependencies.",
  ].join("\n");
}

import {
  assertPlanningPlan,
  assertQuestionBatch,
  type PlanningPlan,
  type PlanningQuestionBatch,
} from "./planning.js";

/**
 * The architect answers exactly one of the two planning checkpoints per turn.
 * Anything else is a contract violation, not a partial result to salvage.
 */
export type ArchitectResponseKind = "questions" | "plan";

export interface ArchitectQuestionsResponse {
  readonly kind: "questions";
  readonly questions: PlanningQuestionBatch;
}

export interface ArchitectPlanResponse {
  readonly kind: "plan";
  readonly plan: PlanningPlan;
}

export type ArchitectResponse = ArchitectQuestionsResponse | ArchitectPlanResponse;

const RESPONSE_KINDS: readonly ArchitectResponseKind[] = ["questions", "plan"];

export function assertArchitectResponse(value: unknown): asserts value is ArchitectResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Architect response must be a JSON object.");
  }

  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (typeof kind !== "string" || !RESPONSE_KINDS.includes(kind as ArchitectResponseKind)) {
    throw new Error(`Architect response kind must be one of: ${RESPONSE_KINDS.join(", ")}.`);
  }

  const allowed = kind === "questions" ? ["kind", "questions"] : ["kind", "plan"];
  const unexpected = Object.keys(record).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) {
    throw new Error(`Architect ${kind} response contains unsupported property: ${unexpected}.`);
  }

  if (kind === "questions") {
    assertQuestionBatch(record.questions);
    if (record.questions.items.length === 0) {
      throw new Error("Architect questions response must include at least one question.");
    }
    return;
  }
  assertPlanningPlan(record.plan);
}

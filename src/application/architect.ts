import {
  assertArchitectResponse,
  type ArchitectResponse,
} from "../domain/architect.js";
import type { PlanningArtifact } from "../domain/planning.js";
import { architectStage, buildArchitectPrompt, type ArchitectPromptInput } from "./architect-prompt.js";
import { submitPlan, submitQuestionBatch } from "./planning.js";
import type { ModelRunner } from "./ports.js";

const FENCE_PATTERN = /^\s*```(?:json)?\s*\r?\n([\s\S]*?)\r?\n\s*```\s*$/;

/**
 * Boundary parser: raw provider text in, validated contract out. Nothing
 * unvalidated crosses into the domain.
 */
export function parseArchitectResponse(raw: string): ArchitectResponse {
  const fenced = FENCE_PATTERN.exec(raw);
  const text = (fenced?.[1] ?? raw).trim();
  if (text.length === 0) {
    throw new Error("Architect response was empty.");
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause: unknown) {
    throw new Error(
      `Architect response is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }

  assertArchitectResponse(value);
  return value;
}

export function applyArchitectResponse(
  artifact: PlanningArtifact,
  response: ArchitectResponse,
): PlanningArtifact {
  assertArchitectResponse(response);

  if (artifact.status === "approved") {
    throw new Error(
      `Planning revision ${artifact.revision} is approved; start a recorded plan revision before submitting a new architect response.`,
    );
  }

  const expected = architectStage(artifact);
  if (response.kind !== expected) {
    throw new Error(
      `Planning revision ${artifact.revision} expects an architect "${expected}" response, not "${response.kind}".`,
    );
  }

  return response.kind === "questions"
    ? submitQuestionBatch(artifact, response.questions)
    : submitPlan(artifact, response.plan);
}

export async function runArchitectTurn(
  input: ArchitectPromptInput,
  runner: ModelRunner,
): Promise<PlanningArtifact> {
  const request = buildArchitectPrompt(input);
  const { text } = await runner.run(request);
  return applyArchitectResponse(input.artifact, parseArchitectResponse(text));
}

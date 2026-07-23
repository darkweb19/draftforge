import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertPlanningArtifact,
  type PlanningArtifact,
} from "../domain/planning.js";
import { writeFileAtomic } from "./files.js";

export const PLANNING_PATH = ".draftforge/planning.json";

export async function readPlanningArtifact(root: string): Promise<PlanningArtifact> {
  const path = resolve(root, PLANNING_PATH);
  let raw: string;

  try {
    raw = await readFile(path, "utf8");
  } catch (cause: unknown) {
    if (hasErrorCode(cause, "ENOENT")) {
      throw Object.assign(
        new Error(
          `Planning artifact is missing at ${PLANNING_PATH}; run \`draftforge plan <source-file>\` first.`,
          { cause },
        ),
        { code: "ENOENT" as const },
      );
    }
    throw new Error(
      `Unable to read planning artifact at ${PLANNING_PATH}: ${errorMessage(cause)}`,
      { cause },
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause: unknown) {
    throw new Error(
      `Planning artifact at ${PLANNING_PATH} contains malformed JSON: ${errorMessage(cause)}`,
      { cause },
    );
  }

  try {
    assertPlanningArtifact(value);
  } catch (cause: unknown) {
    throw new Error(
      `Planning artifact at ${PLANNING_PATH} is not valid DraftForge planning state: ${errorMessage(cause)}`,
      { cause },
    );
  }

  return value;
}

export function serializePlanningArtifact(artifact: PlanningArtifact): string {
  assertPlanningArtifact(artifact);
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

export async function writePlanningArtifact(
  root: string,
  artifact: PlanningArtifact,
): Promise<void> {
  await writeFileAtomic(resolve(root, PLANNING_PATH), serializePlanningArtifact(artifact));
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

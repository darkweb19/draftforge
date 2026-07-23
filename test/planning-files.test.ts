import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  assertPlanningFilesWritable,
  planApprovedFiles,
} from "../src/application/planning-files.js";
import type { PlanningPlan } from "../src/domain/planning.js";

const plan: PlanningPlan = {
  revision: 1,
  assumptions: [],
  decisions: [
    {
      id: "ADR-001",
      title: "Runtime",
      adrFile: "docs/decisions/0001-runtime.md",
      context: "A runtime is required.",
      decision: "Use Node.js.",
      consequences: ["Node.js is required."],
    },
  ],
  phases: [
    {
      id: "phase-01",
      name: "Foundation",
      objective: "Build the foundation.",
      exitCriteria: ["Checks pass."],
    },
  ],
  tasks: [
    {
      id: "P01-T01",
      title: "Build foundation",
      phaseId: "phase-01",
      objective: "Build the foundation.",
      dependsOn: [],
      ownedPaths: ["src/"],
      requiredContext: [],
      relevantAdrs: ["docs/decisions/0001-runtime.md"],
      acceptanceCriteria: ["The foundation exists."],
      verification: ["npm test"],
      exclusions: [],
    },
  ],
  risks: [],
  verification: ["npm test"],
};

test("rejects planning outputs routed through a symlink or junction", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "draftforge-planning-files-"));
  const external = await mkdtemp(join(tmpdir(), "draftforge-planning-external-"));
  try {
    await mkdir(resolve(root, "docs"));
    try {
      await symlink(external, resolve(root, "docs/decisions"), "junction");
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error.code === "EPERM" || error.code === "EACCES")
      ) {
        context.skip("This environment does not permit creating a test junction.");
        return;
      }
      throw error;
    }

    await assert.rejects(
      assertPlanningFilesWritable(root, planApprovedFiles(plan)),
      /cannot use a symlink or junction/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

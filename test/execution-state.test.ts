import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  assertExecutionAttemptManifest,
  isRepairableClassification,
  type ExecutionAttemptManifest,
} from "../src/domain/execution.js";
import { createExecutionAttemptManifest, readExecutionAttemptManifest, updateExecutionAttemptManifest, writeAttemptResult, writeExecutionAttemptManifest } from "../src/state/execution.js";
import { migrateProjectState } from "../src/state/files.js";

type MigratedTask = { readonly attempt?: unknown; readonly review?: unknown };
type Migrated = { readonly schemaVersion: number; readonly tasks: readonly MigratedTask[] };

test("migrates a v1 document to v3, adding both attempt and review", () => {
  const migrated = migrateProjectState({ schemaVersion: 1, tasks: [{ id: "P04-T01" }] }) as Migrated;
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.tasks[0]?.attempt, null);
  assert.equal(migrated.tasks[0]?.review, null);
});

test("migrates a v1 document whose tasks already carry an attempt, adding only review", () => {
  const migrated = migrateProjectState({
    schemaVersion: 1,
    tasks: [{ id: "P04-T01", attempt: { runId: "run-01", attemptId: "attempt-01" } }],
  }) as Migrated;
  assert.equal(migrated.schemaVersion, 3);
  assert.deepEqual(migrated.tasks[0]?.attempt, { runId: "run-01", attemptId: "attempt-01" });
  assert.equal(migrated.tasks[0]?.review, null);
});

test("migrates a v2 document to v3, adding only review", () => {
  const migrated = migrateProjectState({
    schemaVersion: 2,
    tasks: [{ id: "P04-T01", attempt: null }],
  }) as Migrated;
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.tasks[0]?.attempt, null);
  assert.equal(migrated.tasks[0]?.review, null);
});

test("leaves a v3 document untouched", () => {
  const input = { schemaVersion: 3, tasks: [{ id: "P04-T01", attempt: null, review: null }] };
  assert.deepEqual(migrateProjectState(input), input);
});

test("leaves a document with a non-array tasks field untouched for the validator to reject", () => {
  const input = { schemaVersion: 1, tasks: "not-an-array" };
  assert.deepEqual(migrateProjectState(input), input);
});

test("leaves an unknown future schema version untouched", () => {
  const input = { schemaVersion: 99, tasks: [{ id: "P04-T01" }] };
  assert.deepEqual(migrateProjectState(input), input);
});

function baseManifest(): ExecutionAttemptManifest {
  return createExecutionAttemptManifest({
    reference: { runId: "run-01", attemptId: "attempt-01" },
    taskId: "P04-T01",
    contractHash: "a".repeat(64),
    now: new Date("2026-07-26T00:00:00.000Z"),
  });
}

test("a Phase 4 manifest with every new section absent still validates", () => {
  const { verification, scan, verdict, usage, integration, ...phase4 } = baseManifest();
  assert.doesNotThrow(() => assertExecutionAttemptManifest(phase4));
});

test("every new section present as null still validates", () => {
  assert.doesNotThrow(() => assertExecutionAttemptManifest(baseManifest()));
});

test("rejects an unknown manifest property", () => {
  const invalid: unknown = { ...baseManifest(), extra: true };
  assert.throws(() => assertExecutionAttemptManifest(invalid), /unsupported property: extra/);
});

test("accepts the new attempt lifecycles", () => {
  for (const lifecycle of ["verifying", "reviewing", "repairing", "integrated"] as const) {
    assert.doesNotThrow(() => assertExecutionAttemptManifest({ ...baseManifest(), lifecycle }));
  }
});

test("rejects a malformed verification section", () => {
  const invalid: unknown = {
    ...baseManifest(),
    verification: { status: "failed", classification: null, commands: [], completedAt: "2026-07-26T00:00:00.000Z" },
  };
  assert.throws(() => assertExecutionAttemptManifest(invalid), /classification must be null when status is passed|must be one of/);
});

test("accepts a populated verification section and rejects a bad classification", () => {
  const valid: unknown = {
    ...baseManifest(),
    verification: {
      status: "failed",
      classification: "verification-failure",
      commands: [
        {
          command: "npm run check",
          exitCode: 1,
          durationMs: 1_200,
          timedOut: false,
          terminated: true,
          transcriptPath: ".draftforge/runs/run-01/attempts/attempt-01.verify.log",
        },
      ],
      completedAt: "2026-07-26T00:00:00.000Z",
    },
  };
  assert.doesNotThrow(() => assertExecutionAttemptManifest(valid));

  const badClassification: unknown = {
    ...baseManifest(),
    verification: { status: "failed", classification: "made-up", commands: [], completedAt: "2026-07-26T00:00:00.000Z" },
  };
  assert.throws(() => assertExecutionAttemptManifest(badClassification), /must be one of/);
});

test("scan findings must be non-empty exactly when status is detected", () => {
  const detectedButEmpty: unknown = {
    ...baseManifest(),
    scan: { status: "detected", findings: [], scannedAt: "2026-07-26T00:00:00.000Z" },
  };
  assert.throws(() => assertExecutionAttemptManifest(detectedButEmpty), /findings must be non-empty/);

  const cleanButNonEmpty: unknown = {
    ...baseManifest(),
    scan: {
      status: "clean",
      findings: [{ ruleId: "aws-key", path: "src/config.ts", line: 3 }],
      scannedAt: "2026-07-26T00:00:00.000Z",
    },
  };
  assert.throws(() => assertExecutionAttemptManifest(cleanButNonEmpty), /findings must be empty/);

  const detected: unknown = {
    ...baseManifest(),
    scan: {
      status: "detected",
      findings: [{ ruleId: "aws-key", path: "src/config.ts", line: 3 }],
      scannedAt: "2026-07-26T00:00:00.000Z",
    },
  };
  assert.doesNotThrow(() => assertExecutionAttemptManifest(detected));
});

test("scan finding line must be 1-based", () => {
  const invalid: unknown = {
    ...baseManifest(),
    scan: { status: "detected", findings: [{ ruleId: "aws-key", path: "src/config.ts", line: 0 }], scannedAt: "2026-07-26T00:00:00.000Z" },
  };
  assert.throws(() => assertExecutionAttemptManifest(invalid), /line must be a 1-based integer/);
});

test("verdict classification is null iff the verdict is accept", () => {
  const acceptWithClassification: unknown = {
    ...baseManifest(),
    verdict: { verdict: "accept", classification: "review-rejection", findingCount: 0, evidencePath: null, recordedAt: "2026-07-26T00:00:00.000Z" },
  };
  assert.throws(() => assertExecutionAttemptManifest(acceptWithClassification), /classification must be null when verdict is accept/);

  const rejectWithoutClassification: unknown = {
    ...baseManifest(),
    verdict: { verdict: "reject", classification: null, findingCount: 0, evidencePath: null, recordedAt: "2026-07-26T00:00:00.000Z" },
  };
  assert.throws(() => assertExecutionAttemptManifest(rejectWithoutClassification), /must be one of/);

  const validAccept: unknown = {
    ...baseManifest(),
    verdict: { verdict: "accept", classification: null, findingCount: 0, evidencePath: null, recordedAt: "2026-07-26T00:00:00.000Z" },
  };
  assert.doesNotThrow(() => assertExecutionAttemptManifest(validAccept));
});

test("usage token counts and calls must be non-negative integers or null", () => {
  const negative: unknown = {
    ...baseManifest(),
    usage: { inputTokens: -1, outputTokens: null, totalTokens: null, costUsd: null, calls: 1 },
  };
  assert.throws(() => assertExecutionAttemptManifest(negative), /inputTokens must be a non-negative integer or null/);

  const unknownUsage: unknown = {
    ...baseManifest(),
    usage: { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null, calls: 0 },
  };
  assert.doesNotThrow(() => assertExecutionAttemptManifest(unknownUsage));
});

test("integration commit is null iff the status is conflict", () => {
  const conflictWithCommit: unknown = {
    ...baseManifest(),
    integration: {
      status: "conflict",
      projectBranch: "main",
      rollbackCommit: "a".repeat(40),
      integrationCommit: "b".repeat(40),
      integratedAt: "2026-07-26T00:00:00.000Z",
    },
  };
  assert.throws(() => assertExecutionAttemptManifest(conflictWithCommit), /integrationCommit must be null when status is conflict/);

  const integratedWithoutCommit: unknown = {
    ...baseManifest(),
    integration: {
      status: "integrated",
      projectBranch: "main",
      rollbackCommit: "a".repeat(40),
      integrationCommit: null,
      integratedAt: "2026-07-26T00:00:00.000Z",
    },
  };
  assert.throws(() => assertExecutionAttemptManifest(integratedWithoutCommit), /integrationCommit must be a non-empty string/);
});

test("rejects an unsafe evidence path", () => {
  const absolute: unknown = {
    ...baseManifest(),
    verdict: { verdict: "reject", classification: "unknown", findingCount: 0, evidencePath: "/etc/passwd", recordedAt: "2026-07-26T00:00:00.000Z" },
  };
  assert.throws(() => assertExecutionAttemptManifest(absolute), /must be a safe project-relative path/);

  const traversal: unknown = {
    ...baseManifest(),
    verdict: { verdict: "reject", classification: "unknown", findingCount: 0, evidencePath: "../outside.json", recordedAt: "2026-07-26T00:00:00.000Z" },
  };
  assert.throws(() => assertExecutionAttemptManifest(traversal), /must be a safe project-relative path/);
});

test("verification-failure and review-rejection are the only repairable classifications", () => {
  assert.equal(isRepairableClassification("verification-failure"), true);
  assert.equal(isRepairableClassification("review-rejection"), true);
  for (const classification of ["contract-violation", "scope-violation", "secret-detected", "integration-conflict", "harness-failure", "timeout", "unknown"] as const) {
    assert.equal(isRepairableClassification(classification), false);
  }
});

test("updateExecutionAttemptManifest can patch each new section independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "draftforge-execution-sections-"));
  try {
    const reference = { runId: "run-02", attemptId: "attempt-01" };
    await writeExecutionAttemptManifest(root, {
      ...baseManifest(),
      runId: reference.runId,
      attemptId: reference.attemptId,
      workspace: { id: "worktree-p04-t01", path: `.draftforge/runs/${reference.runId}/worktrees/P04-T01` },
    });
    const now = new Date("2026-07-26T01:00:00.000Z");
    const updated = await updateExecutionAttemptManifest(root, reference, {
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.01, calls: 1 },
      now,
    });
    assert.deepEqual(updated.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.01, calls: 1 });
    assert.equal(updated.scan, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persists a schema-valid manifest and idempotent redacted result before transition", async () => {
  const root = await mkdtemp(join(tmpdir(), "draftforge-execution-"));
  try {
    const reference = { runId: "run-01", attemptId: "attempt-01" };
    const manifest = createExecutionAttemptManifest({
      reference,
      taskId: "P04-T01",
      contractHash: "a".repeat(64),
      now: new Date("2026-07-26T00:00:00.000Z"),
    });
    assert.equal(manifest.workspace.path, ".draftforge/runs/run-01/worktrees/P04-T01");
    await writeExecutionAttemptManifest(root, manifest);
    const persisted = await writeAttemptResult(root, reference, { note: "value-should-not-leak", apiKey: "also-hidden" }, { CUSTOM_SECRET: "value-should-not-leak" });
    assert.equal(persisted.evidence.result, ".draftforge/runs/run-01/attempts/attempt-01.result.json");
    assert.deepEqual(await readExecutionAttemptManifest(root, reference), persisted);
    const result = await readFile(resolve(root, persisted.evidence.result!), "utf8");
    assert.doesNotMatch(result, /value-should-not-leak|also-hidden/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

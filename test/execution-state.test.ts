import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createExecutionAttemptManifest, readExecutionAttemptManifest, writeAttemptResult, writeExecutionAttemptManifest } from "../src/state/execution.js";
import { migrateProjectState } from "../src/state/files.js";

test("migrates v1 task progress to a nullable durable attempt", () => {
  const migrated = migrateProjectState({ schemaVersion: 1, tasks: [{ id: "P04-T01" }] }) as { schemaVersion: number; tasks: readonly { attempt: unknown }[] };
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.tasks[0]?.attempt, null);
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

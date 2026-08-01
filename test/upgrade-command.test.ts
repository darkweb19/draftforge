import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { main, type CliIo } from "../src/cli.js";
import { runInit } from "../src/commands/init.js";
import { readProjectState, writeFileAtomic } from "../src/state/files.js";
import { runUpgrade, UpgradeRecoveryError, UpgradeRefusedError } from "../src/state/upgrade.js";

const UPGRADE_TIME = new Date("2026-08-01T12:34:56.000Z");

async function withProject(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "draftforge-upgrade-"));
  try {
    await runInit(root, { name: "Upgrade fixture", now: UPGRADE_TIME });
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeOlderState(root: string, version: 1 | 2): Promise<void> {
  const current = await readProjectState(root);
  const task = {
    id: "P01-T01",
    title: "Keep history",
    status: "done",
    taskFile: ".draftforge/tasks/P01-T01.md",
    dependsOn: [],
    attempt: { runId: "run-history", attemptId: "attempt-history" },
    review: {
      repairAttempts: 1,
      lastClassification: "review-rejection",
      lastReviewAttempt: { runId: "run-history", attemptId: "attempt-history" },
    },
  };
  const raw = {
    ...current,
    schemaVersion: version,
    tasks: [
      version === 1
        ? (() => {
            const { attempt: _attempt, review: _review, ...v1 } = task;
            return v1;
          })()
        : (() => {
            const { review: _review, ...v2 } = task;
            return v2;
          })(),
    ],
    decisions: ["Keep migration history"],
    handoff: { ...current.handoff, summary: "Older handoff survives upgrade." },
  };
  await writeFile(resolve(root, ".draftforge/state.json"), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  await writeFile(resolve(root, "SESSION.md"), "older rendered handoff\n", "utf8");
}

test("upgrades supported v1 and v2 projects with a recoverable backup and preserved history", async () => {
  for (const version of [1, 2] as const) {
    await withProject(async (root) => {
      await writeOlderState(root, version);
      if (version === 2) {
        await writeFile(
          resolve(root, ".draftforge/schema/state.schema.json"),
          await readFile(resolve(import.meta.dirname, "fixtures/release/upgrade/state-v2.schema.json"), "utf8"),
          "utf8",
        );
      }
      const before = await readFile(resolve(root, ".draftforge/state.json"), "utf8");

      const result = await runUpgrade(root, { now: UPGRADE_TIME });
      assert.equal(result.disposition, "upgraded");
      assert.equal(result.fromVersion, version);
      assert.ok(result.backupPath);
      assert.ok(result.replaced.includes(".draftforge/state.json"));
      assert.ok(result.replaced.includes("SESSION.md"));
      if (version === 2) {
        assert.ok(result.replaced.includes(".draftforge/schema/state.schema.json"));
        assert.equal(
          await readFile(resolve(root, result.backupPath!, ".draftforge/schema/state.schema.json"), "utf8"),
          await readFile(resolve(import.meta.dirname, "fixtures/release/upgrade/state-v2.schema.json"), "utf8"),
        );
        assert.equal(
          await readFile(resolve(root, ".draftforge/schema/state.schema.json"), "utf8"),
          await readFile(resolve(import.meta.dirname, "../templates/schema/state.schema.json"), "utf8"),
        );
      }
      assert.equal(await readFile(resolve(root, result.backupPath!, ".draftforge/state.json"), "utf8"), before);
      assert.equal(await readFile(resolve(root, result.backupPath!, "SESSION.md"), "utf8"), "older rendered handoff\n");

      const upgraded = await readProjectState(root);
      assert.equal(upgraded.schemaVersion, 3);
      assert.equal(upgraded.decisions[0], "Keep migration history");
      assert.equal(upgraded.handoff.summary, "Older handoff survives upgrade.");
      assert.deepEqual(upgraded.tasks[0]?.attempt, version === 1 ? null : { runId: "run-history", attemptId: "attempt-history" });
      assert.equal(upgraded.tasks[0]?.review, null);
      const session = await readFile(resolve(root, "SESSION.md"), "utf8");
      assert.match(session, /Older handoff survives upgrade\./u);
      const statusLines: string[] = [];
      assert.equal(await main(["status"], { out: (line) => statusLines.push(line), error: () => undefined }, root), 0);
      assert.match(statusLines.join("\n"), /Upgrade fixture:/u);
    });
  }
});

test("ordinary state reads migrate supported old documents only in memory", async () => {
  await withProject(async (root) => {
    await writeOlderState(root, 2);
    const before = await readFile(resolve(root, ".draftforge/state.json"), "utf8");
    const migrated = await readProjectState(root);
    assert.equal(migrated.schemaVersion, 3);
    assert.equal(await readFile(resolve(root, ".draftforge/state.json"), "utf8"), before);
  });
});

test("reports a no-op for a current project and does not create a backup", async () => {
  await withProject(async (root) => {
    const before = await readFile(resolve(root, ".draftforge/state.json"), "utf8");
    const result = await runUpgrade(root, { now: UPGRADE_TIME });
    assert.deepEqual(result, { disposition: "current", fromVersion: 3, backupPath: null, replaced: [], created: [] });
    assert.equal(await readFile(resolve(root, ".draftforge/state.json"), "utf8"), before);
    assert.deepEqual(await runUpgrade(root, { now: UPGRADE_TIME }), result, "a second trigger stays a no-op");
  });
});

test("refreshes recognized stale schemas and safely records newly created schema files", async () => {
  await withProject(async (root) => {
    const legacy = await readFile(resolve(import.meta.dirname, "fixtures/release/upgrade/state-v2.schema.json"), "utf8");
    await writeFile(resolve(root, ".draftforge/schema/state.schema.json"), legacy, "utf8");
    await rm(resolve(root, ".draftforge/schema/execution.schema.json"));
    const result = await runUpgrade(root, { now: UPGRADE_TIME });
    assert.equal(result.disposition, "upgraded");
    assert.equal(result.fromVersion, 3);
    assert.deepEqual(result.replaced, [".draftforge/schema/state.schema.json"]);
    assert.deepEqual(result.created, [".draftforge/schema/execution.schema.json"]);
    const manifest = JSON.parse(await readFile(resolve(root, result.backupPath!, "upgrade-manifest.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(manifest.replaced, result.replaced);
    assert.deepEqual(manifest.created, result.created);
    assert.equal(await readFile(resolve(root, result.backupPath!, ".draftforge/schema/state.schema.json"), "utf8"), legacy);
    await assert.rejects(readFile(resolve(root, result.backupPath!, ".draftforge/schema/execution.schema.json")));
  });
});

test("a failed target write reports a complete recovery backup and leaves canonical state untouched", async () => {
  await withProject(async (root) => {
    await writeOlderState(root, 2);
    const before = await readFile(resolve(root, ".draftforge/state.json"), "utf8");
    let recovery: UpgradeRecoveryError | undefined;
    try {
      await runUpgrade(root, {
        now: UPGRADE_TIME,
        writeAtomic: async () => {
          throw new Error("simulated target write failure");
        },
      });
    } catch (error: unknown) {
      assert.ok(error instanceof UpgradeRecoveryError);
      recovery = error;
    }
    assert.ok(recovery);
    assert.match(recovery.message, /simulated target write failure/u);
    assert.equal(await readFile(resolve(root, ".draftforge/state.json"), "utf8"), before);
    const manifest = JSON.parse(await readFile(resolve(root, recovery.backupPath, "upgrade-manifest.json"), "utf8")) as Record<string, unknown>;
    assert.ok(Array.isArray(manifest.replaced));
    assert.equal(await readFile(resolve(root, recovery.backupPath, ".draftforge/state.json"), "utf8"), before);
  });
});

test("a partial upgrade keeps the old state marker so retry replans every replacement", async () => {
  await withProject(async (root) => {
    await writeOlderState(root, 2);
    const legacy = await readFile(resolve(import.meta.dirname, "fixtures/release/upgrade/state-v2.schema.json"), "utf8");
    await writeFile(resolve(root, ".draftforge/schema/state.schema.json"), legacy, "utf8");
    const rawBefore = await readFile(resolve(root, ".draftforge/state.json"), "utf8");
    let targetWrites = 0;
    let recovery: UpgradeRecoveryError | undefined;
    try {
      await runUpgrade(root, {
        now: UPGRADE_TIME,
        writeAtomic: async (path, contents) => {
          targetWrites += 1;
          if (targetWrites === 2) throw new Error("simulated later target write failure");
          await writeFileAtomic(path, contents);
        },
      });
    } catch (error: unknown) {
      assert.ok(error instanceof UpgradeRecoveryError);
      recovery = error;
    }
    assert.equal(targetWrites, 2, "a schema write completed before the later failure");
    assert.ok(recovery);
    assert.equal(await readFile(resolve(root, ".draftforge/state.json"), "utf8"), rawBefore);
    assert.equal((JSON.parse(rawBefore) as { readonly schemaVersion: number }).schemaVersion, 2);
    assert.notEqual(await readFile(resolve(root, ".draftforge/schema/state.schema.json"), "utf8"), legacy);
    assert.ok(Array.isArray((JSON.parse(await readFile(resolve(root, recovery.backupPath, "upgrade-manifest.json"), "utf8")) as { readonly replaced: unknown }).replaced));

    const retried = await runUpgrade(root, { now: new Date("2026-08-01T12:35:56.000Z") });
    assert.equal(retried.disposition, "upgraded");
    assert.equal((await readProjectState(root)).schemaVersion, 3);
    assert.match(await readFile(resolve(root, "SESSION.md"), "utf8"), /Older handoff survives upgrade\./u);
    assert.equal(await main(["status"], { out: () => undefined, error: () => undefined }, root), 0);
  });
});

test("post-plan target drift is preserved and reported through the recovery path", async () => {
  await withProject(async (root) => {
    await writeOlderState(root, 2);
    const legacy = await readFile(resolve(import.meta.dirname, "fixtures/release/upgrade/state-v2.schema.json"), "utf8");
    await writeFile(resolve(root, ".draftforge/schema/state.schema.json"), legacy, "utf8");
    const statePath = resolve(root, ".draftforge/state.json");
    const userChanged = "{\"schemaVersion\":\"user-changed-after-planning\"}\n";
    let writes = 0;
    let recovery: UpgradeRecoveryError | undefined;
    try {
      await runUpgrade(root, {
        now: UPGRADE_TIME,
        writeAtomic: async (path, contents) => {
          writes += 1;
          await writeFileAtomic(path, contents);
          if (writes === 1) await writeFile(statePath, userChanged, "utf8");
        },
      });
    } catch (error: unknown) {
      assert.ok(error instanceof UpgradeRecoveryError);
      recovery = error;
    }
    assert.ok(recovery);
    assert.equal(await readFile(statePath, "utf8"), userChanged);
    assert.match(recovery.message, /target changed after planning/u);
  });

  await withProject(async (root) => {
    await writeOlderState(root, 2);
    const legacy = await readFile(resolve(import.meta.dirname, "fixtures/release/upgrade/state-v2.schema.json"), "utf8");
    await writeFile(resolve(root, ".draftforge/schema/state.schema.json"), legacy, "utf8");
    const appearedPath = resolve(root, ".draftforge/schema/execution.schema.json");
    await rm(appearedPath);
    const userCreated = "user-created-after-planning\n";
    let writes = 0;
    let recovery: UpgradeRecoveryError | undefined;
    try {
      await runUpgrade(root, {
        now: UPGRADE_TIME,
        writeAtomic: async (path, contents) => {
          writes += 1;
          await writeFileAtomic(path, contents);
          if (writes === 1) await writeFile(appearedPath, userCreated, "utf8");
        },
      });
    } catch (error: unknown) {
      assert.ok(error instanceof UpgradeRecoveryError);
      recovery = error;
    }
    assert.ok(recovery);
    assert.equal(await readFile(appearedPath, "utf8"), userCreated);
    assert.match(recovery.message, /target appeared after planning/u);
  });
});

test("orphan recovery artifacts refuse upgrade instead of being ignored", async () => {
  for (const suffix of [".events.jsonl", ".result.json", ".review-lease.json", ".integration-intent.json"] as const) {
    await withProject(async (root) => {
      const attempts = resolve(root, ".draftforge/runs/run-orphan/attempts");
      await mkdir(attempts, { recursive: true });
      await writeFile(resolve(attempts, `attempt-orphan${suffix}`), "{}\n", "utf8");
      await assert.rejects(runUpgrade(root, { now: UPGRADE_TIME }), /recovery artifact.*matching manifest|reviewer lease artifact|integration recovery artifact/u);
    });
  }
});

test("refuses a redirected managed schema before it can overwrite external bytes", async () => {
  const external = await mkdtemp(join(tmpdir(), "draftforge-upgrade-external-schema-"));
  try {
    await withProject(async (root) => {
      await writeOlderState(root, 2);
      const externalSchema = resolve(external, "schema");
      await mkdir(externalSchema);
      const externalStateSchema = resolve(externalSchema, "state.schema.json");
      const legacy = await readFile(resolve(import.meta.dirname, "fixtures/release/upgrade/state-v2.schema.json"), "utf8");
      await writeFile(externalStateSchema, legacy, "utf8");
      await rm(resolve(root, ".draftforge/schema"), { recursive: true });
      await symlink(externalSchema, resolve(root, ".draftforge/schema"), "dir");
      const rawBefore = await readFile(resolve(root, ".draftforge/state.json"), "utf8");

      await assert.rejects(runUpgrade(root, { now: UPGRADE_TIME }), /\.draftforge\/schema is a symbolic link/u);
      assert.equal(await readFile(externalStateSchema, "utf8"), legacy);
      assert.equal(await readFile(resolve(root, ".draftforge/state.json"), "utf8"), rawBefore);
      await assert.rejects(lstat(resolve(root, ".draftforge/backups")));
    });
  } finally {
    await rm(external, { recursive: true, force: true });
  }
});

test("refuses a symlinked orphan attempt event instead of silently skipping it", async () => {
  const external = await mkdtemp(join(tmpdir(), "draftforge-upgrade-external-event-"));
  try {
    await withProject(async (root) => {
      const externalEvent = resolve(external, "attempt.events.jsonl");
      await writeFile(externalEvent, "external event must remain untouched\n", "utf8");
      const attempts = resolve(root, ".draftforge/runs/run-orphan/attempts");
      await mkdir(attempts, { recursive: true });
      await symlink(externalEvent, resolve(attempts, "attempt-orphan.events.jsonl"), "file");
      const rawBefore = await readFile(resolve(root, ".draftforge/state.json"), "utf8");

      await assert.rejects(runUpgrade(root, { now: UPGRADE_TIME }), /recovery attempt entry is not a regular file/u);
      assert.equal(await readFile(externalEvent, "utf8"), "external event must remain untouched\n");
      assert.equal(await readFile(resolve(root, ".draftforge/state.json"), "utf8"), rawBefore);
      await assert.rejects(lstat(resolve(root, ".draftforge/backups")));
    });
  } finally {
    await rm(external, { recursive: true, force: true });
  }
});

test("refuses future, modified-schema, and in-flight projects before mutation", async () => {
  await withProject(async (root) => {
    const statePath = resolve(root, ".draftforge/state.json");
    const before = await readFile(statePath, "utf8");
    const future = { ...JSON.parse(before) as Record<string, unknown>, schemaVersion: 4 };
    await writeFile(statePath, `${JSON.stringify(future, null, 2)}\n`, "utf8");
    const futureBefore = await readFile(statePath, "utf8");
    await assert.rejects(runUpgrade(root, { now: UPGRADE_TIME }), UpgradeRefusedError);
    assert.equal(await readFile(statePath, "utf8"), futureBefore);
  });

  await withProject(async (root) => {
    await writeOlderState(root, 2);
    const schemaPath = resolve(root, ".draftforge/schema/state.schema.json");
    await writeFile(schemaPath, "user-modified schema\n", "utf8");
    const stateBefore = await readFile(resolve(root, ".draftforge/state.json"), "utf8");
    await assert.rejects(runUpgrade(root, { now: UPGRADE_TIME }), /modified or unrecognized.*state\.schema/u);
    assert.equal(await readFile(schemaPath, "utf8"), "user-modified schema\n");
    assert.equal(await readFile(resolve(root, ".draftforge/state.json"), "utf8"), stateBefore);
  });

  await withProject(async (root) => {
    await writeFile(resolve(root, ".draftforge/schema/state.schema.json"), "user-modified schema\n", "utf8");
    await assert.rejects(runUpgrade(root, { now: UPGRADE_TIME }), /modified or unrecognized.*state\.schema/u);
  });

  await withProject(async (root) => {
    const raw = JSON.parse(await readFile(resolve(root, ".draftforge/state.json"), "utf8")) as Record<string, unknown>;
    const active = { ...raw, schemaVersion: 2, tasks: [{ id: "P01-T01", title: "In flight", status: "active", taskFile: ".draftforge/tasks/P01-T01.md", dependsOn: [], attempt: null }] };
    await writeFile(resolve(root, ".draftforge/state.json"), `${JSON.stringify(active, null, 2)}\n`, "utf8");
    const stateBefore = await readFile(resolve(root, ".draftforge/state.json"), "utf8");
    await assert.rejects(runUpgrade(root, { now: UPGRADE_TIME }), /task work is in flight: P01-T01/u);
    assert.equal(await readFile(resolve(root, ".draftforge/state.json"), "utf8"), stateBefore);
  });
});

test("CLI distinguishes current and refused upgrade outcomes and documents upgrade", async () => {
  await withProject(async (root) => {
    const output: string[] = [];
    const errors: string[] = [];
    const io: CliIo = { out: (line) => output.push(line), error: (line) => errors.push(line) };
    assert.equal(await main(["upgrade"], io, root), 0);
    assert.match(output.join("\n"), /already current/u);
    output.length = 0;
    const raw = JSON.parse(await readFile(resolve(root, ".draftforge/state.json"), "utf8")) as Record<string, unknown>;
    await writeFile(resolve(root, ".draftforge/state.json"), `${JSON.stringify({ ...raw, schemaVersion: 4 }, null, 2)}\n`, "utf8");
    assert.equal(await main(["upgrade"], io, root), 2);
    assert.match(errors.join("\n"), /newer than this DraftForge installation/u);
    output.length = 0;
    assert.equal(await main(["help"], io, root), 0);
    assert.match(output.join("\n"), /upgrade\s+Persist a safe, backed-up project schema upgrade/u);
  });
});

test("CLI reports a failed-with-backup upgrade as an operational failure", async () => {
  const output: string[] = [];
  const errors: string[] = [];
  const io: CliIo = { out: (line) => output.push(line), error: (line) => errors.push(line) };
  const backupPath = ".draftforge/backups/recovery-test";
  assert.equal(
    await main(["upgrade"], io, process.cwd(), {
      runUpgrade: async () => {
        throw new UpgradeRecoveryError(backupPath, new Error("simulated write failure"));
      },
    }),
    1,
  );
  assert.equal(output.length, 0);
  assert.match(errors.join("\n"), /Restore replaced files from \.draftforge\/backups\/recovery-test/u);
  assert.match(errors.join("\n"), /remove files listed as created/u);
});

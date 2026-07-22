import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { runInit } from "../src/commands/init.js";
import { assertProjectConfig } from "../src/config/config.js";
import { readProjectState } from "../src/state/files.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "draftforge-init-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("initializes an empty directory with valid state and handoff", async () => {
  await withTempDir(async (dir) => {
    const result = await runInit(dir, { name: "Sample", now: new Date("2026-01-01T00:00:00.000Z") });

    assert.equal(result.conflicts.length, 0);
    assert.equal(result.alreadyInitialized, false);
    assert.equal(result.projectName, "Sample");

    for (const expected of [
      ".draftforge/state.json",
      ".draftforge/config.json",
      ".draftforge/schema/state.schema.json",
      "SESSION.md",
      "AGENTS.md",
      "CLAUDE.md",
      "PHASES.md",
      "idea.md",
    ]) {
      assert.ok(result.created.includes(expected), `expected ${expected} to be created`);
    }

    const state = await readProjectState(dir);
    assert.equal(state.project.name, "Sample");
    assert.equal(state.project.draftFile, "idea.md");
    assert.equal(state.workflow.phaseId, "phase-00");
    assert.equal(state.workflow.currentTask, null);

    const config: unknown = JSON.parse(await readFile(resolve(dir, ".draftforge/config.json"), "utf8"));
    assertProjectConfig(config);

    const session = await readFile(resolve(dir, "SESSION.md"), "utf8");
    assert.match(session, /# Session handoff — 2026-01-01/);

    const agents = await readFile(resolve(dir, "AGENTS.md"), "utf8");
    assert.match(agents, /# Sample — agent instructions/);
    assert.doesNotMatch(agents, /\{\{/);
  });
});

test("defaults the project name to the directory name", async () => {
  await withTempDir(async (dir) => {
    const target = "my-app";
    const result = await runInit(dir, { directory: target });
    assert.equal(result.projectName, target);
    assert.equal(result.root, resolve(dir, target));

    const state = await readProjectState(resolve(dir, target));
    assert.equal(state.project.name, target);
  });
});

test("re-running is idempotent and writes nothing new", async () => {
  await withTempDir(async (dir) => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const first = await runInit(dir, { name: "Sample", now });
    const before = await readFile(resolve(dir, ".draftforge/state.json"), "utf8");

    const second = await runInit(dir, { name: "Sample", now: new Date("2026-02-02T00:00:00.000Z") });

    assert.equal(second.alreadyInitialized, true);
    assert.equal(second.created.length, 0);
    assert.equal(second.conflicts.length, 0);
    assert.equal(second.unchanged.length, first.created.length);

    const after = await readFile(resolve(dir, ".draftforge/state.json"), "utf8");
    assert.equal(after, before, "state.json must not be rewritten on re-init");
  });
});

test("restores a file deleted from an initialized project", async () => {
  await withTempDir(async (dir) => {
    await runInit(dir, { name: "Sample" });
    await rm(resolve(dir, "AGENTS.md"));

    const result = await runInit(dir);
    assert.deepEqual(result.created, ["AGENTS.md"]);
    assert.match(await readFile(resolve(dir, "AGENTS.md"), "utf8"), /# Sample — agent instructions/);
  });
});

test("refuses to overwrite foreign files and writes nothing", async () => {
  await withTempDir(async (dir) => {
    await writeFile(resolve(dir, "AGENTS.md"), "# My own instructions\n", "utf8");

    const result = await runInit(dir, { name: "Sample" });

    assert.deepEqual(result.conflicts, ["AGENTS.md"]);
    assert.equal(result.created.length, 0);
    assert.equal(await readFile(resolve(dir, "AGENTS.md"), "utf8"), "# My own instructions\n");
    await assert.rejects(readProjectState(dir), "no state should be written when a conflict is reported");
  });
});

test("--force overwrites conflicting files", async () => {
  await withTempDir(async (dir) => {
    await writeFile(resolve(dir, "AGENTS.md"), "# My own instructions\n", "utf8");

    const result = await runInit(dir, { name: "Sample", force: true });

    assert.equal(result.conflicts.length, 0);
    assert.ok(result.created.includes("AGENTS.md"));
    assert.match(await readFile(resolve(dir, "AGENTS.md"), "utf8"), /# Sample — agent instructions/);
  });
});

test("leaves unrelated files untouched", async () => {
  await withTempDir(async (dir) => {
    await writeFile(resolve(dir, "notes.txt"), "keep me\n", "utf8");
    await runInit(dir, { name: "Sample" });
    assert.equal(await readFile(resolve(dir, "notes.txt"), "utf8"), "keep me\n");
  });
});

test("reports an actionable error for corrupted state", async () => {
  await withTempDir(async (dir) => {
    await runInit(dir, { name: "Sample" });
    await writeFile(resolve(dir, ".draftforge/state.json"), "{ not json", "utf8");

    await assert.rejects(runInit(dir), /not valid DraftForge state/);
  });
});

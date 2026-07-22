import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { loadProjectConfig } from "../src/config/config.js";
import { withProjectFixture } from "./helpers/fixtures.js";

test("loads the project configuration without a local override", async () => {
  await withProjectFixture("fresh", async (root) => {
    const config = await loadProjectConfig(root);
    assert.equal(config.roles.worker.maxConcurrency, 2);
    assert.equal(config.limits.taskTimeoutMinutes, 30);
  });
});

test("deeply applies config.local.json overrides", async () => {
  await withProjectFixture("resumed", async (root) => {
    const config = await loadProjectConfig(root);
    assert.equal(config.roles.worker.maxConcurrency, 4);
    assert.equal(config.roles.worker.adapter, "claude-cli");
    assert.equal(config.roles.architect.reasoning, "high");
    assert.equal(config.limits.maxRepairAttempts, 2);
    assert.equal(config.limits.taskTimeoutMinutes, 45);
  });
});

test("reports the file and field for invalid local configuration", async () => {
  await withProjectFixture("fresh", async (root) => {
    await writeFile(
      resolve(root, ".draftforge/config.local.json"),
      JSON.stringify({ roles: { worker: { maxConcurrency: 0 } } }),
      "utf8",
    );
    await assert.rejects(loadProjectConfig(root), /roles\.worker\.maxConcurrency must be an integer between 1 and 16/);
  });
});

test("rejects properties that are outside the shipped schema", async () => {
  await withProjectFixture("fresh", async (root) => {
    await writeFile(
      resolve(root, ".draftforge/config.local.json"),
      JSON.stringify({ unexpected: true }),
      "utf8",
    );
    await assert.rejects(loadProjectConfig(root), /unsupported property: unexpected/);
  });
});

test("reports malformed JSON with its discovery path", async () => {
  await withProjectFixture("fresh", async (root) => {
    await writeFile(resolve(root, ".draftforge/config.local.json"), "{ broken", "utf8");
    await assert.rejects(loadProjectConfig(root), /Invalid JSON in \.draftforge\/config\.local\.json/);
  });
});

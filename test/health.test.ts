import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { main, type CliIo } from "../src/cli.js";
import { inspectProjectHealth } from "../src/state/health.js";
import { withProjectFixture } from "./helpers/fixtures.js";

function captureIo(): { io: CliIo; output: string[]; errors: string[] } {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    io: { out: (message) => output.push(message), error: (message) => errors.push(message) },
    output,
    errors,
  };
}

test("fresh and resumed fixtures report healthy", async () => {
  for (const fixture of ["fresh", "resumed"] as const) {
    await withProjectFixture(fixture, async (root) => {
      const checks = await inspectProjectHealth(root);
      assert.ok(checks.every((check) => check.status === "pass"));
    });
  }
});

test("corrupted fixture reports state, config, and handoff failures", async () => {
  await withProjectFixture("corrupted", async (root) => {
    const checks = await inspectProjectHealth(root);
    assert.deepEqual(
      checks.map((check) => [check.name, check.status]),
      [
        ["state", "fail"],
        ["config", "fail"],
        ["handoff", "fail"],
      ],
    );
  });
});

test("status reports SESSION.md drift and exits non-zero", async () => {
  await withProjectFixture("fresh", async (root) => {
    await writeFile(resolve(root, "SESSION.md"), "stale\n", "utf8");
    const capture = captureIo();
    const exitCode = await main(["status"], capture.io, root);
    assert.equal(exitCode, 1);
    assert.match(capture.output.join("\n"), /\[FAIL\] handoff: SESSION\.md has drifted/);
    assert.match(capture.output.join("\n"), /draftforge handoff/);
  });
});

test("doctor includes project health without requiring providers", async () => {
  await withProjectFixture("fresh", async (root) => {
    const capture = captureIo();
    const exitCode = await main(["doctor"], capture.io, root);
    assert.equal(exitCode, 0);
    assert.match(capture.output.join("\n"), /\[PASS\] state/);
    assert.match(capture.output.join("\n"), /\[PASS\] config/);
    assert.match(capture.output.join("\n"), /\[PASS\] handoff/);
  });
});

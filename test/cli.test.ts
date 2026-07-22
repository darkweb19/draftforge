import assert from "node:assert/strict";
import { test } from "node:test";
import { main, type CliIo } from "../src/cli.js";

function captureIo(): { io: CliIo; output: string[]; errors: string[] } {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    io: {
      out: (message) => output.push(message),
      error: (message) => errors.push(message),
    },
    output,
    errors,
  };
}

test("shows help without arguments", async () => {
  const capture = captureIo();
  const exitCode = await main([], capture.io);
  assert.equal(exitCode, 0);
  assert.match(capture.output.join("\n"), /Usage: draftforge/);
});

test("fails clearly for a future-phase command", async () => {
  const capture = captureIo();
  const exitCode = await main(["plan", "idea.md"], capture.io);
  assert.equal(exitCode, 2);
  assert.match(capture.errors.join("\n"), /not implemented in Phase 0/);
});

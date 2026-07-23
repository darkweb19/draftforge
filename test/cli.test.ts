import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main, type CliIo } from "../src/cli.js";
import { runInit } from "../src/commands/init.js";

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
  const exitCode = await main(["run"], capture.io);
  assert.equal(exitCode, 2);
  assert.match(capture.errors.join("\n"), /not implemented until Phase 4/);
});

test("reports plan usage errors with exit code 2", async () => {
  const capture = captureIo();
  const exitCode = await main(["plan", "--approve"], capture.io);
  assert.equal(exitCode, 2);
  assert.match(capture.errors.join("\n"), /requires --by/);
});

test("initializes and resumes provider-neutral planning state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "draftforge-cli-plan-"));
  try {
    await runInit(dir, { name: "Sample" });

    const start = captureIo();
    assert.equal(await main(["plan", "idea.md"], start.io, dir), 0);
    assert.match(start.output.join("\n"), /Initialized planning revision 1/);
    assert.match(start.output.join("\n"), /No provider was called/);

    const resume = captureIo();
    assert.equal(await main(["plan", "idea.md"], resume.io, dir), 0);
    assert.match(resume.output.join("\n"), /Resuming planning revision 1/);

    const status = captureIo();
    assert.equal(await main(["plan", "--status"], status.io, dir), 0);
    assert.match(status.output.join("\n"), /Status: interview/);
    assert.match(status.output.join("\n"), /Questions: 0\/0 answered/);
    assert.match(status.output.join("\n"), /Approval: not approved/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

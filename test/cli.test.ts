import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main, type CliIo } from "../src/cli.js";
import { runInit } from "../src/commands/init.js";
import { materializeCliVariant, type CliVariant } from "./fixtures/execution/project.js";

async function withCliVariant(
  variant: CliVariant,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `draftforge-cli-${variant}-`));
  try {
    await materializeCliVariant(root, variant);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

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

test("help documents the run and resume outcome classes and exit codes", async () => {
  const capture = captureIo();
  assert.equal(await main(["help"], capture.io), 0);
  const help = capture.output.join("\n");
  assert.match(help, /run\s+Reconcile, then claim and execute ready worker tasks/u);
  assert.match(help, /resume\s+Reconcile interrupted attempts/u);
  assert.match(help, /dispatched, resumed, reconciled, deferred, review-ready,/u);
  assert.match(help, /Exit 0 means nothing failed, 1 means a task was/u);
});

test("reports run and resume option errors with exit code 2", async () => {
  for (const args of [["run", "--bogus"], ["resume", "--by"], ["run", "extra"]]) {
    const capture = captureIo();
    assert.equal(await main(args, capture.io), 2);
    assert.match(capture.errors.join("\n"), /Unknown (run|resume) option|--by requires/u);
  }
});

test("run and resume refuse an unapproved plan with exit code 2", async () => {
  await withCliVariant("unapproved", async (root) => {
    for (const command of ["run", "resume"]) {
      const capture = captureIo();
      assert.equal(await main([command], capture.io, root), 2);
      assert.match(capture.errors.join("\n"), /is draft, not approved/u);
      assert.equal(capture.output.length, 0);
    }
  });
});

test("run and resume refuse an API-backed worker route with exit code 2", async () => {
  await withCliVariant("api-worker", async (root) => {
    for (const command of ["run", "resume"]) {
      const capture = captureIo();
      assert.equal(await main([command], capture.io, root), 2);
      assert.match(capture.errors.join("\n"), /text-only or does not declare workspace access/u);
    }
  });
});

test("run reports deferred work without dispatching a worker", async () => {
  await withCliVariant("deferred", async (root) => {
    const capture = captureIo();
    assert.equal(await main(["run", "--by", "cli-test"], capture.io, root), 0);
    const output = capture.output.join("\n");
    assert.match(output, /^Dispatched: none$/mu);
    assert.match(output, /P04-T01 \[in-flight\]/u);
    assert.match(output, /P04-T02 \[capacity\]/u);
    assert.match(output, /^Next: `draftforge resume`/mu);
  });
});

test("resume finalizes a persisted result without another model call", async () => {
  await withCliVariant("resumable", async (root) => {
    const capture = captureIo();
    assert.equal(await main(["resume"], capture.io, root), 0);
    const output = capture.output.join("\n");
    assert.match(output, /^Reconciled: P04-T01 -> review$/mu);
    assert.match(output, /^Review-ready: P04-T01$/mu);

    const status = captureIo();
    assert.equal(await main(["status"], status.io, root), 0);
    assert.match(status.output.join("\n"), /Resumable sample: phase-04/u);

    // A second resume is stable and reports no work.
    const repeat = captureIo();
    assert.equal(await main(["resume"], repeat.io, root), 0);
    assert.match(repeat.output.join("\n"), /^Reconciled: none$/mu);
    assert.match(repeat.output.join("\n"), /^No work: every candidate task was deferred\.$/mu);
  });
});

test("run reports no work when every task is already accepted or in review", async () => {
  await withCliVariant("no-work", async (root) => {
    const capture = captureIo();
    assert.equal(await main(["run"], capture.io, root), 0);
    const output = capture.output.join("\n");
    assert.match(output, /^Review-ready: P04-T02$/mu);
    assert.match(output, /^No work: nothing was dispatched, resumed, or reconciled\.$/mu);
  });
});

test("reports plan usage errors with exit code 2", async () => {
  const capture = captureIo();
  const exitCode = await main(["plan", "--approve"], capture.io);
  assert.equal(exitCode, 2);
  assert.match(capture.errors.join("\n"), /requires --by/);
});

test("rejects combining the automatic architect turn with the manual prompt path", async () => {
  const capture = captureIo();
  const exitCode = await main(["plan", "--run", "--prompt"], capture.io);
  assert.equal(exitCode, 2);
  assert.match(capture.errors.join("\n"), /cannot be combined/);
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

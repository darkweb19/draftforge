import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { main, type CliIo } from "../src/cli.js";
import { runInit } from "../src/commands/init.js";
import { readProjectState } from "../src/state/files.js";
import { inspectProjectHealth } from "../src/state/health.js";
import { readPlanningArtifact } from "../src/state/planning.js";
import { applyTaskTransition } from "../src/state/transitions.js";

const FIXTURES = resolve(import.meta.dirname, "fixtures/architect");
const REASON = "Reporting must export CSV after user feedback.";

interface Harness {
  readonly root: string;
  readonly lines: string[];
  readonly run: (...args: string[]) => Promise<number>;
}

async function approvedProject(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "draftforge-plan-revision-"));
  await runInit(root, { name: "Tracker" });
  await writeFile(resolve(root, "idea.md"), "# Idea\n\nA local task tracker.\n", "utf8");
  for (const fixture of [
    "questions.json",
    "plan.json",
    "questions-r2.json",
    "plan-r2.json",
    "plan-r2-drops-done.json",
  ]) {
    await copyFile(resolve(FIXTURES, fixture), resolve(root, fixture));
  }

  const lines: string[] = [];
  const io: CliIo = {
    out: (message) => lines.push(message),
    error: (message) => lines.push(`ERROR ${message}`),
  };
  const run = async (...args: string[]): Promise<number> => main(args, io, root);

  assert.equal(await run("plan", "idea.md"), 0);
  assert.equal(await run("plan", "--submit", "questions.json"), 0);
  assert.equal(await run("plan", "--answer", "Q1=Node.js 22"), 0);
  assert.equal(await run("plan", "--submit", "plan.json"), 0);
  assert.equal(await run("plan", "--approve", "--by", "sujan"), 0);
  lines.length = 0;

  return { root, lines, run };
}

/** Take P01-T01 all the way to done through the protocol state machine. */
async function completeFirstTask(root: string): Promise<void> {
  for (const to of ["active", "review", "done"] as const) {
    await applyTaskTransition(root, {
      taskId: "P01-T01",
      to,
      runId: "revision-fixture",
      actor: "worker",
    });
  }
}

test("a recorded revision keeps completed work and re-materializes files", async () => {
  const { root, lines, run } = await approvedProject();
  try {
    await completeFirstTask(root);

    assert.equal(await run("plan", "--revise", "--reason", REASON, "--by", "sujan"), 0);
    assert.match(lines.join("\n"), /Started planning revision 2, superseding 1/);
    const revised = await readPlanningArtifact(root);
    assert.equal(revised.revision, 2);
    assert.equal(revised.status, "interview");
    assert.equal(revised.approval, null);
    assert.equal((await readProjectState(root)).workflow.stage, "planning");

    // The revision reopens the interview and states why.
    lines.length = 0;
    assert.equal(await run("plan", "--prompt"), 0);
    const prompt = lines.join("\n");
    assert.match(prompt, /Requested output: questions/);
    assert.match(prompt, /Revision 2 supersedes 1, requested by sujan/);
    assert.match(prompt, /Answer: Node\.js 22/);

    assert.equal(await run("plan", "--submit", "questions-r2.json"), 0);
    const carried = await readPlanningArtifact(root);
    assert.equal(carried.questions.items[0]?.answer, "Node.js 22", "answers carry forward");
    assert.equal(carried.questions.items[2]?.id, "Q3", "a revision may add questions");

    lines.length = 0;
    assert.equal(await run("plan", "--submit", "plan-r2.json"), 1);
    assert.match(lines.join("\n"), /expects an architect "questions" response/);

    assert.equal(await run("plan", "--answer", "Q3=Yes, CSV and text"), 0);
    assert.equal(await run("plan", "--submit", "plan-r2.json"), 0);

    // Nothing is runnable until the new revision is approved on its own.
    assert.deepEqual(
      (await readProjectState(root)).tasks.filter((task) => task.status === "ready"),
      [],
    );

    lines.length = 0;
    assert.equal(await run("plan", "--approve", "--by", "sujan"), 0);
    assert.match(lines.join("\n"), /Approved planning revision 2\. Ready tasks: P01-T02/);

    const state = await readProjectState(root);
    assert.deepEqual(
      state.tasks.map(({ id, status }) => ({ id, status })),
      [
        { id: "P01-T01", status: "done" },
        { id: "P01-T02", status: "ready" },
        { id: "P02-T02", status: "backlog" },
      ],
    );
    assert.equal(state.workflow.nextTask, "P01-T02");
    assert.match(
      await readFile(resolve(root, ".draftforge/tasks/P01-T01.md"), "utf8"),
      /Status: done/,
    );
    assert.match(
      await readFile(resolve(root, "docs/decisions/0002-csv-export.md"), "utf8"),
      /Render reports as text and CSV/,
    );
    assert.match(
      await readFile(resolve(root, ".draftforge/tasks/P02-T02.md"), "utf8"),
      /Render weekly summaries as text and CSV/,
    );
    assert.ok((await inspectProjectHealth(root)).every((check) => check.status === "pass"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a revision that drops completed work is rejected until it is retired", async () => {
  const { root, lines, run } = await approvedProject();
  try {
    await completeFirstTask(root);

    assert.equal(await run("plan", "--revise", "--reason", REASON, "--by", "sujan"), 0);
    assert.equal(await run("plan", "--submit", "questions-r2.json"), 0);
    assert.equal(await run("plan", "--answer", "Q3=Yes, CSV and text"), 0);
    assert.equal(await run("plan", "--submit", "plan-r2-drops-done.json"), 0);

    lines.length = 0;
    assert.equal(await run("plan", "--approve", "--by", "sujan"), 1);
    assert.match(
      lines.join("\n"),
      /cannot drop started or completed tasks without retiring them: P01-T01 \(done\)/,
    );
    assert.equal((await readPlanningArtifact(root)).status, "draft", "consent is not recorded");
    assert.equal((await readProjectState(root)).tasks[0]?.status, "done");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("re-materialization refuses to overwrite an edited generated file", async () => {
  const { root, lines, run } = await approvedProject();
  const adr = resolve(root, "docs/decisions/0001-node-cli-runtime.md");
  try {
    await writeFile(adr, `${await readFile(adr, "utf8")}\n## Local note\n\nKeep this.\n`, "utf8");

    assert.equal(await run("plan", "--revise", "--reason", REASON, "--by", "sujan"), 0);
    assert.equal(await run("plan", "--submit", "questions-r2.json"), 0);
    assert.equal(await run("plan", "--answer", "Q3=Yes, CSV and text"), 0);
    assert.equal(await run("plan", "--submit", "plan-r2.json"), 0);

    lines.length = 0;
    assert.equal(await run("plan", "--approve", "--by", "sujan"), 1);
    assert.match(
      lines.join("\n"),
      /would overwrite existing project files: docs\/decisions\/0001-node-cli-runtime\.md/,
    );
    assert.match(await readFile(adr, "utf8"), /Keep this\./);
    assert.equal((await readPlanningArtifact(root)).status, "draft");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plan --revise requires a reason and an actor", async () => {
  const { root, lines, run } = await approvedProject();
  try {
    assert.equal(await run("plan", "--revise", "--by", "sujan"), 2);
    assert.match(lines.join("\n"), /requires --reason <text>/);

    lines.length = 0;
    assert.equal(await run("plan", "--revise", "--reason", REASON), 2);
    assert.match(lines.join("\n"), /requires --by <actor>/);

    lines.length = 0;
    assert.equal(await run("plan", "--reason", REASON), 2);
    assert.match(lines.join("\n"), /--reason is only valid with --revise/);

    lines.length = 0;
    assert.equal(
      await run("plan", "--revise", "--reason", REASON, "--by", "sujan", "--reopen", "P09-T09"),
      1,
    );
    assert.match(lines.join("\n"), /Cannot revise an unknown task: P09-T09/);
    assert.equal((await readPlanningArtifact(root)).revision, 1, "a rejected revision changes nothing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

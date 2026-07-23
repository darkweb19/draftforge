import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { main, type CliIo } from "../src/cli.js";
import { runInit } from "../src/commands/init.js";
import { readProjectState } from "../src/state/files.js";
import { readPlanningArtifact } from "../src/state/planning.js";

const FIXTURES = resolve(import.meta.dirname, "fixtures/architect");

async function setupProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "draftforge-architect-loop-"));
  await runInit(root, { name: "Tracker" });
  await writeFile(
    resolve(root, "idea.md"),
    "# Idea\n\nA local task tracker for one person.\n",
    "utf8",
  );
  await copyFile(resolve(FIXTURES, "questions.json"), resolve(root, "questions.json"));
  await copyFile(resolve(FIXTURES, "plan.json"), resolve(root, "plan.json"));
  return root;
}

test("the recorded architect loop runs end to end through the CLI", async () => {
  const root = await setupProject();
  const lines: string[] = [];
  const io: CliIo = {
    out: (message) => lines.push(message),
    error: (message) => lines.push(`ERROR ${message}`),
  };
  const run = async (...args: string[]): Promise<number> => main(args, io, root);

  try {
    assert.equal(await run("plan", "idea.md"), 0);

    lines.length = 0;
    assert.equal(await run("plan", "--prompt"), 0);
    const prompt = lines.join("\n");
    assert.match(prompt, /Requested output: questions/);
    assert.match(prompt, /A local task tracker for one person\./);

    assert.equal(await run("plan", "--submit", "questions.json"), 0);
    assert.equal((await readPlanningArtifact(root)).questions.items.length, 2);

    // The plan stage is closed while a blocking question is open.
    lines.length = 0;
    assert.equal(await run("plan", "--submit", "plan.json"), 1);
    assert.match(lines.join("\n"), /expects an architect "questions" response/);

    assert.equal(await run("plan", "--answer", "Q1=Node.js 22"), 0);
    assert.equal((await readPlanningArtifact(root)).questions.items[0]?.answer, "Node.js 22");

    lines.length = 0;
    assert.equal(await run("plan", "--prompt"), 0);
    assert.match(lines.join("\n"), /Requested output: plan/);

    assert.equal(await run("plan", "--submit", "plan.json"), 0);
    assert.equal((await readPlanningArtifact(root)).status, "draft");

    assert.equal(await run("plan", "--approve", "--by", "sujan"), 0);
    const state = await readProjectState(root);
    assert.equal((await readPlanningArtifact(root)).status, "approved");
    assert.deepEqual(
      state.tasks.filter((task) => task.status === "ready").map((task) => task.id),
      ["P01-T01"],
    );
    assert.match(
      await readFile(resolve(root, ".draftforge/tasks/P01-T02.md"), "utf8"),
      /Status: backlog/,
    );

    // An approved plan is immutable until the P02-T03 revision flow exists.
    lines.length = 0;
    assert.equal(await run("plan", "--submit", "plan.json"), 1);
    assert.match(lines.join("\n"), /recorded plan revision/);

    lines.length = 0;
    assert.equal(await run("plan", "--prompt"), 1);
    assert.match(lines.join("\n"), /recorded plan revision/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("planning answer and submit inputs are validated", async () => {
  const root = await setupProject();
  const lines: string[] = [];
  const io: CliIo = {
    out: (message) => lines.push(message),
    error: (message) => lines.push(`ERROR ${message}`),
  };
  const run = async (...args: string[]): Promise<number> => main(args, io, root);

  try {
    assert.equal(await run("plan", "idea.md"), 0);
    assert.equal(await run("plan", "--submit", "questions.json"), 0);

    lines.length = 0;
    assert.equal(await run("plan", "--answer", "Q9=whatever"), 1);
    assert.match(lines.join("\n"), /Unknown planning question: Q9/);

    lines.length = 0;
    assert.equal(await run("plan", "--answer", "Q1"), 2);
    assert.match(lines.join("\n"), /--answer requires <id>=<text>/);

    lines.length = 0;
    assert.equal(await run("plan", "--submit", "missing.json"), 1);
    assert.match(lines.join("\n"), /Architect response file does not exist: missing\.json/);

    lines.length = 0;
    assert.equal(await run("plan", "--status", "--prompt"), 2);
    assert.match(lines.join("\n"), /cannot be combined/);

    lines.length = 0;
    assert.equal(await run("plan", "--by", "sujan"), 2);
    assert.match(lines.join("\n"), /--by is only valid with --approve/);

    await writeFile(resolve(root, "garbage.json"), "not json at all\n", "utf8");
    lines.length = 0;
    assert.equal(await run("plan", "--submit", "garbage.json"), 1);
    assert.match(lines.join("\n"), /not valid JSON/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

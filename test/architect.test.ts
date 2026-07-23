import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  applyArchitectResponse,
  parseArchitectResponse,
  runArchitectTurn,
} from "../src/application/architect.js";
import {
  architectStage,
  buildArchitectPrompt,
} from "../src/application/architect-prompt.js";
import {
  createPlanningArtifact,
  recordQuestionAnswers,
  submitQuestionBatch,
} from "../src/application/planning.js";
import type { ModelRequest, ModelRunner } from "../src/application/ports.js";
import type { PlanningArtifact } from "../src/domain/planning.js";

const FIXTURES = resolve(import.meta.dirname, "fixtures/architect");
const SOURCE_TEXT = "# Idea\n\nA local task tracker for one person.\n";

async function fixtureText(name: string): Promise<string> {
  return await readFile(resolve(FIXTURES, `${name}.json`), "utf8");
}

function promptInput(artifact: PlanningArtifact): {
  readonly artifact: PlanningArtifact;
  readonly projectName: string;
  readonly sourceText: string;
} {
  return { artifact, projectName: "Tracker", sourceText: SOURCE_TEXT };
}

function stubRunner(text: string): ModelRunner & { readonly requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    run: async (request: ModelRequest) => {
      requests.push(request);
      return { text };
    },
  };
}

test("architect stage follows planning state", async () => {
  const fresh = createPlanningArtifact("idea.md");
  assert.equal(architectStage(fresh), "questions");

  const asked = applyArchitectResponse(
    fresh,
    parseArchitectResponse(await fixtureText("questions")),
  );
  assert.equal(architectStage(asked), "questions");

  const answered = recordQuestionAnswers(asked, { Q1: "Node.js" });
  assert.equal(architectStage(answered), "plan");
});

test("architect prompt is deterministic and carries answered context", async () => {
  const artifact = recordQuestionAnswers(
    applyArchitectResponse(
      createPlanningArtifact("idea.md"),
      parseArchitectResponse(await fixtureText("questions")),
    ),
    { Q1: "Node.js" },
  );

  const first = buildArchitectPrompt(promptInput(artifact));
  const second = buildArchitectPrompt(promptInput(artifact));
  assert.deepEqual(first, second);
  assert.equal(first.role, "architect");
  assert.match(first.system, /ONE batch/);
  assert.match(first.user, /Requested output: plan/);
  assert.match(first.user, /Q1: Which runtime should the tracker target\?/);
  assert.match(first.user, /Answer: Node\.js/);
  assert.match(first.user, /A local task tracker for one person\./);
});

test("architect prompt refuses an empty source and an open blocking question", async () => {
  const fresh = createPlanningArtifact("idea.md");
  assert.throws(
    () => buildArchitectPrompt({ artifact: fresh, projectName: "Tracker", sourceText: "   " }),
    /Planning source idea\.md is empty/,
  );

  const asked = applyArchitectResponse(
    fresh,
    parseArchitectResponse(await fixtureText("questions")),
  );
  assert.throws(() => buildArchitectPrompt(promptInput(asked)), /answer Q1 before prompting/);
});

test("response parsing accepts a fenced block and rejects malformed output", async () => {
  const raw = await fixtureText("questions");
  const fenced = parseArchitectResponse(`\`\`\`json\n${raw.trim()}\n\`\`\``);
  assert.equal(fenced.kind, "questions");
  assert.deepEqual(fenced, parseArchitectResponse(raw));

  assert.throws(() => parseArchitectResponse("   "), /empty/);
  assert.throws(() => parseArchitectResponse("Sure! Here is the plan."), /not valid JSON/);
  assert.throws(() => parseArchitectResponse('{"kind":"notes"}'), /kind must be one of/);
  assert.throws(
    () => parseArchitectResponse('{"kind":"questions","questions":{"revision":1,"items":[]}}'),
    /at least one question/,
  );
  assert.throws(
    () => parseArchitectResponse('{"kind":"plan","plan":null,"note":"x"}'),
    /unsupported property: note/,
  );
});

test("an off-stage response is rejected instead of partially applied", async () => {
  const fresh = createPlanningArtifact("idea.md");
  const planResponse = parseArchitectResponse(await fixtureText("plan"));
  assert.throws(
    () => applyArchitectResponse(fresh, planResponse),
    /expects an architect "questions" response, not "plan"/,
  );
  assert.equal(fresh.plan, null);
});

test("a cyclic plan is rejected by the shared planning contract", async () => {
  const raw = JSON.parse(await fixtureText("plan")) as {
    plan: { tasks: { id: string; dependsOn: string[] }[] };
  };
  raw.plan.tasks[0]!.dependsOn = ["P02-T01"];
  assert.throws(() => parseArchitectResponse(JSON.stringify(raw)), /contains a cycle/);
});

test("runArchitectTurn drives the planning contracts through the model port", async () => {
  const fresh = createPlanningArtifact("idea.md");
  const runner = stubRunner(await fixtureText("questions"));
  const asked = await runArchitectTurn(promptInput(fresh), runner);

  assert.equal(runner.requests[0]?.role, "architect");
  assert.equal(asked.questions.items.length, 2);
  assert.equal(asked.status, "interview");

  const answered = recordQuestionAnswers(asked, { Q1: "Node.js" });
  const planned = await runArchitectTurn(
    promptInput(answered),
    stubRunner(await fixtureText("plan")),
  );
  assert.equal(planned.status, "draft");
  assert.equal(planned.plan?.tasks.length, 3);
  assert.equal(planned.approval, null);
});

test("a second question batch cannot overwrite the first", async () => {
  const asked = applyArchitectResponse(
    createPlanningArtifact("idea.md"),
    parseArchitectResponse(await fixtureText("questions")),
  );
  assert.throws(
    () => submitQuestionBatch(asked, asked.questions),
    /already has a question batch/,
  );
});

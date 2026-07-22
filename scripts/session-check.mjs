import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const state = JSON.parse(await readFile(resolve(root, ".draftforge/state.json"), "utf8"));
const session = await readFile(resolve(root, "SESSION.md"), "utf8");

const expected = [
  `# Session handoff — ${state.handoff.updatedAt.slice(0, 10)}`,
  "## What was done",
  "## Decisions locked",
  "## Open questions",
  "## Next steps",
  "## Gotchas",
  `- Current position: ${state.workflow.phaseId} — ${state.workflow.phaseName}; stage ${state.workflow.stage}; status ${state.workflow.status}.`,
  `- Current task: ${state.workflow.currentTask ?? "None"}. Next task: ${state.workflow.nextTask ?? "None"}.`,
  `Last updated: ${state.handoff.updatedAt} by ${state.handoff.updatedBy}`,
];

const missing = expected.filter((line) => !session.includes(line));

if (missing.length > 0) {
  console.error("SESSION.md is stale or inconsistent:");
  for (const line of missing) console.error(`- Missing: ${line}`);
  process.exitCode = 1;
} else {
  console.log("SESSION.md agrees with canonical state.");
}

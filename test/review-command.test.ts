import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import type { ModelRequest, ModelRunner } from "../src/application/ports.js";
import type { ReviewWorkspacePort } from "../src/application/integration.js";
import type { WorkspacePort } from "../src/application/workspace.js";
import { reviewProject } from "../src/commands/review.js";
import { defaultProjectConfig } from "../src/config/config.js";
import { createExecutionAttemptManifest, hashTaskContract, writeAttemptResult, writeExecutionAttemptManifest } from "../src/state/execution.js";
import { readProjectState } from "../src/state/files.js";
import { taskContract } from "./fixtures/execution/project.js";
import type { ProcessRequest, ProcessResult, ProcessTransport } from "../src/providers/harness/process.js";

const NOW = () => new Date("2026-07-31T12:00:00.000Z");

test("review persists machine evidence and integrates only after an accept verdict", async (t) => {
  const root = await fixture(t);
  const runner = new Reviewer(JSON.stringify({ verdict: "accept", findings: [], summary: "Looks good." }));
  const workspace = new Workspace(root);
  const summary = await reviewProject(root, deps(runner, workspace));
  assert.deepEqual(summary.integrated, ["P05-T05"]);
  assert.equal(runner.calls, 1);
  assert.equal(workspace.integrations, 1);
  const state = await readProjectState(root);
  assert.equal(state.tasks[0]?.status, "done");
});

test("scope violations block before a reviewer or merge can accept them", async (t) => {
  const root = await fixture(t);
  const runner = new Reviewer(JSON.stringify({ verdict: "accept", findings: [], summary: "Looks good." }));
  const workspace = new Workspace(root, { changedPaths: ["outside.ts"] });
  const summary = await reviewProject(root, deps(runner, workspace));
  assert.deepEqual(summary.blocked, ["P05-T05"]);
  assert.equal(runner.calls, 0, "terminal machine evidence must not reach the reviewer");
  assert.equal(workspace.integrations, 0);
  const state = await readProjectState(root);
  assert.equal(state.tasks[0]?.review?.lastClassification, "scope-violation");
});

test("a failing allowlisted verification repairs without exposing failed evidence to a reviewer", async (t) => {
  const root = await fixture(t);
  const workspace = new Workspace(root);
  const runner = new ScriptedRunner([]);
  const summary = await reviewProject(root, deps(runner, workspace, new FixedTransport(1)));
  assert.deepEqual(summary.repairing, ["P05-T05"]);
  assert.equal(runner.workerPrompts.length, 1);
  assert.equal(workspace.integrations, 0);
  assert.equal((await readProjectState(root)).tasks[0]?.review?.lastClassification, "verification-failure");
});

test("a planted synthetic secret blocks with locator-only retained evidence", async (t) => {
  const root = await fixture(t);
  const synthetic = `AKIA${"7".repeat(16)}`;
  const workspace = new Workspace(root, {
    patch: `diff --git a/src/owned.ts b/src/owned.ts\n--- a/src/owned.ts\n+++ b/src/owned.ts\n@@ -0,0 +1 @@\n+const credential = "${synthetic}";\n`,
  });
  const runner = new Reviewer(JSON.stringify({ verdict: "accept", findings: [], summary: "Looks good." }));
  const summary = await reviewProject(root, deps(runner, workspace));
  assert.deepEqual(summary.blocked, ["P05-T05"]);
  assert.equal(runner.calls, 0, "secret-bearing patch must never be placed in a reviewer prompt");
  assert.equal((await readProjectState(root)).tasks[0]?.review?.lastClassification, "secret-detected");
  const evidence = await readTree(root, ".draftforge/runs");
  assert.equal(evidence.includes(synthetic), false);
  assert.equal(evidence.includes(synthetic.slice(4, 12)), false);
});

test("a malformed reviewer envelope blocks and is never merged", async (t) => {
  const root = await fixture(t);
  const workspace = new Workspace(root);
  const runner = new Reviewer('{"verdict":"accept"} trailing');
  const summary = await reviewProject(root, deps(runner, workspace));
  assert.deepEqual(summary.blocked, ["P05-T05"]);
  assert.equal(workspace.integrations, 0);
  assert.equal((await readProjectState(root)).tasks[0]?.review?.lastClassification, "contract-violation");
});

test("review evidence redacts short configured secrets echoed by the reviewer", async (t) => {
  const root = await fixture(t);
  const configuredSecret = "short-private-value";
  const workspace = new Workspace(root);
  const runner = new Reviewer(
    JSON.stringify({ verdict: "block", findings: [], summary: configuredSecret }),
  );

  await reviewProject(root, {
    ...deps(runner, workspace),
    env: { REVIEW_SECRET: configuredSecret },
  });

  assert.equal((await readTree(root, ".draftforge/runs")).includes(configuredSecret), false);
});

test("a reviewer rejection repairs against the retained worktree and can subsequently integrate", async (t) => {
  const root = await fixture(t);
  const workspace = new Workspace(root);
  const runner = new ScriptedRunner([
    JSON.stringify({ verdict: "reject", findings: [{ path: "src/owned.ts", summary: "Finish the edge case." }], summary: "Incomplete." }),
    JSON.stringify({ verdict: "accept", findings: [], summary: "Fixed." }),
  ]);
  const first = await reviewProject(root, deps(runner, workspace));
  assert.deepEqual(first.repairing, ["P05-T05"]);
  const repaired = await readProjectState(root);
  assert.equal(repaired.tasks[0]?.status, "review");
  assert.equal(repaired.tasks[0]?.review?.repairAttempts, 1);
  assert.match(runner.workerPrompts[0] ?? "", /# Repair findings/u);
  assert.match(runner.workerPrompts[0] ?? "", /Finish the edge case\./u);
  const second = await reviewProject(root, deps(runner, workspace));
  assert.deepEqual(second.integrated, ["P05-T05"]);
  assert.equal((await readProjectState(root)).tasks[0]?.status, "done");
});

test("rejections stop at the durable repair bound instead of dispatching a third repair", async (t) => {
  const root = await fixture(t);
  const workspace = new Workspace(root);
  const rejection = JSON.stringify({ verdict: "reject", findings: [{ path: "src/owned.ts", summary: "Still incomplete." }], summary: "Incomplete." });
  const runner = new ScriptedRunner([rejection, rejection, rejection]);
  await reviewProject(root, deps(runner, workspace));
  await reviewProject(root, deps(runner, workspace));
  const final = await reviewProject(root, deps(runner, workspace));
  assert.deepEqual(final.blocked, ["P05-T05"]);
  assert.equal((await readProjectState(root)).tasks[0]?.review?.repairAttempts, 2);
  assert.equal(runner.workerPrompts.length, 2);
});

test("an integration conflict blocks without claiming completion", async (t) => {
  const root = await fixture(t);
  const workspace = new Workspace(root, { integration: "conflict" });
  const runner = new Reviewer(JSON.stringify({ verdict: "accept", findings: [], summary: "Looks good." }));
  const summary = await reviewProject(root, deps(runner, workspace));
  assert.deepEqual(summary.accepted, ["P05-T05"]);
  assert.deepEqual(summary.blocked, ["P05-T05"]);
  assert.equal((await readProjectState(root)).tasks[0]?.status, "blocked");
  assert.equal((await readProjectState(root)).tasks[0]?.review?.lastClassification, "integration-conflict");
});

test("REGRESSION: review reconciles a persisted worker result before filtering review tasks", async (t) => {
  const root = await fixture(t, { status: "active", lifecycle: "running", persistedResult: true });
  const workspace = new Workspace(root);
  const runner = new Reviewer(JSON.stringify({ verdict: "accept", findings: [], summary: "Looks good." }));
  const summary = await reviewProject(root, deps(runner, workspace));
  assert.deepEqual(summary.integrated, ["P05-T05"]);
  assert.equal((await readProjectState(root)).tasks[0]?.status, "done");
});

test("concurrent review invocations use the durable lease and call the reviewer once", async (t) => {
  const root = await fixture(t);
  const workspace = new Workspace(root);
  const runner = new DelayedReviewer(JSON.stringify({ verdict: "accept", findings: [], summary: "Looks good." }));
  const first = reviewProject(root, deps(runner, workspace));
  await runner.started;
  const second = await reviewProject(root, deps(runner, workspace));
  assert.equal(second.records[0]?.disposition, "deferred");
  runner.release();
  await first;
  assert.equal(runner.calls, 1);
  assert.equal(workspace.integrations, 1);
});

async function fixture(t: TestContext, options: { readonly status?: "review" | "active"; readonly lifecycle?: "review" | "running"; readonly persistedResult?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "draftforge-review-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const attempt = { runId: "review-run", attemptId: "attempt-1" };
  const spec = { name: "Review", approved: true, workerAdapter: "codex-cli" as const, maxConcurrency: 1, tasks: [{ id: "P05-T05", title: "Review", status: options.status ?? "review", ownedPaths: ["src/owned.ts"], attempt }] };
  const { materializeProject } = await import("./fixtures/execution/project.js");
  await materializeProject(root, spec);
  await mkdir(resolve(root, "worktree"), { recursive: true });
  await writeFile(resolve(root, "worktree", "AGENTS.md"), "# test rules\n");
  const contract = taskContract(spec.tasks[0]!).replace("- npm test", "- `npm run check`");
  await writeFile(resolve(root, ".draftforge/tasks/P05-T05.md"), contract);
  const manifest = createExecutionAttemptManifest({ reference: attempt, taskId: "P05-T05", contractHash: hashTaskContract(contract), now: NOW(), budget: { timeMinutes: 5 } });
  await writeExecutionAttemptManifest(root, { ...manifest, lifecycle: options.lifecycle ?? "review", baseCommit: "b".repeat(40) });
  if (options.persistedResult === true) {
    await writeAttemptResult(root, attempt, { schemaVersion: 1, taskId: "P05-T05", attemptId: attempt.attemptId, outcome: "review", reason: "completed", result: null, authoritativeChangedPaths: ["src/owned.ts"], scopeViolations: [], failure: null, termination: null }, {});
  }
  return root;
}

function deps(runner: ModelRunner, workspace: ReviewWorkspacePort & WorkspacePort, transport: ProcessTransport = new PassingTransport()) {
  return { config: defaultProjectConfig(), runner, workspace, transport, actor: "test", now: NOW, env: {} };
}

class Reviewer implements ModelRunner {
  calls = 0;
  constructor(readonly text: string) {}
  async run(_request: ModelRequest) { this.calls += 1; return { text: this.text }; }
}

class DelayedReviewer extends Reviewer {
  #resolveStarted: (() => void) | undefined;
  #resolveRelease: (() => void) | undefined;
  readonly started = new Promise<void>((resolveStarted) => { this.#resolveStarted = resolveStarted; });
  readonly #released = new Promise<void>((resolveRelease) => { this.#resolveRelease = resolveRelease; });
  release(): void { this.#resolveRelease?.(); }
  override async run(request: ModelRequest) { this.#resolveStarted?.(); await this.#released; return super.run(request); }
}

class ScriptedRunner implements ModelRunner {
  readonly workerPrompts: string[] = [];
  #reviewerIndex = 0;
  constructor(private readonly reviewerResponses: readonly string[]) {}
  capabilities(): { readonly workspaceAccess: true } { return { workspaceAccess: true }; }
  async run(request: ModelRequest) {
    if (request.role === "worker") {
      this.workerPrompts.push(request.user);
      const taskId = /^- Task ID: (.+)$/mu.exec(request.user)?.[1];
      const attemptId = /^- Attempt ID: (.+)$/mu.exec(request.user)?.[1];
      return { text: JSON.stringify({ taskId, attemptId, status: "completed", summary: "Repaired.", changedPaths: ["src/owned.ts"], commandsRun: [], evidence: [], risks: [], suggestedFollowUps: [] }) };
    }
    return { text: this.reviewerResponses[this.#reviewerIndex++] ?? "" };
  }
}

class PassingTransport implements ProcessTransport {
  async run(_request: ProcessRequest): Promise<ProcessResult> { return { stdout: "ok", stderr: "", exitCode: 0, signal: null, processId: 1, definitelyTerminated: true }; }
}

class FixedTransport implements ProcessTransport {
  constructor(private readonly exitCode: number) {}
  async run(_request: ProcessRequest): Promise<ProcessResult> { return { stdout: "check output", stderr: "", exitCode: this.exitCode, signal: null, processId: 1, definitelyTerminated: true }; }
}

class Workspace implements ReviewWorkspacePort, WorkspacePort {
  integrations = 0;
  constructor(private readonly root: string, private readonly options: { readonly changedPaths?: readonly string[]; readonly patch?: string; readonly integration?: "integrated" | "conflict" } = {}) {}
  get worktree(): string { return resolve(this.root, "worktree"); }
  async reviewSnapshot(attempt: { runId: string; taskId: string; attemptId: string }) { return { location: { attempt, path: this.worktree, branch: "branch", baseCommit: "b".repeat(40) }, changedPaths: this.options.changedPaths ?? ["src/owned.ts"], patch: this.options.patch ?? "diff --git a/src/owned.ts b/src/owned.ts\n--- a/src/owned.ts\n+++ b/src/owned.ts\n@@ -0,0 +1 @@\n+ok\n", untracked: [] }; }
  async prepareRepair(_previous: { runId: string; taskId: string; attemptId: string }, next: { runId: string; taskId: string; attemptId: string }) { return { attempt: next, path: this.worktree, branch: "repair-branch", baseCommit: "b".repeat(40) }; }
  async prepareIntegration() {
    if (this.options.integration === "conflict") return { status: "conflict" as const, projectBranch: "main", rollbackCommit: "a".repeat(40), detail: "synthetic merge conflict" };
    return { status: "prepared" as const, intent: { projectBranch: "main", rollbackCommit: "a".repeat(40), branchTip: "b".repeat(40), taskId: "P05-T05" } };
  }
  async mergePreparedIntegration() { return this.integrateAccepted(); }
  async createOrRecover(attempt: { runId: string; taskId: string; attemptId: string }) { return { attempt, path: this.worktree, branch: "repair-branch", baseCommit: "b".repeat(40) }; }
  async changedPaths(): Promise<readonly string[]> { return this.options.changedPaths ?? ["src/owned.ts"]; }
  async inspect() { return { state: "ready" as const, location: undefined, dirty: false, changedPaths: [], reason: undefined }; }
  async processLiveness() { return "not-found" as const; }
  async cleanup() { return { outcome: "preserved" as const, reason: "test" }; }
  async integrateAccepted() {
    this.integrations += 1;
    if (this.options.integration === "conflict") return { status: "conflict" as const, projectBranch: "main", rollbackCommit: "a".repeat(40), detail: "synthetic merge conflict" };
    return { status: "integrated" as const, projectBranch: "main", rollbackCommit: "a".repeat(40), integrationCommit: "c".repeat(40) };
  }
}

async function readTree(root: string, relative: string): Promise<string> {
  const directory = resolve(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const contents = await Promise.all(entries.map(async (entry) => entry.isDirectory() ? readTree(root, `${relative}/${entry.name}`) : readFile(resolve(directory, entry.name), "utf8")));
  return contents.join("\n");
}

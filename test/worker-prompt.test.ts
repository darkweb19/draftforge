import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildWorkerPrompt } from "../src/application/worker-prompt.js";
import type { TaskContract } from "../src/application/task-contract.js";
import type { WorkspaceLocation } from "../src/application/workspace.js";
import { createExecutionAttemptManifest } from "../src/state/execution.js";

const contract: TaskContract = {
  id: "P04-T03",
  title: "Bounded worker",
  objective: "Implement the bounded worker.",
  ownedPaths: ["src/worker.ts"],
  requiredContext: ["docs/context.md"],
  relevantAdrs: ["docs/decisions/0001-test.md"],
  dependsOn: ["P04-T02"],
  acceptanceCriteria: ["Only approved context is present."],
  verification: ["npm test"],
  exclusions: ["No unrelated files."],
  budget: { timeMinutes: 7, tokenLimit: 1000, costLimitUsd: 1.5 },
};

test("worker prompt includes only approved bounded context and explicit workspace budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "draftforge-worker-prompt-"));
  try {
    await mkdir(join(root, "docs", "decisions"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "RULES-ONLY-731", "utf8");
    await writeFile(join(root, "docs", "context.md"), "CONTEXT-ONLY-912", "utf8");
    await writeFile(join(root, "docs", "decisions", "0001-test.md"), "ADR-ONLY-448", "utf8");
    await writeFile(join(root, "unrelated-secret.txt"), "MUST-NOT-APPEAR-593", "utf8");
    const manifest = createExecutionAttemptManifest({
      reference: { runId: "run-01", attemptId: "attempt-01" },
      taskId: contract.id,
      contractHash: "a".repeat(64),
      now: new Date("2026-07-26T00:00:00.000Z"),
      budget: { timeMinutes: 7, tokenLimit: 1000, costLimitUsd: 1.5 },
    });
    const workspace = location(root);

    const request = await buildWorkerPrompt({
      worktreeRoot: root,
      contract,
      manifest,
      workspace,
    });

    assert.equal(request.role, "worker");
    assert.equal(request.workingDirectory, root);
    assert.equal(request.retryPolicy, "none");
    assert.equal(request.timeoutMs, 7 * 60_000);
    assert.match(request.user, /RULES-ONLY-731/u);
    assert.match(request.user, /CONTEXT-ONLY-912/u);
    assert.match(request.user, /ADR-ONLY-448/u);
    assert.match(request.user, /P04-T03/u);
    assert.match(request.user, /attempt-01/u);
    assert.match(request.user, /npm test/u);
    assert.doesNotMatch(request.user, /MUST-NOT-APPEAR-593/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worker prompt rejects lexical escapes and symlinks whose real path leaves the worktree", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "draftforge-worker-boundary-"));
  const root = join(parent, "worktree");
  try {
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "rules", "utf8");
    const outside = join(parent, "outside.md");
    await writeFile(outside, "outside", "utf8");
    const manifest = createExecutionAttemptManifest({
      reference: { runId: "run-01", attemptId: "attempt-01" },
      taskId: contract.id,
      contractHash: "b".repeat(64),
      now: new Date("2026-07-26T00:00:00.000Z"),
      budget: { timeMinutes: 5 },
    });
    const base = {
      worktreeRoot: root,
      manifest,
      workspace: location(root),
    };

    await t.test("lexical escape", async () => {
      await assert.rejects(
        buildWorkerPrompt({
          ...base,
          contract: { ...contract, requiredContext: ["../outside.md"], relevantAdrs: [] },
        }),
        /project-relative/u,
      );
    });

    await t.test("symlink whose real path leaves the worktree", async (t) => {
      if (!(await symlinkCreationIsPermitted())) {
        // Unprivileged symlink creation on Windows needs Developer Mode or an
        // elevated process; the lexical half above still runs everywhere.
        t.skip(
          "creating a symlink requires Windows Developer Mode or an administrator process",
        );
        return;
      }
      await symlink(outside, join(root, "docs", "escape.md"));
      await assert.rejects(
        buildWorkerPrompt({
          ...base,
          contract: { ...contract, requiredContext: ["docs/escape.md"], relevantAdrs: [] },
        }),
        /escapes the worktree/u,
      );
    });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

/** Probes the real capability instead of inferring it from the platform. */
async function symlinkCreationIsPermitted(): Promise<boolean> {
  const probe = await mkdtemp(join(tmpdir(), "draftforge-symlink-probe-"));
  try {
    await writeFile(join(probe, "target"), "target", "utf8");
    await symlink(join(probe, "target"), join(probe, "link"));
    return true;
  } catch {
    return false;
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}

function location(root: string): WorkspaceLocation {
  return {
    attempt: { runId: "run-01", taskId: contract.id, attemptId: "attempt-01" },
    path: root,
    branch: "draftforge/run-01/p04-t03/attempt-01",
    baseCommit: "c".repeat(40),
  };
}

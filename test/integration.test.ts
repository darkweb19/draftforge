import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitWorkspace } from "../src/workspaces/git.js";
import type { ReviewWorkspacePort } from "../src/application/integration.js";

test("review integration port keeps merge authority separate from a worker workspace", () => {
  const methods: readonly (keyof ReviewWorkspacePort)[] = ["reviewSnapshot", "prepareRepair", "prepareIntegration", "mergePreparedIntegration"];
  assert.deepEqual(methods, ["reviewSnapshot", "prepareRepair", "prepareIntegration", "mergePreparedIntegration"]);
});

test("a successor worktree starts from a project head containing its integrated predecessor", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "draftforge-integration-dependency-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.name", "DraftForge test"]);
  git(root, ["config", "user.email", "draftforge-test@example.invalid"]);
  await writeFile(join(root, "README.md"), "base\n", "utf8");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "base"]);

  const workspace = new GitWorkspace({ projectRoot: root });
  const predecessor = await workspace.createOrRecover({ runId: "run-dependency", taskId: "P05-T01", attemptId: "predecessor" });
  await writeFile(join(predecessor.path, "predecessor.txt"), "integrated predecessor\n", "utf8");
  git(predecessor.path, ["add", "predecessor.txt"]);
  git(predecessor.path, ["commit", "-m", "predecessor work"]);
  git(root, ["merge", "--no-ff", "--no-edit", predecessor.branch]);

  const successor = await workspace.createOrRecover({ runId: "run-dependency", taskId: "P05-T02", attemptId: "successor" });
  assert.equal(await readFile(join(successor.path, "predecessor.txt"), "utf8"), "integrated predecessor\n");
  assert.equal(git(successor.path, ["merge-base", "--is-ancestor", predecessor.branch, "HEAD"]), "");
});

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

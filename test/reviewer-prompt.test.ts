import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReviewerPrompt } from "../src/application/reviewer-prompt.js";
import type { TaskContract } from "../src/application/task-contract.js";
import type { AttemptScan, AttemptVerification } from "../src/domain/execution.js";

const contract: TaskContract = {
  id: "P05-T03",
  title: "Reviewer prompt",
  objective: "OBJECTIVE-MARKER-118",
  ownedPaths: ["src/application/reviewer.ts"],
  requiredContext: [],
  relevantAdrs: [],
  dependsOn: [],
  acceptanceCriteria: ["ACCEPTANCE-MARKER-229"],
  verification: ["npm test"],
  exclusions: ["EXCLUSION-MARKER-337"],
};

function verification(overrides: Partial<AttemptVerification> = {}): AttemptVerification {
  return {
    status: "passed",
    classification: null,
    commands: [
      {
        command: "npm test",
        exitCode: 0,
        durationMs: 5,
        timedOut: false,
        terminated: true,
        transcriptPath: "runs/x/transcript.txt",
      },
    ],
    completedAt: "2026-07-29T00:00:00.000Z",
    ...overrides,
  };
}

function scan(overrides: Partial<AttemptScan> = {}): AttemptScan {
  return {
    status: "clean",
    findings: [],
    scannedAt: "2026-07-29T00:00:00.000Z",
    ...overrides,
  };
}

function baseInput(overrides: Partial<Parameters<typeof buildReviewerPrompt>[0]> = {}) {
  return {
    contract,
    taskId: contract.id,
    changedPaths: ["src/application/reviewer.ts"],
    patch: "diff --git a/src/application/reviewer.ts b/src/application/reviewer.ts\n",
    verification: verification(),
    scan: scan(),
    scopeViolations: [],
    ...overrides,
  };
}

test("reviewer prompt is role reviewer, text-only, and permits transparent retry", () => {
  const request = buildReviewerPrompt(baseInput());
  assert.equal(request.role, "reviewer");
  assert.equal(request.workingDirectory, undefined);
  assert.notEqual(request.retryPolicy, "none");
});

test("reviewer prompt includes task id, objective, owned paths, acceptance criteria, exclusions, and changed paths", () => {
  const request = buildReviewerPrompt(baseInput());
  assert.match(request.user, /P05-T03/u);
  assert.match(request.user, /OBJECTIVE-MARKER-118/u);
  assert.match(request.user, /src\/application\/reviewer\.ts/u);
  assert.match(request.user, /ACCEPTANCE-MARKER-229/u);
  assert.match(request.user, /EXCLUSION-MARKER-337/u);
});

test("reviewer prompt includes the diff and per-command exit status", () => {
  const request = buildReviewerPrompt(
    baseInput({ patch: "diff --git a/x b/x\n+DIFF-MARKER-552\n" }),
  );
  assert.match(request.user, /DIFF-MARKER-552/u);
  assert.match(request.user, /npm test: exitCode=0/u);
});

test("reviewer prompt includes verification status/classification and the scope-violation list", () => {
  const request = buildReviewerPrompt(
    baseInput({
      verification: verification({ status: "failed", classification: "verification-failure" }),
      scopeViolations: ["src/outside.ts"],
    }),
  );
  assert.match(request.user, /Status: failed/u);
  assert.match(request.user, /Classification: verification-failure/u);
  assert.match(request.user, /src\/outside\.ts/u);
});

test("reviewer prompt renders secret-scan findings as locators only, never the matched value", () => {
  const request = buildReviewerPrompt(
    baseInput({
      scan: scan({
        status: "detected",
        findings: [{ ruleId: "aws-secret-key", path: "src/leak.ts", line: 4 }],
      }),
    }),
  );
  assert.match(request.user, /aws-secret-key at src\/leak\.ts:4/u);
  assert.match(request.user, /Status: detected/u);
});

test("reviewer prompt states a failed machine check cannot be accepted", () => {
  const request = buildReviewerPrompt(baseInput());
  assert.match(request.user, /failed machine check cannot be accepted/u);
});

test("reviewer prompt requires exactly one JSON envelope and nothing else", () => {
  const request = buildReviewerPrompt(baseInput());
  assert.match(request.user, /exactly one JSON (envelope|object)/u);
});

test("reviewer prompt states the envelope shape and reject/accept finding requirements", () => {
  const request = buildReviewerPrompt(baseInput());
  assert.match(request.user, /"verdict"/u);
  assert.match(request.user, /"findings"/u);
  assert.match(request.user, /"reject" verdict must carry at least one finding/u);
  assert.match(request.user, /"accept" verdict must carry no findings/u);
});

test("reviewer prompt states finding paths must be repository-relative", () => {
  const request = buildReviewerPrompt(baseInput());
  assert.match(request.user, /repository-relative/u);
});

test("reviewer prompt truncates an oversized diff with an explicit marker", () => {
  const bigPatch = "+".repeat(200);
  const request = buildReviewerPrompt(baseInput({ patch: bigPatch, maxPatchBytes: 50 }));
  assert.match(request.user, /diff truncated/u);
  assert.equal(request.user.includes("+".repeat(200)), false);
});

test("reviewer prompt does not truncate a diff within the bound", () => {
  const request = buildReviewerPrompt(baseInput({ patch: "small diff", maxPatchBytes: 50 }));
  assert.doesNotMatch(request.user, /diff truncated/u);
});

test("reviewer prompt excludes a planted secret value from machine evidence", () => {
  const request = buildReviewerPrompt(
    baseInput({
      scan: scan({
        status: "detected",
        findings: [{ ruleId: "generic-secret", path: "src/leak.ts", line: 1 }],
      }),
    }),
  );
  assert.doesNotMatch(request.user, /SECRET-VALUE-MUST-NOT-APPEAR-914/u);
});

test("reviewer prompt excludes an unrelated task id even when it appears in dependsOn/context fields", () => {
  const contractWithUnrelatedTask: TaskContract = {
    ...contract,
    dependsOn: ["P99-T99"],
    requiredContext: [".draftforge/tasks/P99-T99.md"],
    relevantAdrs: ["docs/decisions/9999-unrelated.md"],
  };
  const request = buildReviewerPrompt(baseInput({ contract: contractWithUnrelatedTask }));
  assert.doesNotMatch(request.user, /P99-T99/u);
});

test("reviewer prompt rejects a mismatched taskId and contract", () => {
  assert.throws(() => buildReviewerPrompt(baseInput({ taskId: "P00-T00" })));
});

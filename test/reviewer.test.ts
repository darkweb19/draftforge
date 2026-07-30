import assert from "node:assert/strict";
import { test } from "node:test";
import { assertReviewerVerdictEnvelope, type ReviewerVerdictEnvelope } from "../src/domain/reviewer.js";
import {
  buildAttemptVerdict,
  classifyMachineFailure,
  decideReviewOutcome,
  machineResultPasses,
  parseReviewerVerdict,
  type MachineEvidence,
} from "../src/application/reviewer.js";
import type { AttemptScan, AttemptVerification } from "../src/domain/execution.js";

function verification(
  overrides: Partial<AttemptVerification> = {},
): AttemptVerification {
  return {
    status: "passed",
    classification: null,
    commands: [
      {
        command: "npm test",
        exitCode: 0,
        durationMs: 10,
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

function evidence(overrides: Partial<MachineEvidence> = {}): MachineEvidence {
  return {
    verification: verification(),
    scan: scan(),
    scopeViolations: [],
    ...overrides,
  };
}

function envelope(overrides: Partial<ReviewerVerdictEnvelope> = {}): ReviewerVerdictEnvelope {
  return {
    verdict: "accept",
    findings: [],
    summary: "Looks good.",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Domain envelope validation
// ---------------------------------------------------------------------------

test("accepts a valid minimal accept envelope", () => {
  assert.doesNotThrow(() => assertReviewerVerdictEnvelope(envelope()));
});

test("rejects a reject verdict with zero findings", () => {
  assert.throws(() => assertReviewerVerdictEnvelope(envelope({ verdict: "reject", findings: [] })));
});

test("accepts a reject verdict with at least one finding", () => {
  assert.doesNotThrow(() =>
    assertReviewerVerdictEnvelope(
      envelope({
        verdict: "reject",
        findings: [{ summary: "Missing test.", path: "src/x.ts" }],
      }),
    ),
  );
});

test("rejects an accept verdict carrying findings", () => {
  assert.throws(() =>
    assertReviewerVerdictEnvelope(
      envelope({
        verdict: "accept",
        findings: [{ summary: "Nit.", path: "src/x.ts" }],
      }),
    ),
  );
});

test("accepts a block verdict with no findings", () => {
  assert.doesNotThrow(() => assertReviewerVerdictEnvelope(envelope({ verdict: "block", findings: [] })));
});

test("accepts a block verdict with findings", () => {
  assert.doesNotThrow(() =>
    assertReviewerVerdictEnvelope(
      envelope({
        verdict: "block",
        findings: [{ summary: "Unsafe.", path: "src/x.ts" }],
      }),
    ),
  );
});

test("rejects each invalid verdict value", () => {
  for (const bad of ["approve", "REJECT", "", "accept ", "acceptt"]) {
    assert.throws(() => assertReviewerVerdictEnvelope(envelope({ verdict: bad as never })));
  }
});

test("rejects an unknown property at the envelope level", () => {
  assert.throws(() =>
    assertReviewerVerdictEnvelope({ ...envelope(), extra: true }),
  );
});

test("rejects an unknown property at the finding level", () => {
  assert.throws(() =>
    assertReviewerVerdictEnvelope(
      envelope({
        verdict: "reject",
        findings: [{ summary: "x", path: "src/x.ts", extra: true } as never],
      }),
    ),
  );
});

test("rejects a finding with an absolute path", () => {
  assert.throws(() =>
    assertReviewerVerdictEnvelope(
      envelope({ verdict: "reject", findings: [{ summary: "x", path: "/etc/passwd" }] }),
    ),
  );
});

test("rejects a finding with a .. traversal path", () => {
  assert.throws(() =>
    assertReviewerVerdictEnvelope(
      envelope({ verdict: "reject", findings: [{ summary: "x", path: "../secret.txt" }] }),
    ),
  );
});

test("accepts a finding with a backslash path, normalizing separators", () => {
  assert.doesNotThrow(() =>
    assertReviewerVerdictEnvelope(
      envelope({ verdict: "reject", findings: [{ summary: "x", path: "src\\x.ts" }] }),
    ),
  );
});

test("rejects a finding with an empty summary", () => {
  assert.throws(() =>
    assertReviewerVerdictEnvelope(
      envelope({ verdict: "reject", findings: [{ summary: "   ", path: "src/x.ts" }] }),
    ),
  );
});

test("rejects a finding with a multi-line summary", () => {
  assert.throws(() =>
    assertReviewerVerdictEnvelope(
      envelope({ verdict: "reject", findings: [{ summary: "line one\nline two", path: "src/x.ts" }] }),
    ),
  );
});

test("rejects a finding with a zero, negative, or non-integer line", () => {
  for (const line of [0, -1, 1.5]) {
    assert.throws(() =>
      assertReviewerVerdictEnvelope(
        envelope({ verdict: "reject", findings: [{ summary: "x", path: "src/x.ts", line }] }),
      ),
    );
  }
});

test("accepts a finding with a valid positive integer line", () => {
  assert.doesNotThrow(() =>
    assertReviewerVerdictEnvelope(
      envelope({ verdict: "reject", findings: [{ summary: "x", path: "src/x.ts", line: 12 }] }),
    ),
  );
});

test("rejects findings over the cap", () => {
  const findings = Array.from({ length: 51 }, (_, index) => ({
    summary: `finding ${index}`,
    path: "src/x.ts",
  }));
  assert.throws(() => assertReviewerVerdictEnvelope(envelope({ verdict: "reject", findings })));
});

test("accepts findings at the cap", () => {
  const findings = Array.from({ length: 50 }, (_, index) => ({
    summary: `finding ${index}`,
    path: "src/x.ts",
  }));
  assert.doesNotThrow(() => assertReviewerVerdictEnvelope(envelope({ verdict: "reject", findings })));
});

// ---------------------------------------------------------------------------
// Envelope extraction
// ---------------------------------------------------------------------------

test("parses a valid single JSON envelope", () => {
  const result = parseReviewerVerdict(JSON.stringify(envelope()));
  assert.equal(result.kind, "ok");
});

test("treats empty text as a contract violation", () => {
  const result = parseReviewerVerdict("   ");
  assert.equal(result.kind, "contract-violation");
});

test("treats non-JSON text as a contract violation", () => {
  const result = parseReviewerVerdict("The work looks good, I accept it.");
  assert.equal(result.kind, "contract-violation");
});

test("treats a JSON array as a contract violation", () => {
  const result = parseReviewerVerdict(JSON.stringify([envelope()]));
  assert.equal(result.kind, "contract-violation");
});

test("treats a bare JSON string as a contract violation", () => {
  const result = parseReviewerVerdict(JSON.stringify("accept"));
  assert.equal(result.kind, "contract-violation");
});

test("treats two concatenated envelopes as a contract violation, never taking the last one", () => {
  const text = `${JSON.stringify(envelope())}${JSON.stringify(envelope({ verdict: "block" }))}`;
  const result = parseReviewerVerdict(text);
  assert.equal(result.kind, "contract-violation");
});

test("treats a fenced JSON block as a contract violation, matching the worker's no-fence contract", () => {
  const result = parseReviewerVerdict("```json\n" + JSON.stringify(envelope()) + "\n```");
  assert.equal(result.kind, "contract-violation");
});

test("contract-violation detail does not echo the full raw response", () => {
  const raw = "SECRET-MARKER-471 not json at all, definitely not an envelope";
  const result = parseReviewerVerdict(raw);
  assert.equal(result.kind, "contract-violation");
  if (result.kind === "contract-violation") {
    assert.doesNotMatch(result.detail, /SECRET-MARKER-471/u);
  }
});

// ---------------------------------------------------------------------------
// Machine-failure classification and precedence
// ---------------------------------------------------------------------------

test("machineResultPasses is true when every signal passes", () => {
  assert.equal(machineResultPasses(evidence()), true);
});

test("classifyMachineFailure returns null when nothing failed", () => {
  assert.equal(classifyMachineFailure(evidence()), null);
});

test("a failed verification with an unnamed classification fails closed, never passes", () => {
  // The type permits `classification: null` on a failed verification even
  // though the durable validator forbids it. If this fell through to `null`,
  // machineResultPasses would report a pass and an accept verdict would then
  // accept work whose verification failed.
  const ev = evidence({ verification: verification({ status: "failed", classification: null }) });
  assert.equal(classifyMachineFailure(ev), "unknown");
  assert.equal(machineResultPasses(ev), false);
  const outcome = decideReviewOutcome(ev, envelope({ verdict: "accept" }));
  assert.equal(outcome.kind, "reject");
  if (outcome.kind === "reject") {
    assert.equal(outcome.classification, "unknown");
    assert.equal(outcome.repairable, false);
  }
});

test("classifies a detected secret", () => {
  const ev = evidence({ scan: scan({ status: "detected", findings: [{ ruleId: "r1", path: "a.txt", line: 1 }] }) });
  assert.equal(classifyMachineFailure(ev), "secret-detected");
});

test("classifies an explicit contract violation", () => {
  const ev = evidence({ contractViolation: "Verification command not allowlisted." });
  assert.equal(classifyMachineFailure(ev), "contract-violation");
});

test("classifies a verification-reported contract violation", () => {
  const ev = evidence({ verification: verification({ status: "failed", classification: "contract-violation" }) });
  assert.equal(classifyMachineFailure(ev), "contract-violation");
});

test("classifies a scope violation", () => {
  const ev = evidence({ scopeViolations: ["src/outside.ts"] });
  assert.equal(classifyMachineFailure(ev), "scope-violation");
});

test("classifies a verification failure", () => {
  const ev = evidence({ verification: verification({ status: "failed", classification: "verification-failure" }) });
  assert.equal(classifyMachineFailure(ev), "verification-failure");
});

test("classifies a timeout", () => {
  const ev = evidence({ verification: verification({ status: "failed", classification: "timeout" }) });
  assert.equal(classifyMachineFailure(ev), "timeout");
});

test("precedence: secret detection wins over simultaneous scope and verification failures", () => {
  const ev = evidence({
    scan: scan({ status: "detected", findings: [{ ruleId: "r1", path: "a.txt", line: 1 }] }),
    scopeViolations: ["src/outside.ts"],
    verification: verification({ status: "failed", classification: "verification-failure" }),
  });
  assert.equal(classifyMachineFailure(ev), "secret-detected");
});

test("precedence: contract violation wins over scope and verification failures when no secret", () => {
  const ev = evidence({
    contractViolation: "bad command",
    scopeViolations: ["src/outside.ts"],
    verification: verification({ status: "failed", classification: "verification-failure" }),
  });
  assert.equal(classifyMachineFailure(ev), "contract-violation");
});

test("precedence: scope violation wins over verification failure when no secret or contract violation", () => {
  const ev = evidence({
    scopeViolations: ["src/outside.ts"],
    verification: verification({ status: "failed", classification: "verification-failure" }),
  });
  assert.equal(classifyMachineFailure(ev), "scope-violation");
});

// ---------------------------------------------------------------------------
// Decision table
// ---------------------------------------------------------------------------

test("decision: machine failed -> its classification regardless of an accept verdict", () => {
  const ev = evidence({ scan: scan({ status: "detected", findings: [{ ruleId: "r1", path: "a.txt", line: 1 }] }) });
  const outcome = decideReviewOutcome(ev, envelope({ verdict: "accept" }));
  assert.deepEqual(outcome, { kind: "reject", classification: "secret-detected", repairable: false });
});

test("decision: machine failed (contract-violation) -> contract-violation regardless of verdict", () => {
  const ev = evidence({ contractViolation: "bad command" });
  const outcome = decideReviewOutcome(ev, envelope({ verdict: "accept" }));
  assert.deepEqual(outcome, { kind: "reject", classification: "contract-violation", repairable: false });
});

test("decision: machine failed (scope-violation) -> scope-violation regardless of verdict", () => {
  const ev = evidence({ scopeViolations: ["src/outside.ts"] });
  const outcome = decideReviewOutcome(ev, envelope({ verdict: "accept" }));
  assert.deepEqual(outcome, { kind: "reject", classification: "scope-violation", repairable: false });
});

test("decision: machine failed (verification-failure) -> verification-failure, repairable, regardless of verdict", () => {
  const ev = evidence({ verification: verification({ status: "failed", classification: "verification-failure" }) });
  const outcome = decideReviewOutcome(ev, envelope({ verdict: "accept" }));
  assert.deepEqual(outcome, { kind: "reject", classification: "verification-failure", repairable: true });
});

test("decision: machine failed (timeout) -> timeout, terminal, regardless of verdict", () => {
  const ev = evidence({ verification: verification({ status: "failed", classification: "timeout" }) });
  const outcome = decideReviewOutcome(ev, envelope({ verdict: "block" }));
  assert.deepEqual(outcome, { kind: "reject", classification: "timeout", repairable: false });
});

test("decision: machine passed + accept -> accept", () => {
  const outcome = decideReviewOutcome(evidence(), envelope({ verdict: "accept" }));
  assert.deepEqual(outcome, { kind: "accept" });
});

test("decision: machine passed + reject -> review-rejection, repairable", () => {
  const outcome = decideReviewOutcome(
    evidence(),
    envelope({ verdict: "reject", findings: [{ summary: "x", path: "a.ts" }] }),
  );
  assert.deepEqual(outcome, { kind: "reject", classification: "review-rejection", repairable: true });
});

test("decision: machine passed + block -> unknown, terminal", () => {
  const outcome = decideReviewOutcome(evidence(), envelope({ verdict: "block" }));
  assert.deepEqual(outcome, { kind: "reject", classification: "unknown", repairable: false });
});

test("decision: machine passed + malformed envelope -> contract-violation, terminal", () => {
  const outcome = decideReviewOutcome(evidence(), { kind: "contract-violation" });
  assert.deepEqual(outcome, { kind: "reject", classification: "contract-violation", repairable: false });
});

// ---------------------------------------------------------------------------
// buildAttemptVerdict
// ---------------------------------------------------------------------------

test("buildAttemptVerdict records a null classification only on acceptance", () => {
  const outcome = decideReviewOutcome(evidence(), envelope({ verdict: "accept" }));
  const record = buildAttemptVerdict({
    envelope: envelope({ verdict: "accept" }),
    outcome,
    evidencePath: "runs/x/verdict.json",
    recordedAt: "2026-07-29T00:00:00.000Z",
  });
  assert.equal(record.verdict, "accept");
  assert.equal(record.classification, null);
  assert.equal(record.findingCount, 0);
});

test("buildAttemptVerdict never records accept when classification is non-null", () => {
  const ev = evidence({ scan: scan({ status: "detected", findings: [{ ruleId: "r1", path: "a.txt", line: 1 }] }) });
  const modelEnvelope = envelope({ verdict: "accept" });
  const outcome = decideReviewOutcome(ev, modelEnvelope);
  const record = buildAttemptVerdict({
    envelope: modelEnvelope,
    outcome,
    evidencePath: "runs/x/verdict.json",
    recordedAt: "2026-07-29T00:00:00.000Z",
  });
  assert.notEqual(record.verdict, "accept");
  assert.equal(record.classification, "secret-detected");
});

test("buildAttemptVerdict records reject verdict and finding count on review rejection", () => {
  const modelEnvelope = envelope({
    verdict: "reject",
    findings: [{ summary: "x", path: "a.ts" }, { summary: "y", path: "b.ts" }],
  });
  const outcome = decideReviewOutcome(evidence(), modelEnvelope);
  const record = buildAttemptVerdict({
    envelope: modelEnvelope,
    outcome,
    evidencePath: "runs/x/verdict.json",
    recordedAt: "2026-07-29T00:00:00.000Z",
  });
  assert.equal(record.verdict, "reject");
  assert.equal(record.classification, "review-rejection");
  assert.equal(record.findingCount, 2);
});

test("buildAttemptVerdict falls back to block when no envelope parsed", () => {
  const outcome = decideReviewOutcome(evidence(), { kind: "contract-violation" });
  const record = buildAttemptVerdict({
    envelope: null,
    outcome,
    evidencePath: null,
    recordedAt: "2026-07-29T00:00:00.000Z",
  });
  assert.equal(record.verdict, "block");
  assert.equal(record.classification, "contract-violation");
  assert.equal(record.findingCount, 0);
});

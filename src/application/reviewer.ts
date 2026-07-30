import {
  assertReviewerVerdictEnvelope,
  type ReviewerVerdictEnvelope,
} from "../domain/reviewer.js";
import {
  isRepairableClassification,
  type AttemptScan,
  type AttemptVerdict,
  type AttemptVerification,
  type FailureClassification,
} from "../domain/execution.js";
import type { ModelRequest, ModelRunner } from "./ports.js";

export type ReviewerParseResult =
  | { readonly kind: "ok"; readonly envelope: ReviewerVerdictEnvelope }
  | { readonly kind: "contract-violation"; readonly detail: string };

/**
 * Strictly parse exactly one JSON envelope from raw reviewer text. Mirrors
 * `parseWorkerResult`: the entire trimmed response must be one JSON object and
 * nothing else, so markdown fences, prose, or a second concatenated object all
 * fail the single `JSON.parse` call rather than needing separate detection.
 */
export function parseReviewerVerdict(text: string): ReviewerParseResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { kind: "contract-violation", detail: "Reviewer response was empty." };
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed) as unknown;
  } catch {
    // `detail` must be actionable without echoing the model's raw text, which
    // is retained separately in evidence files rather than here.
    return {
      kind: "contract-violation",
      detail: "Reviewer response is not exactly one JSON object.",
    };
  }
  try {
    assertReviewerVerdictEnvelope(value);
  } catch (error: unknown) {
    return {
      kind: "contract-violation",
      detail: error instanceof Error ? error.message : "Reviewer verdict envelope is invalid.",
    };
  }
  return { kind: "ok", envelope: value };
}

export interface MachineEvidence {
  readonly verification: AttemptVerification;
  readonly scan: AttemptScan;
  readonly scopeViolations: readonly string[];
  /** Set when the contract itself was unrunnable (P05-T02 contract-violation). */
  readonly contractViolation?: string | null;
}

export type ReviewOutcome =
  | { readonly kind: "accept" }
  | { readonly kind: "reject"; readonly classification: FailureClassification; readonly repairable: boolean };

/** True only when every machine-produced signal passed. */
export function machineResultPasses(evidence: MachineEvidence): boolean {
  return classifyMachineFailure(evidence) === null;
}

/**
 * Machine-failure precedence, most terminal first: a detected secret outranks
 * a contract violation, which outranks scope, which outranks verification
 * failure/timeout. `null` means every machine signal passed.
 */
export function classifyMachineFailure(evidence: MachineEvidence): FailureClassification | null {
  if (evidence.scan.status === "detected") {
    return "secret-detected";
  }
  if (
    (evidence.contractViolation ?? null) !== null ||
    evidence.verification.classification === "contract-violation"
  ) {
    return "contract-violation";
  }
  if (evidence.scopeViolations.length > 0) {
    return "scope-violation";
  }
  if (evidence.verification.status === "failed") {
    // `assertAttemptVerification` enforces a non-null classification on a
    // failed verification, but this receives an in-memory value that has not
    // necessarily crossed that boundary. Fail closed: returning the raw
    // `null` here would make `machineResultPasses` report a passing machine
    // result for a failed verification, which is the one thing ADR 0010
    // forbids. `unknown` is the honest bucket for a failure we cannot name.
    return evidence.verification.classification ?? "unknown";
  }
  return null;
}

/**
 * The heart of ADR 0010: acceptance requires both a passing machine result and
 * an `accept` verdict. A model verdict can reject what passed but can never
 * accept what failed.
 */
export function decideReviewOutcome(
  evidence: MachineEvidence,
  verdict: ReviewerVerdictEnvelope | { readonly kind: "contract-violation" },
): ReviewOutcome {
  const machineFailure = classifyMachineFailure(evidence);
  if (machineFailure !== null) {
    return {
      kind: "reject",
      classification: machineFailure,
      repairable: isRepairableClassification(machineFailure),
    };
  }
  if ("kind" in verdict && verdict.kind === "contract-violation") {
    return { kind: "reject", classification: "contract-violation", repairable: false };
  }
  const envelope = verdict as ReviewerVerdictEnvelope;
  if (envelope.verdict === "accept") {
    return { kind: "accept" };
  }
  if (envelope.verdict === "reject") {
    return { kind: "reject", classification: "review-rejection", repairable: true };
  }
  // `block`: the ADR taxonomy is closed and only verification-failure and
  // review-rejection are repairable, so a reviewer's terminal "stop" maps to
  // the honest `unknown` bucket rather than an invented or repairable value.
  // Its reason reaches the operator through the persisted verdict evidence.
  return { kind: "reject", classification: "unknown", repairable: false };
}

export interface BuildAttemptVerdictInput {
  readonly envelope: ReviewerVerdictEnvelope | null;
  readonly outcome: ReviewOutcome;
  readonly evidencePath: string | null;
  readonly recordedAt: string;
}

/**
 * Builds the durable `AttemptVerdict` record from a decided outcome. The
 * persisted `verdict` must satisfy the domain invariant that classification is
 * null only when verdict is "accept" — so on a machine-failure rejection where
 * the model itself said "accept" (or the envelope failed to parse at all), the
 * raw model verdict is not reusable and "block" is recorded instead, since it
 * is the honest terminal shape for a rejection that did not come from the
 * model's own "reject" judgment.
 */
export function buildAttemptVerdict(input: BuildAttemptVerdictInput): AttemptVerdict {
  const rawVerdict = input.envelope?.verdict ?? null;
  const verdict =
    input.outcome.kind === "accept"
      ? "accept"
      : rawVerdict !== null && rawVerdict !== "accept"
        ? rawVerdict
        : "block";
  return {
    verdict,
    classification: input.outcome.kind === "accept" ? null : input.outcome.classification,
    findingCount: input.envelope?.findings.length ?? 0,
    evidencePath: input.evidencePath,
    recordedAt: input.recordedAt,
  };
}

/**
 * Thin seam for P05-T05: run the bounded reviewer request through the model
 * runner and parse the result. Text-only — no `workingDirectory`, so no
 * `workspaceAccess` capability is required from the adapter.
 */
export async function runReviewerVerdict(
  runner: ModelRunner,
  request: ModelRequest,
): Promise<ReviewerParseResult> {
  const response = await runner.run(request);
  return parseReviewerVerdict(response.text);
}

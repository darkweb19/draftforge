import { normalizeWorkerPath } from "./worker.js";

export type ReviewVerdict = "accept" | "reject" | "block";

export interface ReviewFinding {
  /** Non-empty, single-line human summary of the problem. */
  readonly summary: string;
  /** Repository-relative, normalized with the existing worker path rules. */
  readonly path: string;
  /** Optional 1-based line pointer. */
  readonly line?: number;
}

export interface ReviewerVerdictEnvelope {
  readonly verdict: ReviewVerdict;
  readonly findings: readonly ReviewFinding[];
  /** Non-empty reviewer rationale. */
  readonly summary: string;
}

const VERDICTS: readonly ReviewVerdict[] = ["accept", "reject", "block"];
const ENVELOPE_KEYS = ["verdict", "findings", "summary"] as const;
const FINDING_KEYS = ["summary", "path", "line"] as const;
// A runaway or adversarial model must not be able to grow the persisted
// findings list without bound; this caps it at a generous but finite size.
const MAX_FINDINGS = 50;

/** Untrusted reviewer output. Validate as strictly as the worker envelope. */
export function assertReviewerVerdictEnvelope(
  value: unknown,
): asserts value is ReviewerVerdictEnvelope {
  if (!isRecord(value)) {
    throw new Error("Reviewer verdict must be a JSON object.");
  }
  assertOnlyKeys(value, "Reviewer verdict", ENVELOPE_KEYS);
  assertRequiredKeys(value, "Reviewer verdict", ENVELOPE_KEYS);
  if (typeof value.verdict !== "string" || !VERDICTS.includes(value.verdict as ReviewVerdict)) {
    throw new Error('Reviewer verdict must be one of "accept", "reject", or "block".');
  }
  if (!Array.isArray(value.findings)) {
    throw new Error("Reviewer verdict findings must be an array.");
  }
  if (value.findings.length > MAX_FINDINGS) {
    throw new Error(`Reviewer verdict findings must not exceed ${MAX_FINDINGS} entries.`);
  }
  for (const [index, finding] of value.findings.entries()) {
    assertReviewFinding(finding, `Reviewer verdict findings[${index}]`);
  }
  assertNonEmptyString(value.summary, "Reviewer verdict summary");
  if (value.verdict === "reject" && value.findings.length === 0) {
    throw new Error('Reviewer verdict "reject" must carry at least one finding.');
  }
  if (value.verdict === "accept" && value.findings.length > 0) {
    throw new Error('Reviewer verdict "accept" must carry no findings.');
  }
}

function assertReviewFinding(value: unknown, path: string): asserts value is ReviewFinding {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object.`);
  }
  assertOnlyKeys(value, path, FINDING_KEYS);
  assertRequiredKeys(value, path, ["summary", "path"]);
  if (
    typeof value.summary !== "string" ||
    value.summary.trim().length === 0 ||
    value.summary.includes("\n") ||
    value.summary.includes("\r")
  ) {
    throw new Error(`${path}.summary must be a non-empty single-line string.`);
  }
  if (typeof value.path !== "string") {
    throw new Error(`${path}.path must be a string.`);
  }
  // Reuses the worker's untrusted-path normalization rules verbatim so
  // reviewer-reported paths are held to the same repository-relative bar.
  normalizeWorkerPath(value.path);
  if (value.line !== undefined) {
    if (!Number.isInteger(value.line) || (value.line as number) < 1) {
      throw new Error(`${path}.line must be a positive integer.`);
    }
  }
}

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string.`);
  }
}

function assertOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  path: string,
  allowed: readonly string[],
): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) {
    throw new Error(`${path} contains unsupported property: ${unexpected}.`);
  }
}

function assertRequiredKeys(
  value: Readonly<Record<string, unknown>>,
  path: string,
  required: readonly string[],
): void {
  const missing = required.find((key) => !(key in value));
  if (missing !== undefined) {
    throw new Error(`${path} is missing required property: ${missing}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

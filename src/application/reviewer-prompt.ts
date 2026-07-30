import type { AttemptScan, AttemptVerification } from "../domain/execution.js";
import type { ModelRequest } from "./ports.js";
import type { TaskContract } from "./task-contract.js";

export interface ReviewerPromptInput {
  readonly contract: TaskContract;
  readonly taskId: string;
  readonly changedPaths: readonly string[];
  readonly patch: string;
  readonly verification: AttemptVerification;
  readonly scan: AttemptScan;
  readonly scopeViolations: readonly string[];
  /** Truncation bound for the diff; default it sensibly. */
  readonly maxPatchBytes?: number;
}

const DEFAULT_MAX_PATCH_BYTES = 60_000;
const TRUNCATION_MARKER = "[diff truncated: exceeds prompt bound]";

/**
 * Build the bounded reviewer request. Carries only the assigned task's
 * contract, the authoritative diff, and machine evidence — never other tasks'
 * contracts, canonical state, `SESSION.md`, environment variables, secret
 * values, or file content beyond the diff.
 */
export function buildReviewerPrompt(input: ReviewerPromptInput): ModelRequest {
  if (input.taskId !== input.contract.id) {
    throw new Error("Reviewer prompt taskId must match the assigned contract id.");
  }
  const maxPatchBytes = input.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES;
  if (!Number.isInteger(maxPatchBytes) || maxPatchBytes < 1) {
    throw new Error("Reviewer prompt maxPatchBytes must be a positive integer.");
  }

  return {
    role: "reviewer",
    system: reviewerSystemPrompt(),
    user: [
      "# Task identity",
      "",
      `- Task ID: ${input.contract.id}`,
      "",
      "# Objective",
      "",
      input.contract.objective,
      "",
      "# Owned paths",
      "",
      renderList(input.contract.ownedPaths),
      "",
      "# Acceptance criteria",
      "",
      renderList(input.contract.acceptanceCriteria),
      "",
      "# Exclusions",
      "",
      renderList(input.contract.exclusions),
      "",
      "# Authoritative changed paths",
      "",
      renderList(input.changedPaths),
      "",
      "# Diff",
      "",
      renderDiff(input.patch, maxPatchBytes),
      "",
      "# Machine evidence",
      "",
      renderMachineEvidence(input.verification, input.scan, input.scopeViolations),
      "",
      "# Review contract",
      "",
      reviewContractText(),
      "",
      "# Required result envelope",
      "",
      "Return exactly one JSON object and no raw prose or Markdown fence:",
      "{",
      '  "verdict": "accept" | "reject" | "block",',
      '  "findings": [{ "summary": "non-empty single-line problem", "path": "repository/relative/path", "line": 1 }],',
      '  "summary": "non-empty rationale"',
      "}",
      "",
    ].join("\n"),
    // Text-only role call with no workspace side effects, unlike the worker
    // call: a transparent retry re-issues the same read-only judgment request
    // rather than resuming a durable attempt, so `retryPolicy: "none"` would
    // be the wrong default here.
    retryPolicy: "standard",
  };
}

function reviewContractText(): string {
  return [
    "A failed machine check cannot be accepted: acceptance requires both a",
    "passing machine result and an \"accept\" verdict, and this reviewer's",
    "verdict can never override or accept work that a failed machine check has",
    "already rejected. When the machine evidence below shows a failure, the",
    "only useful role for this review is to add findings that explain it or",
    "surface additional problems — not to accept the work.",
    "",
    "The reply must be exactly one JSON envelope and nothing else: no",
    "Markdown fence, no prose before or after it, and no more than one JSON",
    'object. The envelope has this exact shape: a "verdict" of "accept",',
    '"reject", or "block"; a "findings" array; and a non-empty "summary"',
    'rationale string. A "reject" verdict must carry at least one finding.',
    'An "accept" verdict must carry no findings.',
    "",
    "Every finding's \"path\" must be repository-relative, matching the",
    "authoritative changed-path list above; it must not be absolute, escape",
    "the repository with \"..\", or reference any path outside this task's",
    "diff.",
  ].join("\n");
}

function renderDiff(patch: string, maxPatchBytes: number): string {
  const bytes = Buffer.byteLength(patch, "utf8");
  if (bytes <= maxPatchBytes) {
    return patch.length === 0 ? "None." : patch;
  }
  const truncated = Buffer.from(patch, "utf8").subarray(0, maxPatchBytes).toString("utf8");
  return [truncated, "", TRUNCATION_MARKER].join("\n");
}

function renderMachineEvidence(
  verification: AttemptVerification,
  scan: AttemptScan,
  scopeViolations: readonly string[],
): string {
  return [
    "## Verification",
    "",
    `- Status: ${verification.status}`,
    `- Classification: ${verification.classification ?? "none"}`,
    "- Commands:",
    verification.commands.length === 0
      ? "  - None"
      : verification.commands
          .map(
            (command) =>
              `  - ${command.command}: exitCode=${command.exitCode ?? "null"}, timedOut=${String(command.timedOut)}, terminated=${String(command.terminated)}`,
          )
          .join("\n"),
    "",
    "## Scope violations",
    "",
    renderList(scopeViolations),
    "",
    "## Secret scan",
    "",
    `- Status: ${scan.status}`,
    "- Findings (locators only; values are never included):",
    scan.findings.length === 0
      ? "  - None"
      : scan.findings.map((finding) => `  - ${finding.ruleId} at ${finding.path}:${String(finding.line)}`).join("\n"),
  ].join("\n");
}

function renderList(values: readonly string[]): string {
  return values.length === 0 ? "- None" : values.map((value) => `- ${value}`).join("\n");
}

function reviewerSystemPrompt(): string {
  return [
    "You are DraftForge's bounded reviewer.",
    "Judge only whether the provided diff satisfies the assigned task's",
    "objective and acceptance criteria.",
    "You never see other tasks' contracts, canonical project state,",
    "SESSION.md, environment variables, secret values, or any file content",
    "beyond the diff shown to you.",
    "A failed machine check cannot be accepted regardless of your verdict.",
    "Return exactly one JSON verdict envelope and nothing else.",
  ].join("\n");
}

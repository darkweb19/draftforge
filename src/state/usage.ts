import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { UsageCallRecord } from "../application/usage.js";
import type { AttemptUsage } from "../domain/execution.js";
import { writeFileAtomic } from "./files.js";

const RUNS_DIRECTORY = ".draftforge/runs";
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * The durable run-level usage ledger.
 *
 * `usage.jsonl` is the source of truth: each call appends exactly one line in
 * a single append-mode write (`flag: "a"`), which is atomic enough for
 * line-sized writes under concurrent dispatch and never loses an entry, even
 * when several writers append at once.
 *
 * `usage.json` is a derived, disposable cache — the current aggregate,
 * rewritten atomically (temp file + rename, via `writeFileAtomic`) from the
 * full `.jsonl` after every append. Reading it is a convenience; reconciling
 * from `.jsonl` is always correct even if `.json` is stale or missing.
 */
export function usageLedgerPath(runId: string): string {
  assertRunId(runId);
  return `${RUNS_DIRECTORY}/${runId}/usage.jsonl`;
}

export function usageAggregatePath(runId: string): string {
  assertRunId(runId);
  return `${RUNS_DIRECTORY}/${runId}/usage.json`;
}

/** Appends one call record and rewrites the derived aggregate from the full ledger. */
export async function appendUsageCall(root: string, runId: string, record: UsageCallRecord): Promise<void> {
  if (record.runId !== runId) {
    throw new Error(`Usage record runId "${record.runId}" does not match ledger runId "${runId}".`);
  }
  const ledgerPath = resolveUnderRoot(root, usageLedgerPath(runId));
  await mkdir(dirname(ledgerPath), { recursive: true });
  await appendFile(ledgerPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a" });

  const records = await readUsageLedger(root, runId);
  await writeUsageAggregate(root, runId, aggregateRecords(records));
}

/**
 * Reads the ledger, de-duplicated by `callId` (last write for a given id
 * wins) so repeated reconciliation or a crash-then-retry never double-counts
 * a call. A malformed or truncated trailing line — the shape a crash mid-append
 * leaves behind — is skipped; every other line stays readable.
 */
export async function readUsageLedger(root: string, runId: string): Promise<readonly UsageCallRecord[]> {
  const ledgerPath = resolveUnderRoot(root, usageLedgerPath(runId));
  let raw: string;
  try {
    raw = await readFile(ledgerPath, "utf8");
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }

  const byCallId = new Map<string, UsageCallRecord>();
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // malformed/truncated trailing line; skip and keep the rest readable
    }
    if (isUsageCallRecord(parsed)) {
      byCallId.set(parsed.callId, parsed);
    }
  }
  return [...byCallId.values()];
}

/** Reads the current derived aggregate directly, recomputing from the ledger if absent. */
export async function readUsageAggregate(root: string, runId: string): Promise<AttemptUsage> {
  const path = resolveUnderRoot(root, usageAggregatePath(runId));
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as AttemptUsage;
  } catch (error: unknown) {
    if (!hasCode(error, "ENOENT")) {
      throw error;
    }
  }
  return aggregateRecords(await readUsageLedger(root, runId));
}

async function writeUsageAggregate(root: string, runId: string, aggregate: AttemptUsage): Promise<void> {
  const path = resolveUnderRoot(root, usageAggregatePath(runId));
  await writeFileAtomic(path, `${JSON.stringify(aggregate, null, 2)}\n`);
}

/**
 * Local aggregation mirroring `aggregateUsage` in `src/application/usage.ts`.
 * Duplicated rather than imported to avoid a runtime circular dependency
 * between the state and application layers — this module only takes a
 * type-only import from `application/usage.ts`.
 */
function aggregateRecords(records: readonly UsageCallRecord[]): AttemptUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let costUsd = 0;
  let inputKnown = true;
  let outputKnown = true;
  let totalKnown = true;
  let costKnown = true;

  for (const record of records) {
    const usage = record.usage;
    if (usage === null || usage.inputTokens === null) {
      inputKnown = false;
    } else {
      inputTokens += usage.inputTokens;
    }
    if (usage === null || usage.outputTokens === null) {
      outputKnown = false;
    } else {
      outputTokens += usage.outputTokens;
    }
    if (usage === null || usage.totalTokens === null) {
      totalKnown = false;
    } else {
      totalTokens += usage.totalTokens;
    }
    if (record.costUsd === null) {
      costKnown = false;
    } else {
      costUsd += record.costUsd;
    }
  }

  return {
    inputTokens: inputKnown ? inputTokens : null,
    outputTokens: outputKnown ? outputTokens : null,
    totalTokens: totalKnown ? totalTokens : null,
    costUsd: costKnown ? costUsd : null,
    calls: records.length,
  };
}

function isUsageCallRecord(value: unknown): value is UsageCallRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record["callId"] === "string" &&
    record["callId"].length > 0 &&
    typeof record["role"] === "string" &&
    typeof record["adapter"] === "string" &&
    typeof record["model"] === "string" &&
    (record["taskId"] === null || typeof record["taskId"] === "string") &&
    typeof record["runId"] === "string" &&
    (record["attemptId"] === null || typeof record["attemptId"] === "string") &&
    (record["usage"] === null || isReportedUsage(record["usage"])) &&
    (record["costUsd"] === null || typeof record["costUsd"] === "number") &&
    typeof record["recordedAt"] === "string"
  );
}

function isReportedUsage(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const usage = value as Record<string, unknown>;
  return (
    isNullableNumber(usage["inputTokens"]) &&
    isNullableNumber(usage["outputTokens"]) &&
    isNullableNumber(usage["totalTokens"])
  );
}

function isNullableNumber(value: unknown): boolean {
  return value === null || typeof value === "number";
}

function assertRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId) || runId === "." || runId === "..") {
    throw new Error("runId must contain only letters, numbers, dots, underscores, or hyphens.");
  }
}

function resolveUnderRoot(root: string, projectPath: string): string {
  const resolvedRoot = resolve(root);
  const output = resolve(resolvedRoot, projectPath);
  const relativePath = relative(resolvedRoot, output);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith("../")) {
    throw new Error(`Usage ledger path must stay inside the project: ${projectPath}.`);
  }
  return output;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

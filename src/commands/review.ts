import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import type { ProjectConfig } from "../config/config.js";
import type { AttemptReference, AttemptScan, AttemptVerification, FailureClassification } from "../domain/execution.js";
import { parseVerificationCommands } from "../domain/verification.js";
import { buildReviewerPrompt } from "../application/reviewer-prompt.js";
import {
  buildAttemptVerdict,
  classifyMachineFailure,
  decideReviewOutcome,
  parseReviewerVerdict,
  type MachineEvidence,
  type ReviewerParseResult,
} from "../application/reviewer.js";
import type { ModelRunner } from "../application/ports.js";
import { runVerification, verificationTimeoutMs } from "../application/verification.js";
import { scanForSecrets } from "../application/secrets.js";
import type { IntegrationIntent, ReviewWorkspacePort } from "../application/integration.js";
import type { WorkspacePort } from "../application/workspace.js";
import { reconcilePersistedWorkerResults } from "../application/execution.js";
import { readTaskContract, type TaskContract } from "../application/task-contract.js";
import { changedPathScopeViolations, executeClaimedWorker } from "../application/worker.js";
import { createExecutionAttemptManifest, hashTaskContract, readExecutionAttemptManifest, updateExecutionAttemptManifest, writeExecutionAttemptManifest } from "../state/execution.js";
import {
  appendRunEvent,
  configuredSecretsFromEnv,
  redactConfiguredSecrets,
  redactForLog,
  type RunEvent,
} from "../state/events.js";
import { readProjectState, writeFileAtomic, writeProjectState, writeSession } from "../state/files.js";
import { withProjectLock } from "../state/lock.js";
import { transitionTask } from "../state/transitions.js";
import { loadProjectConfig } from "../config/config.js";
import { createModelRunner } from "../providers/runner.js";
import { createProcessTransport } from "../providers/harness/process.js";
import { GitWorkspace } from "../workspaces/git.js";
import { assertWithinBudget, createUsageAccountedRunner, aggregateUsage } from "../application/usage.js";
import { appendUsageCall, readUsageLedger } from "../state/usage.js";

export interface ReviewOptions { readonly actor?: string }
export interface ReviewResult { readonly summary: ReviewSummary; readonly lines: readonly string[]; readonly exitCode: 0 | 1 }
export const DEFAULT_REVIEW_ACTOR = "draftforge-reviewer";

export async function runReview(root: string, options: ReviewOptions = {}, injected: Partial<ReviewDependencies> = {}): Promise<ReviewResult> {
  const config = injected.config ?? await loadProjectConfig(root);
  const summary = await reviewProject(root, {
    config,
    runner: injected.runner ?? createModelRunner(config),
    workspace: injected.workspace ?? new GitWorkspace({ projectRoot: root }),
    transport: injected.transport ?? createProcessTransport(),
    actor: options.actor ?? injected.actor ?? DEFAULT_REVIEW_ACTOR,
    ...(injected.now === undefined ? {} : { now: injected.now }),
    ...(injected.env === undefined ? {} : { env: injected.env }),
    ...(injected.caseSensitive === undefined ? {} : { caseSensitive: injected.caseSensitive }),
  });
  const lines = [
    `Accepted: ${renderIds(summary.accepted)}`,
    `Integrated: ${renderIds(summary.integrated)}`,
    `Repairing: ${renderIds(summary.repairing)}`,
    `Blocked: ${renderIds(summary.blocked)}`,
    ...summary.records.map((record) => `${record.taskId}: ${record.disposition} — ${record.detail}`),
  ];
  return { summary, lines, exitCode: summary.blocked.length > 0 || summary.records.some((record) => record.disposition === "blocked" || record.disposition === "deferred") ? 1 : 0 };
}

function renderIds(ids: readonly string[]): string { return ids.length === 0 ? "none" : ids.join(", "); }

export interface ReviewDependencies {
  readonly config: ProjectConfig;
  readonly runner: ModelRunner;
  readonly workspace: ReviewWorkspacePort & WorkspacePort;
  readonly transport: Parameters<typeof runVerification>[0]["transport"];
  readonly actor: string;
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
  readonly caseSensitive?: boolean;
}

export type ReviewDisposition = "accepted" | "integrated" | "repairing" | "blocked" | "no-work" | "deferred";
export interface ReviewRecord { readonly taskId: string; readonly disposition: ReviewDisposition; readonly detail: string }
export interface ReviewSummary { readonly records: readonly ReviewRecord[]; readonly accepted: readonly string[]; readonly integrated: readonly string[]; readonly repairing: readonly string[]; readonly blocked: readonly string[] }

/** Machine-first review. Durable manifest writes deliberately precede every state mutation. */
export async function reviewProject(rootInput: string, dependencies: ReviewDependencies): Promise<ReviewSummary> {
  const root = resolve(rootInput);
  await reconcilePersistedWorkerResults({ root, actor: dependencies.actor, ...(dependencies.now === undefined ? {} : { now: dependencies.now }), ...(dependencies.env === undefined ? {} : { env: dependencies.env }) });
  const state = await readProjectState(root);
  const records: ReviewRecord[] = [];
  for (const task of state.tasks.filter((candidate) => candidate.status === "review")) {
    records.push(await reviewOne(root, task.id, dependencies));
  }
  const final = await readProjectState(root);
  const processed = new Set(records.filter((record) => record.disposition !== "no-work").map((record) => record.taskId));
  const accepted = (await Promise.all(final.tasks.map(async (task) => {
    if (!processed.has(task.id)) return null;
    if (task.attempt === null) return null;
    try {
      const manifest = await readExecutionAttemptManifest(root, task.attempt);
      return manifest.verdict?.verdict === "accept" && manifest.verdict.classification === null ? task.id : null;
    } catch { return null; }
  }))).filter((taskId): taskId is string => taskId !== null);
  return {
    records: records.length === 0 ? [{ taskId: "-", disposition: "no-work", detail: "No tasks await review." }] : records,
    accepted,
    integrated: records.filter((r) => r.disposition === "integrated").map((r) => r.taskId),
    repairing: records.filter((r) => r.disposition === "repairing").map((r) => r.taskId),
    blocked: final.tasks.filter((task) => task.status === "blocked").map((task) => task.id),
  };
}

async function reviewOne(root: string, taskId: string, d: ReviewDependencies): Promise<ReviewRecord> {
  const now = d.now ?? (() => new Date());
  const state = await readProjectState(root);
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  if (task === undefined || task.status !== "review") return { taskId, disposition: "deferred", detail: "Task is no longer awaiting review." };
  if (task.attempt === null) { await blockWithoutAttempt(root, taskId, "Review task has no attempt reference; resolve it by hand.", d, now()); return { taskId, disposition: "blocked", detail: "Review task has no attempt reference; resolve it by hand." }; }
  const reference = task.attempt;
  let manifest;
  let contract: TaskContract;
  try {
    manifest = await readExecutionAttemptManifest(root, reference);
    contract = await readTaskContract(root, task);
    if (manifest.taskId !== task.id || manifest.contractHash !== hashTaskContract(await readContract(root, task.taskFile))) throw new Error("Attempt contract drift or identity mismatch.");
    if (manifest.baseCommit === null) throw new Error("Review attempt has no recorded workspace base commit.");
  } catch (error: unknown) {
    return block(root, taskId, reference, "contract-violation", safeError(error), d, now());
  }
  if (manifest.integration?.status === "integrated") {
    await transition(root, taskId, reference, "done", null, d, now());
    return { taskId, disposition: "integrated", detail: "Recovered already-integrated attempt." };
  }

  let snapshot;
  try { snapshot = await d.workspace.reviewSnapshot({ runId: reference.runId, taskId, attemptId: reference.attemptId }, manifest.baseCommit); }
  catch (error: unknown) { return block(root, taskId, reference, "unknown", safeError(error), d, now()); }
  const scopeViolations = changedPathScopeViolations(snapshot.changedPaths, contract, d.caseSensitive);
  let verification: AttemptVerification;
  const plan = parseVerificationCommands(contract.verification);
  if (manifest.verification !== null && manifest.verification !== undefined) {
    verification = manifest.verification;
  } else if (plan.kind === "contract-violation") {
    verification = { status: "failed", classification: "contract-violation", commands: [], completedAt: now().toISOString() };
  } else {
    verification = await runVerification({
      commands: plan.commands, worktreePath: snapshot.location.path, transport: d.transport,
      timeoutMs: verificationTimeoutMs(d.config.limits.taskTimeoutMinutes), ...(d.env === undefined ? {} : { env: d.env }),
      persistTranscript: async (index, _command, contents) =>
        writeEvidence(root, reference, `verification-${String(index)}.log`, contents, d.env),
      now,
    });
  }
  let scan: AttemptScan;
  // A previous clean scan is evidence, not a promise that the retained
  // worktree is unchanged. Scan the fresh authoritative snapshot before any
  // prompt can carry it, then persist the refreshed locator-only result.
  try { scan = scanForSecrets({ diff: { changedPaths: snapshot.changedPaths, patch: snapshot.patch }, untracked: snapshot.untracked, now }); }
  catch (error: unknown) { return block(root, taskId, reference, "unknown", safeError(error), d, now()); }
  await writeEvidence(
    root,
    reference,
    "machine.json",
    JSON.stringify({ changedPaths: snapshot.changedPaths, scopeViolations, verification, scan }, null, 2),
    d.env,
  );
  const evidence: MachineEvidence = { verification, scan, scopeViolations };
  const machineFailure = classifyMachineFailure(evidence);
  // Never disclose a raw diff to a reviewer when a machine gate already
  // failed. Secrets in particular must stop before prompt construction.
  if (machineFailure !== null) {
    manifest = await updateExecutionAttemptManifest(root, reference, { lifecycle: "verifying", verification, scan, now: now() });
    if (manifest.verdict === null || manifest.verdict === undefined) {
      const outcome = { kind: "reject" as const, classification: machineFailure, repairable: machineFailure === "verification-failure" };
      const evidencePath = await writeEvidence(
        root,
        reference,
        "review.json",
        JSON.stringify({ verdict: null, classification: machineFailure }, null, 2),
        d.env,
      );
      manifest = await updateExecutionAttemptManifest(root, reference, { verdict: buildAttemptVerdict({ envelope: null, outcome, evidencePath, recordedAt: now().toISOString() }), usage: await attemptUsage(root, reference), now: now() });
    }
    return rejectOrRepair(root, taskId, reference, manifest, machineFailure, d, now());
  }
  let parsed: ReviewerParseResult | undefined;
  let envelope = null;
  if (manifest.verdict === null || manifest.verdict === undefined) {
    const lease = await persistEvidenceAndClaimReviewerLease(root, reference, verification, scan, now(), d.workspace);
    if (lease === null) return { taskId, disposition: "deferred", detail: "Another reviewer holds the short-lived durable lease." };
    manifest = lease.manifest;
    if (manifest.verdict !== null && manifest.verdict !== undefined) {
      const persistedClassification = manifest.verdict.classification;
      if (persistedClassification !== null) return rejectOrRepair(root, taskId, reference, manifest, persistedClassification, d, now());
    } else {
      try {
        try {
          const response = await accountedRunner(root, d, reference, taskId, manifest, "reviewer").run(buildReviewerPrompt({ contract, taskId, changedPaths: snapshot.changedPaths, patch: snapshot.patch, verification, scan, scopeViolations }));
          parsed = parseReviewerVerdict(response.text);
          if (parsed.kind === "ok") envelope = parsed.envelope;
        } catch (error: unknown) {
          return block(root, taskId, reference, isTimeout(error) ? "timeout" : "harness-failure", safeError(error), d, now());
        }
        const outcome = decideReviewOutcome(evidence, parsed?.kind === "ok" ? parsed.envelope : { kind: "contract-violation" });
        const evidencePath = await writeEvidence(
          root,
          reference,
          "review.json",
          JSON.stringify(
            { verdict: envelope, classification: outcome.kind === "accept" ? null : outcome.classification },
            null,
            2,
          ),
          d.env,
        );
        manifest = await updateExecutionAttemptManifest(root, reference, { verdict: buildAttemptVerdict({ envelope, outcome, evidencePath, recordedAt: now().toISOString() }), usage: await attemptUsage(root, reference), now: now() });
      } finally {
        await releaseReviewerLease(root, reference, lease.leaseId);
      }
    }
  }
  const classification = manifest.verdict?.classification ?? null;
  if (classification !== null) return rejectOrRepair(root, taskId, reference, manifest, classification, d, now());
  // Acceptance TOCTOU recheck: a changed scope or a newly-written secret can never race the merge.
  try {
    const fresh = await d.workspace.reviewSnapshot({ runId: reference.runId, taskId, attemptId: reference.attemptId }, manifest.baseCommit as string);
    const freshScope = changedPathScopeViolations(fresh.changedPaths, contract, d.caseSensitive);
    const freshScan = scanForSecrets({ diff: { changedPaths: fresh.changedPaths, patch: fresh.patch }, untracked: fresh.untracked, now });
    if (freshScope.length > 0) return block(root, taskId, reference, "scope-violation", "Scope changed before integration.", d, now());
    if (freshScan.status === "detected") return block(root, taskId, reference, "secret-detected", "Secret scan detected a locator before integration.", d, now());
    const prepared = await readIntegrationIntent(root, reference) ?? await prepareIntent(root, reference, d, { attempt: { runId: reference.runId, taskId, attemptId: reference.attemptId }, expectedBaseCommit: manifest.baseCommit as string, taskId });
    if ("detail" in prepared) return integrationBlock(root, taskId, reference, prepared, d, now());
    const intent = prepared;
    const integrated = await d.workspace.mergePreparedIntegration(intent);
    if (integrated.status === "conflict") return integrationBlock(root, taskId, reference, integrated, d, now());
    await updateExecutionAttemptManifest(root, reference, { lifecycle: "integrated", integration: { ...integrated, integratedAt: now().toISOString() }, now: now() });
    await transition(root, taskId, reference, "done", null, d, now());
    return { taskId, disposition: "integrated", detail: "Accepted and integrated." };
  } catch (error: unknown) { return block(root, taskId, reference, "integration-conflict", safeError(error), d, now()); }
}

async function rejectOrRepair(root: string, taskId: string, reference: AttemptReference, manifest: Awaited<ReturnType<typeof readExecutionAttemptManifest>>, classification: FailureClassification, d: ReviewDependencies, now: Date): Promise<ReviewRecord> {
  const current = await readProjectState(root); const task = current.tasks.find((candidate) => candidate.id === taskId);
  const repairs = task?.review?.repairAttempts ?? 0;
  if (classification !== "verification-failure" && classification !== "review-rejection" || repairs >= d.config.limits.maxRepairAttempts) return block(root, taskId, reference, classification, "Review rejection is terminal or the repair limit was reached.", d, now);
  const nextReference = { runId: reference.runId, attemptId: `${reference.attemptId}-repair-${String(repairs + 1)}` };
  let nextManifest: Awaited<ReturnType<typeof readExecutionAttemptManifest>>;
  try {
    nextManifest = await readExecutionAttemptManifest(root, nextReference);
    if (nextManifest.taskId !== taskId || nextManifest.contractHash !== manifest.contractHash) throw new Error("Existing repair attempt does not match the rejected attempt.");
  } catch (error: unknown) {
    if (!(error instanceof Error) || !error.message.includes("is missing")) throw error;
    nextManifest = createExecutionAttemptManifest({ reference: nextReference, taskId, contractHash: manifest.contractHash, now, ...(manifest.budget === null ? {} : { budget: manifest.budget }) });
    await writeExecutionAttemptManifest(root, nextManifest);
  }
  const findings = await readFindings(root, manifest.verdict?.evidencePath);
  let repairWorkspace;
  try { repairWorkspace = await d.workspace.prepareRepair({ runId: reference.runId, taskId, attemptId: reference.attemptId }, { runId: nextReference.runId, taskId, attemptId: nextReference.attemptId }, manifest.baseCommit as string); }
  catch (error: unknown) { return block(root, taskId, reference, "unknown", safeError(error), d, now); }
  await transition(root, taskId, reference, "active", { repairAttempts: repairs + 1, lastClassification: classification, lastReviewAttempt: reference, attempt: nextReference }, d, now);
  const fresh = await readProjectState(root); const active = fresh.tasks.find((candidate) => candidate.id === taskId);
  if (active === undefined) return { taskId, disposition: "deferred", detail: "Repair claim disappeared." };
  const contract = await readTaskContract(root, active);
  await executeClaimedWorker({ root, claimed: { task: active, contract, manifest: nextManifest }, runner: accountedRunner(root, d, nextReference, taskId, nextManifest, "worker"), workspace: d.workspace, actor: d.actor, now, ...(d.env === undefined ? {} : { env: d.env }), repairWorkspace, repairFindings: findings, ...(d.caseSensitive === undefined ? {} : { caseSensitive: d.caseSensitive }) });
  return { taskId, disposition: "repairing", detail: "Created and dispatched a bounded repair attempt." };
}

async function block(root: string, taskId: string, reference: AttemptReference, classification: FailureClassification, detail: string, d: ReviewDependencies, now: Date): Promise<ReviewRecord> {
  try { await updateExecutionAttemptManifest(root, reference, { lifecycle: "blocked", usage: await attemptUsage(root, reference), now }); } catch { /* malformed/missing evidence stays retained */ }
  await transition(root, taskId, reference, "blocked", { lastClassification: classification, lastReviewAttempt: reference }, d, now);
  return { taskId, disposition: "blocked", detail };
}
async function blockWithoutAttempt(root: string, taskId: string, detail: string, d: ReviewDependencies, now: Date): Promise<void> { await withProjectLock(root, "review missing attempt", async () => { const state = await readProjectState(root); const task = state.tasks.find((candidate) => candidate.id === taskId); if (task === undefined || task.status !== "review" || task.attempt !== null) return; let next = transitionTask(state, taskId, "blocked"); next = { ...next, tasks: next.tasks.map((candidate) => candidate.id === taskId ? { ...candidate, review: { repairAttempts: candidate.review?.repairAttempts ?? 0, lastClassification: "contract-violation", lastReviewAttempt: null } } : candidate) }; await appendRunEvent(root, "review-without-attempt", { schemaVersion: 1, timestamp: now.toISOString(), type: "task.transition", data: { taskId, from: "review", to: "blocked", actor: d.actor, metadata: { classification: "contract-violation", detail } } }, d.env); await writeProjectState(root, next); await writeSession(root, next); }); }

async function transition(root: string, taskId: string, reference: AttemptReference, to: "active" | "blocked" | "done", review: Record<string, unknown> | null, d: ReviewDependencies, now: Date): Promise<void> {
  await withProjectLock(root, "review transition", async () => {
    const state = await readProjectState(root); const task = state.tasks.find((candidate) => candidate.id === taskId);
    if (task === undefined || task.attempt?.runId !== reference.runId || task.attempt.attemptId !== reference.attemptId) return;
    if (task.status === to) return;
    if (task.status !== "review" && !(task.status === "active" && to === "blocked")) return;
    let next = transitionTask(state, taskId, to);
    next = { ...next, tasks: next.tasks.map((candidate) => candidate.id !== taskId ? candidate : { ...candidate, ...(review !== null && "attempt" in review ? { attempt: review.attempt as AttemptReference } : {}), review: { repairAttempts: typeof review?.repairAttempts === "number" ? review.repairAttempts : candidate.review?.repairAttempts ?? 0, lastClassification: review?.lastClassification as FailureClassification | null ?? candidate.review?.lastClassification ?? null, lastReviewAttempt: review?.lastReviewAttempt as AttemptReference | null ?? candidate.review?.lastReviewAttempt ?? reference } }) };
    const event: RunEvent = { schemaVersion: 1, timestamp: now.toISOString(), type: "task.transition", data: { taskId, from: task.status, to, actor: d.actor, metadata: { attemptId: reference.attemptId, classification: review?.lastClassification ?? null } } };
    await appendRunEvent(root, reference.runId, event, d.env); await writeProjectState(root, next); await writeSession(root, next);
  });
}

async function writeEvidence(
  root: string,
  reference: AttemptReference,
  suffix: string,
  contents: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const path = `.draftforge/runs/${reference.runId}/attempts/${reference.attemptId}.${suffix}`;
  const redacted = redactForLog(
    redactConfiguredSecrets(contents, configuredSecretsFromEnv(env)),
  );
  await writeFileAtomic(
    resolve(root, path),
    typeof redacted === "string" ? redacted : JSON.stringify(redacted),
  );
  return path;
}
async function integrationIntentPath(reference: AttemptReference): Promise<string> { return `.draftforge/runs/${reference.runId}/attempts/${reference.attemptId}.integration-intent.json`; }
async function readIntegrationIntent(root: string, reference: AttemptReference): Promise<IntegrationIntent | null> { try { const value = JSON.parse(await readContract(root, await integrationIntentPath(reference))) as unknown; return isIntegrationIntent(value) ? value : null; } catch { return null; } }
async function prepareIntent(root: string, reference: AttemptReference, d: ReviewDependencies, input: Parameters<ReviewWorkspacePort["prepareIntegration"]>[0]): Promise<IntegrationIntent | Extract<Awaited<ReturnType<ReviewWorkspacePort["prepareIntegration"]>>, { status: "conflict" }>> { const preparation = await d.workspace.prepareIntegration(input); if (preparation.status === "conflict") return preparation; await writeEvidence(root, reference, "integration-intent.json", JSON.stringify(preparation.intent, null, 2), d.env); return preparation.intent; }
function isIntegrationIntent(value: unknown): value is IntegrationIntent { return typeof value === "object" && value !== null && typeof (value as { projectBranch?: unknown }).projectBranch === "string" && typeof (value as { rollbackCommit?: unknown }).rollbackCommit === "string" && typeof (value as { branchTip?: unknown }).branchTip === "string" && typeof (value as { taskId?: unknown }).taskId === "string"; }
async function integrationBlock(root: string, taskId: string, reference: AttemptReference, result: Extract<Awaited<ReturnType<ReviewWorkspacePort["mergePreparedIntegration"]>> | Awaited<ReturnType<ReviewWorkspacePort["prepareIntegration"]>>, { status: "conflict" }>, d: ReviewDependencies, now: Date): Promise<ReviewRecord> { await updateExecutionAttemptManifest(root, reference, { lifecycle: "blocked", integration: { status: "conflict", projectBranch: result.projectBranch, rollbackCommit: result.rollbackCommit, integrationCommit: null, integratedAt: now.toISOString() }, usage: await attemptUsage(root, reference), now }); return block(root, taskId, reference, "integration-conflict", result.detail, d, now); }
async function readFindings(root: string, path: string | null | undefined): Promise<readonly { summary: string; path: string; line?: number }[]> { if (path === null || path === undefined) return []; try { const value = JSON.parse(await readContract(root, path)) as { verdict?: { findings?: unknown } }; const findings = value.verdict?.findings; return Array.isArray(findings) ? findings.filter(isFinding) : []; } catch { return []; } }
function isFinding(value: unknown): value is { summary: string; path: string; line?: number } { return typeof value === "object" && value !== null && typeof (value as { summary?: unknown }).summary === "string" && typeof (value as { path?: unknown }).path === "string"; }
async function readContract(root: string, path: string): Promise<string> { const { readFile } = await import("node:fs/promises"); return readFile(resolve(root, path), "utf8"); }
function safeError(error: unknown): string { return error instanceof Error ? error.message.replace(/(?:sk-|AKIA|xox)[A-Za-z0-9_\-/]+/gu, "[REDACTED]") : "Review operation failed."; }
function accountedRunner(root: string, d: ReviewDependencies, reference: AttemptReference, taskId: string, manifest: Awaited<ReturnType<typeof readExecutionAttemptManifest>>, callKind: "reviewer" | "worker"): ModelRunner {
  // A wrapper's local record array starts empty. Check the durable attempt
  // ledger first so a crash/retry cannot reset an already exceeded budget.
  const checked: ModelRunner = {
    ...(d.runner.capabilities === undefined ? {} : { capabilities: d.runner.capabilities }),
    async run(request) { assertWithinBudget(await attemptUsage(root, reference), manifest.budget, taskId); return d.runner.run(request); },
  };
  return createUsageAccountedRunner(checked, {
    runId: reference.runId, taskId, attemptId: reference.attemptId, budget: manifest.budget,
    resolveRoute: (role) => ({ adapter: d.config.roles[role].adapter, model: d.config.roles[role].model }),
    record: (record) => appendUsageCall(root, reference.runId, record), ...(d.now === undefined ? {} : { now: d.now }),
    generateCallId: () => `${reference.attemptId}-${callKind}`,
  });
}
function isTimeout(error: unknown): boolean { return typeof error === "object" && error !== null && "name" in error && (error as { name: unknown }).name === "TimeoutError"; }
interface ReviewerLease { readonly pid: number; readonly leaseId: string }
function reviewerLeasePath(reference: AttemptReference): string { return `.draftforge/runs/${reference.runId}/attempts/${reference.attemptId}.review-lease.json`; }
async function persistEvidenceAndClaimReviewerLease(root: string, reference: AttemptReference, verification: AttemptVerification, scan: AttemptScan, now: Date, workspace: WorkspacePort): Promise<{ readonly manifest: Awaited<ReturnType<typeof readExecutionAttemptManifest>>; readonly leaseId: string } | null> {
  return withProjectLock(root, "reviewer lease", async () => {
    const manifest = await readExecutionAttemptManifest(root, reference);
    if (manifest.verdict !== null && manifest.verdict !== undefined) return { manifest, leaseId: "" };
    const existing = await readReviewerLease(root, reference);
    if (existing !== null) {
      if (existing.pid === process.pid) return null;
      const liveness = await workspace.processLiveness({ processId: existing.pid });
      if (liveness !== "not-found") return null;
    }
    const leaseId = randomUUID();
    await writeFileAtomic(resolve(root, reviewerLeasePath(reference)), `${JSON.stringify({ pid: process.pid, leaseId })}\n`);
    const next = await updateExecutionAttemptManifest(root, reference, { lifecycle: "reviewing", verification, scan, now });
    return { manifest: next, leaseId };
  });
}
async function readReviewerLease(root: string, reference: AttemptReference): Promise<ReviewerLease | null> { try { const value = JSON.parse(await readFile(resolve(root, reviewerLeasePath(reference)), "utf8")) as unknown; return typeof value === "object" && value !== null && typeof (value as { pid?: unknown }).pid === "number" && Number.isInteger((value as { pid: number }).pid) && typeof (value as { leaseId?: unknown }).leaseId === "string" ? value as ReviewerLease : null; } catch { return null; } }
async function releaseReviewerLease(root: string, reference: AttemptReference, leaseId: string): Promise<void> { if (leaseId.length === 0) return; try { const current = await readReviewerLease(root, reference); if (current?.leaseId === leaseId) await unlink(resolve(root, reviewerLeasePath(reference))); } catch { /* stale lease recovery handles leftovers */ } }
async function attemptUsage(root: string, reference: AttemptReference) { return aggregateUsage((await readUsageLedger(root, reference.runId)).filter((record) => record.attemptId === reference.attemptId)); }

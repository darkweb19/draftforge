import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { costForUsage } from "../src/providers/pricing.js";
import {
  BudgetExceededError,
  aggregateUsage,
  assertWithinBudget,
  createUsageAccountedRunner,
  type UsageCallRecord,
} from "../src/application/usage.js";
import type { ModelResponse, ModelRunner } from "../src/application/ports.js";
import type { TaskBudget } from "../src/domain/execution.js";
import { appendUsageCall, readUsageAggregate, readUsageLedger, usageAggregatePath, usageLedgerPath } from "../src/state/usage.js";
import { resolve } from "node:path";

function record(overrides: Partial<UsageCallRecord> = {}): UsageCallRecord {
  return {
    callId: "call-1",
    role: "worker",
    adapter: "anthropic-api",
    model: "claude-sonnet-5",
    taskId: "P05-T04",
    runId: "run-1",
    attemptId: "attempt-1",
    usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 },
    costUsd: 0.1,
    recordedAt: "2026-07-29T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// costForUsage — src/providers/pricing.ts
// ---------------------------------------------------------------------------

test("costForUsage is null for an unpriced model, never zero", () => {
  assert.equal(
    costForUsage("some-unknown-model", { inputTokens: 100, outputTokens: 100, totalTokens: 200 }),
    null,
  );
});

test("costForUsage is null when usage is absent", () => {
  assert.equal(costForUsage("claude-sonnet-5", undefined), null);
});

test("costForUsage is null when a needed token count is null", () => {
  assert.equal(
    costForUsage("claude-sonnet-5", { inputTokens: 100, outputTokens: null, totalTokens: null }),
    null,
  );
});

test("costForUsage computes cost for an exact-match priced model", () => {
  const cost = costForUsage("claude-sonnet-5", {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    totalTokens: 2_000_000,
  });
  assert.equal(cost, 3.0 + 15.0);
});

test("costForUsage matches a dated-variant model via documented longest-prefix rule", () => {
  const cost = costForUsage("claude-sonnet-5-20260101", {
    inputTokens: 1_000_000,
    outputTokens: 0,
    totalTokens: 1_000_000,
  });
  assert.equal(cost, 3.0);
});

test("costForUsage does not let a near-miss model borrow an unrelated entry's price", () => {
  assert.equal(
    costForUsage("claude-sonnet-50", { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 }),
    null,
  );
});

// ---------------------------------------------------------------------------
// aggregateUsage — src/application/usage.ts
// ---------------------------------------------------------------------------

test("aggregateUsage sums an all-known record set", () => {
  const usage = aggregateUsage([
    record({ callId: "a", usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }, costUsd: 0.01 }),
    record({ callId: "b", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }, costUsd: 0.02 }),
  ]);
  assert.deepEqual(usage, { inputTokens: 15, outputTokens: 25, totalTokens: 40, costUsd: 0.03, calls: 2 });
});

test("aggregateUsage of zero records is all-zero, not unknown", () => {
  assert.deepEqual(aggregateUsage([]), {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    calls: 0,
  });
});

test("aggregateUsage never turns an unknown total into a number: one unknown record makes the total null", () => {
  const usage = aggregateUsage([
    record({ callId: "a", usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }, costUsd: 0.01 }),
  ]);
  assert.equal(usage.inputTokens, 10);

  const withUnknown = aggregateUsage([
    record({ callId: "a", usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }, costUsd: 0.01 }),
    record({ callId: "b", usage: null, costUsd: null }),
  ]);
  assert.equal(withUnknown.inputTokens, null, "mixing known and unknown must not silently understate the total");
  assert.equal(withUnknown.outputTokens, null);
  assert.equal(withUnknown.totalTokens, null);
  assert.equal(withUnknown.costUsd, null);
  assert.equal(withUnknown.calls, 2, "calls always counts every record regardless of known-ness");
});

// ---------------------------------------------------------------------------
// assertWithinBudget — src/application/usage.ts
// ---------------------------------------------------------------------------

function usage(overrides: Partial<{ inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; costUsd: number | null; calls: number }> = {}) {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    calls: 0,
    ...overrides,
  };
}

test("assertWithinBudget passes with a null budget regardless of accumulated usage", () => {
  assert.doesNotThrow(() => assertWithinBudget(usage({ totalTokens: 999_999_999 }), null, "P05-T04"));
});

test("assertWithinBudget enforces only tokenLimit when costLimitUsd is absent", () => {
  const budget: TaskBudget = { tokenLimit: 100 };
  assert.doesNotThrow(() => assertWithinBudget(usage({ totalTokens: 100, costUsd: 1_000_000 }), budget, "P05-T04"));
  assert.throws(() => assertWithinBudget(usage({ totalTokens: 101 }), budget, "P05-T04"), BudgetExceededError);
});

test("assertWithinBudget enforces only costLimitUsd when tokenLimit is absent", () => {
  const budget: TaskBudget = { costLimitUsd: 1 };
  assert.doesNotThrow(() => assertWithinBudget(usage({ totalTokens: 1_000_000, costUsd: 1 }), budget, "P05-T04"));
  assert.throws(() => assertWithinBudget(usage({ costUsd: 1.01 }), budget, "P05-T04"), BudgetExceededError);
});

test("assertWithinBudget enforces both limits when both are declared", () => {
  const budget: TaskBudget = { tokenLimit: 100, costLimitUsd: 1 };
  assert.throws(() => assertWithinBudget(usage({ totalTokens: 200, costUsd: 0.5 }), budget, "P05-T04"), BudgetExceededError);
  assert.throws(() => assertWithinBudget(usage({ totalTokens: 50, costUsd: 2 }), budget, "P05-T04"), BudgetExceededError);
});

test("assertWithinBudget refuses with an actionable message naming the limit, value, and task", () => {
  const budget: TaskBudget = { tokenLimit: 100 };
  assert.throws(() => assertWithinBudget(usage({ totalTokens: 500 }), budget, "P05-T04"), (error: unknown) => {
    assert.ok(error instanceof BudgetExceededError);
    assert.match(error.message, /P05-T04/);
    assert.match(error.message, /500/);
    assert.match(error.message, /100/);
    return true;
  });
});

test("an unknown accumulated total can never exceed a declared budget (deliberate: nothing to enforce against)", () => {
  const budget: TaskBudget = { tokenLimit: 1, costLimitUsd: 0.0001 };
  assert.doesNotThrow(() => assertWithinBudget(usage({ totalTokens: null, costUsd: null }), budget, "P05-T04"));
});

// ---------------------------------------------------------------------------
// createUsageAccountedRunner — src/application/usage.ts
// ---------------------------------------------------------------------------

function fakeRunner(onRun: (request: { readonly role: string }) => Promise<ModelResponse>): ModelRunner {
  return { async run(request) { return onRun(request); } };
}

test("createUsageAccountedRunner records a successful call with derived cost", async () => {
  const recorded: UsageCallRecord[] = [];
  const runner = fakeRunner(async () => ({
    text: "ok",
    usage: { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 },
  }));
  const accounted = createUsageAccountedRunner(runner, {
    runId: "run-1",
    taskId: "P05-T04",
    attemptId: "attempt-1",
    budget: null,
    resolveRoute: () => ({ adapter: "anthropic-api", model: "claude-sonnet-5" }),
    record: (r) => { recorded.push(r); },
    now: () => new Date("2026-07-29T00:00:00.000Z"),
    generateCallId: () => "fixed-call-id",
  });

  const response = await accounted.run({ role: "worker", system: "s", user: "u" });

  assert.equal(response.text, "ok");
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0], {
    callId: "fixed-call-id",
    role: "worker",
    adapter: "anthropic-api",
    model: "claude-sonnet-5",
    taskId: "P05-T04",
    runId: "run-1",
    attemptId: "attempt-1",
    usage: { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 },
    costUsd: 3.0,
    recordedAt: "2026-07-29T00:00:00.000Z",
  });
});

test("createUsageAccountedRunner refuses before the call once accumulated usage exceeds the budget, and never invokes the wrapped runner for the refused call", async () => {
  let calls = 0;
  const runner = fakeRunner(async () => {
    calls += 1;
    return { text: "ok", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
  });
  const recorded: UsageCallRecord[] = [];
  const accounted = createUsageAccountedRunner(runner, {
    runId: "run-1",
    taskId: "P05-T04",
    attemptId: "attempt-1",
    budget: { tokenLimit: 1 },
    resolveRoute: () => ({ adapter: "anthropic-api", model: "claude-sonnet-5" }),
    record: (r) => { recorded.push(r); },
  });

  // First call: budget check passes against zero accumulated usage; the call
  // itself then reports 10 tokens, already over the declared limit of 1.
  await accounted.run({ role: "worker", system: "s", user: "u" });
  assert.equal(calls, 1);
  assert.equal(recorded.length, 1);

  // Second call: the accumulated 10 tokens now exceeds the limit of 1, so the
  // budget check refuses before the wrapped runner is ever invoked again.
  await assert.rejects(accounted.run({ role: "worker", system: "s", user: "u" }), BudgetExceededError);

  assert.equal(calls, 1, "the wrapped runner must not be invoked for the refused call");
  assert.equal(recorded.length, 1, "the refused call must not be recorded");
});

test("createUsageAccountedRunner does not record a call that throws", async () => {
  const recorded: UsageCallRecord[] = [];
  const runner = fakeRunner(async () => {
    throw new Error("adapter failed");
  });
  const accounted = createUsageAccountedRunner(runner, {
    runId: "run-1",
    taskId: "P05-T04",
    attemptId: "attempt-1",
    budget: null,
    resolveRoute: () => ({ adapter: "anthropic-api", model: "claude-sonnet-5" }),
    record: (r) => { recorded.push(r); },
  });

  await assert.rejects(accounted.run({ role: "worker", system: "s", user: "u" }), /adapter failed/);
  assert.equal(recorded.length, 0);
});

test("createUsageAccountedRunner records harness usage as absent (usage: null) without estimating tokens", async () => {
  const recorded: UsageCallRecord[] = [];
  const runner = fakeRunner(async () => ({ text: "harness output, no usage reported" }));
  const accounted = createUsageAccountedRunner(runner, {
    runId: "run-1",
    taskId: "P05-T04",
    attemptId: "attempt-1",
    budget: null,
    resolveRoute: () => ({ adapter: "claude-cli", model: "provider-default" }),
    record: (r) => { recorded.push(r); },
  });

  await accounted.run({ role: "worker", system: "s", user: "u" });

  assert.equal(recorded[0]?.usage, null);
  assert.equal(recorded[0]?.costUsd, null);
});

test("no prompt or completion text handed to the accounted runner leaks into the recorded call", async () => {
  const SECRET_PROMPT = "the secret prompt text";
  const SECRET_COMPLETION = "the secret completion text";
  const recorded: UsageCallRecord[] = [];
  const runner = fakeRunner(async () => ({
    text: SECRET_COMPLETION,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  }));
  const accounted = createUsageAccountedRunner(runner, {
    runId: "run-1",
    taskId: "P05-T04",
    attemptId: "attempt-1",
    budget: null,
    resolveRoute: () => ({ adapter: "anthropic-api", model: "claude-sonnet-5" }),
    record: (r) => { recorded.push(r); },
  });

  await accounted.run({ role: "worker", system: "s", user: SECRET_PROMPT });

  const serialized = JSON.stringify(recorded);
  assert.ok(!serialized.includes(SECRET_PROMPT));
  assert.ok(!serialized.includes(SECRET_COMPLETION));
});

// ---------------------------------------------------------------------------
// The durable ledger — src/state/usage.ts
// ---------------------------------------------------------------------------

async function withTempRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "draftforge-usage-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

test("appendUsageCall writes one jsonl line per call and a matching aggregate", async () => {
  await withTempRoot(async (root) => {
    await appendUsageCall(root, "run-1", record({ callId: "a" }));
    await appendUsageCall(root, "run-1", record({ callId: "b", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, costUsd: 0.001 }));

    const ledgerContents = await readFile(resolve(root, usageLedgerPath("run-1")), "utf8");
    assert.equal(ledgerContents.trim().split("\n").length, 2);

    const aggregate = JSON.parse(await readFile(resolve(root, usageAggregatePath("run-1")), "utf8")) as unknown;
    assert.deepEqual(aggregate, { inputTokens: 101, outputTokens: 201, totalTokens: 302, costUsd: 0.101, calls: 2 });
  });
});

test("readUsageLedger de-duplicates a repeated callId, counting it once", async () => {
  await withTempRoot(async (root) => {
    await appendUsageCall(root, "run-1", record({ callId: "same" }));
    await appendUsageCall(root, "run-1", record({ callId: "same" })); // crash-then-retry re-append

    const records = await readUsageLedger(root, "run-1");
    assert.equal(records.length, 1);

    const aggregate = await readUsageAggregate(root, "run-1");
    assert.equal(aggregate.calls, 1);
  });
});

test("a malformed trailing ledger line is skipped; the rest of the ledger stays readable", async () => {
  await withTempRoot(async (root) => {
    await appendUsageCall(root, "run-1", record({ callId: "a" }));
    await appendUsageCall(root, "run-1", record({ callId: "b" }));

    const ledgerPath = resolve(root, usageLedgerPath("run-1"));
    const { appendFile } = await import("node:fs/promises");
    // Simulate a crash mid-write: a truncated, unparseable trailing line.
    await appendFile(ledgerPath, '{"callId":"c","role":"worker"', { encoding: "utf8" });

    const records = await readUsageLedger(root, "run-1");
    assert.equal(records.length, 2, "the two well-formed lines must still be readable");
    assert.ok(records.every((r) => r.callId !== "c"));
  });
});

test("reading a missing ledger returns an empty list rather than throwing", async () => {
  await withTempRoot(async (root) => {
    const records = await readUsageLedger(root, "run-missing");
    assert.deepEqual(records, []);
    const aggregate = await readUsageAggregate(root, "run-missing");
    assert.deepEqual(aggregate, { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, calls: 0 });
  });
});

test("concurrent appends from several writers all survive in the ledger", async () => {
  await withTempRoot(async (root) => {
    const writers = Array.from({ length: 10 }, (_, index) =>
      appendUsageCall(root, "run-1", record({ callId: `writer-${index}` })),
    );
    await Promise.all(writers);

    const records = await readUsageLedger(root, "run-1");
    assert.equal(records.length, 10, "every concurrent writer's line must be present");
    const ids = new Set(records.map((r) => r.callId));
    assert.equal(ids.size, 10);
    const aggregate = await readUsageAggregate(root, "run-1");
    assert.equal(aggregate.inputTokens, 1_000);
    assert.equal(aggregate.outputTokens, 2_000);
    assert.equal(aggregate.totalTokens, 3_000);
    assert.ok(aggregate.costUsd !== null && Math.abs(aggregate.costUsd - 1) < Number.EPSILON);
    assert.equal(aggregate.calls, 10);
  });
});

test("no ledger entry contains a prompt, completion, or secret-shaped value", async () => {
  await withTempRoot(async (root) => {
    await appendUsageCall(root, "run-1", record({ callId: "a" }));
    const raw = await readFile(resolve(root, usageLedgerPath("run-1")), "utf8");
    assert.ok(!raw.includes("sk-"));
    assert.ok(!/prompt|completion/i.test(raw));
  });
});

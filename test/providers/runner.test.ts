import assert from "node:assert/strict";
import { test } from "node:test";
import type { AdapterId, ProjectConfig } from "../../src/config/config.js";
import type { AdapterCapabilities, AdapterRequest, ModelAdapter } from "../../src/providers/adapter.js";
import { resolveAdapter } from "../../src/providers/registry.js";
import { createModelRunner, roleRoute } from "../../src/providers/runner.js";
import { AdapterError } from "../../src/providers/reliability.js";

const immediateSleep = (): Promise<void> => Promise.resolve();

function config(): ProjectConfig {
  return {
    roles: {
      architect: { adapter: "codex-cli", model: "gpt-5-codex", reasoning: "high" },
      worker: { adapter: "claude-cli", model: "provider-default", reasoning: "medium", maxConcurrency: 2 },
      reviewer: { adapter: "anthropic-api", model: "claude-sonnet", reasoning: "high" },
    },
    limits: { maxRepairAttempts: 2, taskTimeoutMinutes: 30 },
  };
}

function caps(id: AdapterId): AdapterCapabilities {
  return { id, transport: "api", authMode: "api-key", roles: ["architect", "worker", "reviewer"] };
}

test("createModelRunner routes each role to its configured adapter, model, and level", async () => {
  const seen: { readonly id: AdapterId; readonly request: AdapterRequest }[] = [];
  const resolveAdapter = (id: AdapterId): ModelAdapter => ({
    capabilities: caps(id),
    async run(request) {
      seen.push({ id, request });
      return { text: id };
    },
  });

  const runner = createModelRunner(config(), { resolveAdapter, env: {} });
  await runner.run({ role: "architect", system: "s", user: "u" });
  await runner.run({ role: "worker", system: "s", user: "u" });
  await runner.run({ role: "reviewer", system: "s", user: "u" });

  assert.deepEqual(
    seen.map((entry) => entry.id),
    ["codex-cli", "claude-cli", "anthropic-api"],
  );
  assert.equal(seen[0]?.request.model, "gpt-5-codex");
  assert.equal(seen[0]?.request.reasoning, "high");
  assert.equal(seen[1]?.request.model, "provider-default");
  assert.equal(seen[1]?.request.reasoning, "medium");
});

test("createModelRunner surfaces an adapter error after exhausting retries", async () => {
  let calls = 0;
  const resolveAdapter = (id: AdapterId): ModelAdapter => ({
    capabilities: caps(id),
    async run() {
      calls += 1;
      throw new AdapterError("temporary", true);
    },
  });

  const runner = createModelRunner(config(), {
    resolveAdapter,
    env: {},
    reliability: { attempts: 2, sleep: immediateSleep },
  });

  await assert.rejects(runner.run({ role: "architect", system: "s", user: "u" }), AdapterError);
  assert.equal(calls, 2);
});

test("the default adapter registry exposes harness capabilities without spawning a CLI", () => {
  assert.deepEqual(resolveAdapter("codex-cli").capabilities, {
    id: "codex-cli",
    transport: "harness",
    authMode: "local-cli",
    roles: ["architect", "worker", "reviewer"],
  });
  assert.deepEqual(resolveAdapter("claude-cli").capabilities, {
    id: "claude-cli",
    transport: "harness",
    authMode: "local-cli",
    roles: ["architect", "worker", "reviewer"],
  });
  assert.throws(() => resolveAdapter("openai-api"), /not implemented yet; it arrives in P03-T03/);
});

test("roleRoute reports the adapter configured for a role", () => {
  assert.equal(roleRoute(config(), "architect"), "codex-cli");
  assert.equal(roleRoute(config(), "reviewer"), "anthropic-api");
});

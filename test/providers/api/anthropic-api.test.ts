import assert from "node:assert/strict";
import { test } from "node:test";
import { createAnthropicApiAdapter } from "../../../src/providers/api/anthropic-api.js";
import { ApiAdapterError } from "../../../src/providers/api/http.js";
import { AdapterError, createRedactor } from "../../../src/providers/reliability.js";
import { assertAdapterContract, SAMPLE_ADAPTER_REQUEST } from "../contract.js";
import { FakeFetch, httpResponse, requestBody } from "./fake-fetch.js";

const KEY = "sk-ant-test-key-abcdefghij";
const LEAKED_SECRET = "anthropic-contract-secret-12345";
const ENV = { ANTHROPIC_API_KEY: KEY } as NodeJS.ProcessEnv;

function message(text: string): string {
  return JSON.stringify({
    content: [
      { type: "thinking", thinking: "internal" },
      { type: "text", text },
    ],
  });
}

test("Anthropic API adapter satisfies the shared adapter contract", async (t) => {
  const success = new FakeFetch(httpResponse(message("anthropic response")));
  const transient = new FakeFetch(
    httpResponse(`overloaded while handling ${LEAKED_SECRET}`, { ok: false, status: 529 }),
  );
  const terminal = new FakeFetch(
    httpResponse(`authentication_error ${LEAKED_SECRET}`, { ok: false, status: 401 }),
  );
  const redactor = createRedactor([LEAKED_SECRET, KEY]);

  await assertAdapterContract(t, {
    expected: {
      id: "anthropic-api",
      transport: "api",
      authMode: "api-key",
      roles: ["architect", "worker", "reviewer"],
    },
    success: createAnthropicApiAdapter({ fetch: success.fetch, env: ENV }),
    transientFailure: createAnthropicApiAdapter({ fetch: transient.fetch, env: ENV, redactor }),
    terminalFailure: createAnthropicApiAdapter({ fetch: terminal.fetch, env: ENV, redactor }),
    leakedSecret: LEAKED_SECRET,
  });

  const recorded = success.requests[0];
  assert.equal(recorded?.url, "https://api.anthropic.com/v1/messages");
  assert.equal(recorded?.init.headers["x-api-key"], KEY);
  assert.equal(recorded?.init.headers["anthropic-version"], "2023-06-01");
  const body = requestBody(recorded);
  assert.equal(body["model"], "claude-sonnet-5");
  assert.equal(body["system"], SAMPLE_ADAPTER_REQUEST.system);
  assert.deepEqual(body["messages"], [{ role: "user", content: SAMPLE_ADAPTER_REQUEST.user }]);
  // SAMPLE_ADAPTER_REQUEST is high reasoning, so extended thinking is enabled.
  assert.deepEqual(body["thinking"], { type: "enabled", budget_tokens: 2048 });
});

test("Anthropic adapter concatenates text blocks and forwards an explicit model", async () => {
  const raw = JSON.stringify({
    content: [
      { type: "text", text: "part one " },
      { type: "text", text: "part two" },
    ],
  });
  const fake = new FakeFetch(httpResponse(raw));
  const adapter = createAnthropicApiAdapter({ fetch: fake.fetch, env: ENV });

  const response = await adapter.run({
    ...SAMPLE_ADAPTER_REQUEST,
    model: "claude-explicit",
    reasoning: "low",
  });

  assert.equal(response.text, "part one part two");
  const body = requestBody(fake.requests[0]);
  assert.equal(body["model"], "claude-explicit");
  // Low reasoning keeps the non-thinking path.
  assert.equal(body["thinking"], undefined);
});

test("Anthropic adapter fails terminally when the key is unset and never calls fetch", async () => {
  const fake = new FakeFetch();
  const adapter = createAnthropicApiAdapter({ fetch: fake.fetch, env: {} as NodeJS.ProcessEnv });

  await assert.rejects(adapter.run(SAMPLE_ADAPTER_REQUEST), (error: unknown) => {
    assert.ok(error instanceof ApiAdapterError);
    assert.equal(error.retryable, false);
    assert.equal(error.kind, "missing-key");
    return true;
  });
  assert.equal(fake.requests.length, 0);
});

test("Anthropic adapter treats a message without text as terminal", async () => {
  const fake = new FakeFetch(httpResponse(JSON.stringify({ content: [{ type: "thinking" }] })));
  const adapter = createAnthropicApiAdapter({ fetch: fake.fetch, env: ENV });

  await assert.rejects(adapter.run(SAMPLE_ADAPTER_REQUEST), (error: unknown) => {
    assert.ok(error instanceof AdapterError);
    assert.equal(error.retryable, false);
    return true;
  });
});

// Guarded live smoke test. Requires a real key AND an explicit opt-in so that a
// routine `npm run check` never issues a paid request by surprise.
const liveEnabled =
  typeof process.env["ANTHROPIC_API_KEY"] === "string" &&
  process.env["ANTHROPIC_API_KEY"].length > 0 &&
  process.env["DRAFTFORGE_LIVE_SMOKE"] === "1";

test("Anthropic live smoke returns text", { skip: !liveEnabled }, async () => {
  const adapter = createAnthropicApiAdapter();
  const response = await adapter.run({
    role: "worker",
    model: "provider-default",
    reasoning: "low",
    system: "You are a terse assistant.",
    user: "Reply with the single word: ready.",
  });
  assert.ok(response.text.length > 0);
});

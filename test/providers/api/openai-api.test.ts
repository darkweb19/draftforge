import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenAiApiAdapter } from "../../../src/providers/api/openai-api.js";
import { ApiAdapterError } from "../../../src/providers/api/http.js";
import { AdapterError, createRedactor } from "../../../src/providers/reliability.js";
import { assertAdapterContract, SAMPLE_ADAPTER_REQUEST } from "../contract.js";
import { FakeFetch, httpResponse, requestBody } from "./fake-fetch.js";

const KEY = "sk-openai-test-key-abcdefghij";
const LEAKED_SECRET = "openai-contract-secret-12345";
const ENV = { OPENAI_API_KEY: KEY } as NodeJS.ProcessEnv;

function completion(text: string, usage?: Record<string, unknown>): string {
  return JSON.stringify({
    choices: [{ message: { role: "assistant", content: text } }],
    ...(usage === undefined ? {} : { usage }),
  });
}

test("OpenAI API adapter satisfies the shared adapter contract", async (t) => {
  const success = new FakeFetch(
    httpResponse(completion("openai response", { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 })),
  );
  const transient = new FakeFetch(
    httpResponse(`overloaded while handling ${LEAKED_SECRET}`, { ok: false, status: 429 }),
  );
  const terminal = new FakeFetch(
    httpResponse(`invalid api key ${LEAKED_SECRET}`, { ok: false, status: 401 }),
  );
  const redactor = createRedactor([LEAKED_SECRET, KEY]);

  await assertAdapterContract(t, {
    expected: {
      id: "openai-api",
      transport: "api",
      authMode: "api-key",
      roles: ["architect", "worker", "reviewer"],
      workspaceAccess: false,
    },
    success: createOpenAiApiAdapter({ fetch: success.fetch, env: ENV }),
    transientFailure: createOpenAiApiAdapter({ fetch: transient.fetch, env: ENV, redactor }),
    terminalFailure: createOpenAiApiAdapter({ fetch: terminal.fetch, env: ENV, redactor }),
    leakedSecret: LEAKED_SECRET,
  });

  const recorded = success.requests[0];
  assert.equal(recorded?.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(recorded?.init.method, "POST");
  assert.equal(recorded?.init.headers["authorization"], `Bearer ${KEY}`);
  const body = requestBody(recorded);
  assert.equal(body["model"], "gpt-5");
  assert.equal(body["reasoning_effort"], "high");
  assert.deepEqual(body["messages"], [
    { role: "system", content: SAMPLE_ADAPTER_REQUEST.system },
    { role: "user", content: SAMPLE_ADAPTER_REQUEST.user },
  ]);
});

test("OpenAI adapter forwards an explicit model and maps xhigh to high", async () => {
  const fake = new FakeFetch(httpResponse(completion("ok")));
  const adapter = createOpenAiApiAdapter({ fetch: fake.fetch, env: ENV });

  const response = await adapter.run({
    ...SAMPLE_ADAPTER_REQUEST,
    model: "gpt-explicit",
    reasoning: "xhigh",
  });

  assert.equal(response.text, "ok");
  const body = requestBody(fake.requests[0]);
  assert.equal(body["model"], "gpt-explicit");
  assert.equal(body["reasoning_effort"], "high");
});

test("OpenAI adapter fails terminally when the key is unset and never calls fetch", async () => {
  const fake = new FakeFetch();
  const adapter = createOpenAiApiAdapter({ fetch: fake.fetch, env: {} as NodeJS.ProcessEnv });

  await assert.rejects(adapter.run(SAMPLE_ADAPTER_REQUEST), (error: unknown) => {
    assert.ok(error instanceof ApiAdapterError);
    assert.equal(error.retryable, false);
    assert.equal(error.kind, "missing-key");
    return true;
  });
  assert.equal(fake.requests.length, 0);
});

test("OpenAI adapter defensively rejects local workspace access before key or fetch", async () => {
  const fake = new FakeFetch();
  const adapter = createOpenAiApiAdapter({ fetch: fake.fetch, env: {} as NodeJS.ProcessEnv });
  await assert.rejects(
    adapter.run({ ...SAMPLE_ADAPTER_REQUEST, workingDirectory: "/isolated/worktree" }),
    /text-only/u,
  );
  assert.equal(fake.requests.length, 0);
});

test("OpenAI adapter reports full usage from the wire", async () => {
  const fake = new FakeFetch(
    httpResponse(completion("ok", { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 })),
  );
  const adapter = createOpenAiApiAdapter({ fetch: fake.fetch, env: ENV });

  const response = await adapter.run(SAMPLE_ADAPTER_REQUEST);

  assert.deepEqual(response.usage, { inputTokens: 100, outputTokens: 200, totalTokens: 300 });
});

test("OpenAI adapter reports a partial usage object with the missing field null", async () => {
  const fake = new FakeFetch(httpResponse(completion("ok", { prompt_tokens: 100 })));
  const adapter = createOpenAiApiAdapter({ fetch: fake.fetch, env: ENV });

  const response = await adapter.run(SAMPLE_ADAPTER_REQUEST);

  assert.deepEqual(response.usage, { inputTokens: 100, outputTokens: null, totalTokens: null });
});

test("OpenAI adapter reports an all-null usage object when the provider sends none", async () => {
  const fake = new FakeFetch(httpResponse(completion("ok")));
  const adapter = createOpenAiApiAdapter({ fetch: fake.fetch, env: ENV });

  const response = await adapter.run(SAMPLE_ADAPTER_REQUEST);

  assert.deepEqual(response.usage, { inputTokens: null, outputTokens: null, totalTokens: null });
});

test("OpenAI adapter never coerces a malformed usage value; it stays null", async () => {
  const fake = new FakeFetch(
    httpResponse(
      completion("ok", { prompt_tokens: -5, completion_tokens: "12", total_tokens: 12.5 }),
    ),
  );
  const adapter = createOpenAiApiAdapter({ fetch: fake.fetch, env: ENV });

  const response = await adapter.run(SAMPLE_ADAPTER_REQUEST);

  assert.deepEqual(response.usage, { inputTokens: null, outputTokens: null, totalTokens: null });
});

test("OpenAI adapter treats an empty completion as terminal", async () => {
  const fake = new FakeFetch(httpResponse(completion("")));
  const adapter = createOpenAiApiAdapter({ fetch: fake.fetch, env: ENV });

  await assert.rejects(adapter.run(SAMPLE_ADAPTER_REQUEST), (error: unknown) => {
    assert.ok(error instanceof AdapterError);
    assert.equal(error.retryable, false);
    return true;
  });
});

// Guarded live smoke test. Requires a real key AND an explicit opt-in so that a
// routine `npm run check` never issues a paid request by surprise.
const liveEnabled =
  typeof process.env["OPENAI_API_KEY"] === "string" &&
  process.env["OPENAI_API_KEY"].length > 0 &&
  process.env["DRAFTFORGE_LIVE_SMOKE"] === "1";

test("OpenAI live smoke returns text", { skip: !liveEnabled }, async () => {
  const adapter = createOpenAiApiAdapter();
  const response = await adapter.run({
    role: "worker",
    model: "provider-default",
    reasoning: "low",
    system: "You are a terse assistant.",
    user: "Reply with the single word: ready.",
  });
  assert.ok(response.text.length > 0);
});

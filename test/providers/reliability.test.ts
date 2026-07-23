import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AdapterError,
  createRedactor,
  redact,
  secretsFromEnv,
  withReliability,
  withTimeout,
} from "../../src/providers/reliability.js";

const immediateSleep = (): Promise<void> => Promise.resolve();

test("redact removes API keys, bearer tokens, header keys, and literal secrets", () => {
  const literal = "topsecretliteralvalue";
  const text = [
    "openai sk-ABCDEF0123456789abcdef",
    "anthropic sk-ant-ABCDEF0123456789abcdef",
    "Authorization: Bearer abcdef.token.value",
    "x-api-key: someheadervalue123",
    `literal ${literal}`,
  ].join("\n");

  const out = redact(text, [literal]);

  assert.ok(!out.includes("sk-ABCDEF0123456789abcdef"));
  assert.ok(!out.includes("sk-ant-ABCDEF0123456789abcdef"));
  assert.ok(!out.includes("abcdef.token.value"));
  assert.ok(!out.includes("someheadervalue123"));
  assert.ok(!out.includes(literal));
  assert.match(out, /\[REDACTED\]/);
});

test("createRedactor ignores short strings that are not real secrets", () => {
  const redactor = createRedactor(["short", "aproperlengthsecret"]);
  const out = redactor("short aproperlengthsecret");
  assert.ok(out.includes("short"));
  assert.ok(!out.includes("aproperlengthsecret"));
});

test("secretsFromEnv returns only present secret-bearing values", () => {
  const values = secretsFromEnv({ OPENAI_API_KEY: "sk-openai-value-123456", NODE_ENV: "test" });
  assert.deepEqual(values, ["sk-openai-value-123456"]);
});

test("withTimeout rejects a retryable AdapterError when the operation is too slow", async () => {
  await assert.rejects(
    withTimeout(() => new Promise((resolve) => setTimeout(() => resolve("late"), 50)), 5),
    (error: unknown) => {
      assert.ok(error instanceof AdapterError);
      assert.equal(error.retryable, true);
      assert.match(error.message, /timed out/);
      return true;
    },
  );
});

test("withTimeout resolves when the operation finishes in time", async () => {
  const value = await withTimeout(async () => "quick", 1000);
  assert.equal(value, "quick");
});

test("withReliability retries transient failures up to the attempt budget", async () => {
  let calls = 0;
  await assert.rejects(
    withReliability(
      async () => {
        calls += 1;
        throw new AdapterError("temporary", true);
      },
      { timeoutMs: 1000, attempts: 3, sleep: immediateSleep },
    ),
    (error: unknown) => error instanceof AdapterError && error.retryable,
  );
  assert.equal(calls, 3);
});

test("withReliability does not retry terminal failures", async () => {
  let calls = 0;
  await assert.rejects(
    withReliability(
      async () => {
        calls += 1;
        throw new AdapterError("unauthorized", false);
      },
      { timeoutMs: 1000, attempts: 3, sleep: immediateSleep },
    ),
    (error: unknown) => error instanceof AdapterError && !error.retryable,
  );
  assert.equal(calls, 1);
});

test("withReliability succeeds after a transient failure clears", async () => {
  let calls = 0;
  const value = await withReliability(
    async () => {
      calls += 1;
      if (calls < 2) {
        throw new AdapterError("temporary", true);
      }
      return "ok";
    },
    { timeoutMs: 1000, attempts: 3, sleep: immediateSleep },
  );
  assert.equal(value, "ok");
  assert.equal(calls, 2);
});

test("withReliability redacts secrets from the surfaced error", async () => {
  const secret = "sk-ant-abcdef0123456789ABCDEF";
  await assert.rejects(
    withReliability(
      async () => {
        throw new AdapterError(`boom ${secret}`, false);
      },
      { timeoutMs: 1000, attempts: 1, redactor: createRedactor([secret]) },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AdapterError);
      assert.ok(!error.message.includes(secret));
      return true;
    },
  );
});

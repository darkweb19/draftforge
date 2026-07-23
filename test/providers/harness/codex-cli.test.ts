import assert from "node:assert/strict";
import { test } from "node:test";
import { createCodexCliAdapter } from "../../../src/providers/harness/codex-cli.js";
import { createRedactor } from "../../../src/providers/reliability.js";
import {
  assertAdapterContract,
  SAMPLE_ADAPTER_REQUEST,
} from "../contract.js";
import { FakeProcessTransport, processResult } from "./fake-process.js";

const LEAKED_SECRET = "codex-contract-secret-12345";

test("Codex CLI adapter satisfies the shared adapter contract", async (t) => {
  const successTransport = new FakeProcessTransport(processResult("codex response\n"));
  const transientTransport = new FakeProcessTransport(
    processResult("", {
      stderr: `rate limit while handling ${LEAKED_SECRET}`,
      exitCode: 1,
    }),
  );
  const terminalTransport = new FakeProcessTransport(
    processResult("", {
      stderr: `authentication failed for ${LEAKED_SECRET}`,
      exitCode: 1,
    }),
  );
  const redactor = createRedactor([LEAKED_SECRET]);

  await assertAdapterContract(t, {
    expected: {
      id: "codex-cli",
      transport: "harness",
      authMode: "local-cli",
      roles: ["architect", "worker", "reviewer"],
    },
    success: createCodexCliAdapter({ transport: successTransport }),
    transientFailure: createCodexCliAdapter({
      transport: transientTransport,
      redactor,
    }),
    terminalFailure: createCodexCliAdapter({
      transport: terminalTransport,
      redactor,
    }),
    leakedSecret: LEAKED_SECRET,
  });

  assert.equal(successTransport.requests.length, 1);
  const invocation = successTransport.requests[0];
  assert.equal(invocation?.command, "codex");
  assert.deepEqual(invocation?.args, ["exec", "-"]);
  assert.ok(invocation?.stdin.includes(SAMPLE_ADAPTER_REQUEST.system));
  assert.ok(invocation?.stdin.includes(SAMPLE_ADAPTER_REQUEST.user));
});

test("Codex CLI forwards an explicit model and keeps the prompt on stdin", async () => {
  const transport = new FakeProcessTransport(processResult("ok"));
  const adapter = createCodexCliAdapter({ transport });
  const secretPrompt = "prompt-only-secret-67890";

  await adapter.run({
    ...SAMPLE_ADAPTER_REQUEST,
    model: "gpt-explicit",
    user: secretPrompt,
  });

  const invocation = transport.requests[0];
  assert.deepEqual(invocation?.args, ["exec", "--model", "gpt-explicit", "-"]);
  assert.ok(invocation?.stdin.includes(secretPrompt));
  assert.ok(!invocation?.args.some((argument) => argument.includes(secretPrompt)));
});

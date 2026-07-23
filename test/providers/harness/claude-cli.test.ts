import assert from "node:assert/strict";
import { test } from "node:test";
import { createClaudeCliAdapter } from "../../../src/providers/harness/claude-cli.js";
import { createRedactor } from "../../../src/providers/reliability.js";
import {
  assertAdapterContract,
  SAMPLE_ADAPTER_REQUEST,
} from "../contract.js";
import { FakeProcessTransport, processResult } from "./fake-process.js";

const LEAKED_SECRET = "claude-contract-secret-12345";

test("Claude Code adapter satisfies the shared adapter contract", async (t) => {
  const successTransport = new FakeProcessTransport(processResult("claude response\n"));
  const transientTransport = new FakeProcessTransport(
    processResult("", {
      stderr: `service overloaded while handling ${LEAKED_SECRET}`,
      exitCode: 1,
    }),
  );
  const terminalTransport = new FakeProcessTransport(
    processResult("", {
      stderr: `invalid model and ${LEAKED_SECRET}`,
      exitCode: 1,
    }),
  );
  const redactor = createRedactor([LEAKED_SECRET]);

  await assertAdapterContract(t, {
    expected: {
      id: "claude-cli",
      transport: "harness",
      authMode: "local-cli",
      roles: ["architect", "worker", "reviewer"],
    },
    success: createClaudeCliAdapter({ transport: successTransport }),
    transientFailure: createClaudeCliAdapter({
      transport: transientTransport,
      redactor,
    }),
    terminalFailure: createClaudeCliAdapter({
      transport: terminalTransport,
      redactor,
    }),
    leakedSecret: LEAKED_SECRET,
  });

  assert.equal(successTransport.requests.length, 1);
  const invocation = successTransport.requests[0];
  assert.equal(invocation?.command, "claude");
  assert.deepEqual(invocation?.args, ["--print", "--output-format", "text"]);
  assert.ok(invocation?.stdin.includes(SAMPLE_ADAPTER_REQUEST.system));
  assert.ok(invocation?.stdin.includes(SAMPLE_ADAPTER_REQUEST.user));
});

test("Claude Code forwards an explicit model and keeps the prompt on stdin", async () => {
  const transport = new FakeProcessTransport(processResult("ok"));
  const adapter = createClaudeCliAdapter({ transport });
  const secretPrompt = "prompt-only-secret-67890";

  await adapter.run({
    ...SAMPLE_ADAPTER_REQUEST,
    model: "claude-explicit",
    user: secretPrompt,
  });

  const invocation = transport.requests[0];
  assert.deepEqual(invocation?.args, [
    "--print",
    "--output-format",
    "text",
    "--model",
    "claude-explicit",
  ]);
  assert.ok(invocation?.stdin.includes(secretPrompt));
  assert.ok(!invocation?.args.some((argument) => argument.includes(secretPrompt)));
});

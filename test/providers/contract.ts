import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { AdapterCapabilities, AdapterRequest, ModelAdapter } from "../../src/providers/adapter.js";
import { AdapterError } from "../../src/providers/reliability.js";

/**
 * Reusable adapter contract. P03-T02 and P03-T03 build success and failure
 * adapter instances backed by faked transports and pass them here so every
 * adapter upholds the same invariants.
 */
export const SAMPLE_ADAPTER_REQUEST: AdapterRequest = {
  role: "architect",
  model: "provider-default",
  reasoning: "high",
  system: "You are DraftForge's architect.",
  user: "Return a plan.",
};

export interface AdapterContractSpec {
  readonly expected: AdapterCapabilities;
  readonly success: ModelAdapter;
  readonly transientFailure: ModelAdapter;
  readonly terminalFailure: ModelAdapter;
  /** A secret the failing adapters reference; it must never reach the error. */
  readonly leakedSecret: string;
}

export async function assertAdapterContract(t: TestContext, spec: AdapterContractSpec): Promise<void> {
  await t.test("exposes stable capabilities without side effects", () => {
    assert.deepEqual(spec.success.capabilities, spec.expected);
    assert.ok(spec.expected.roles.length > 0, "an adapter must support at least one role");
    assert.ok(["harness", "api"].includes(spec.expected.transport));
    assert.ok(["local-cli", "api-key"].includes(spec.expected.authMode));
  });

  await t.test("returns non-empty response text on success", async () => {
    const response = await spec.success.run(SAMPLE_ADAPTER_REQUEST);
    assert.equal(typeof response.text, "string");
    assert.ok(response.text.length > 0);
  });

  await t.test("classifies transient failures as retryable and redacts secrets", async () => {
    await assert.rejects(spec.transientFailure.run(SAMPLE_ADAPTER_REQUEST), (error: unknown) => {
      assert.ok(error instanceof AdapterError, "expected an AdapterError");
      assert.equal(error.retryable, true);
      assert.ok(!error.message.includes(spec.leakedSecret), "secret leaked in a transient error");
      return true;
    });
  });

  await t.test("classifies terminal failures as non-retryable and redacts secrets", async () => {
    await assert.rejects(spec.terminalFailure.run(SAMPLE_ADAPTER_REQUEST), (error: unknown) => {
      assert.ok(error instanceof AdapterError, "expected an AdapterError");
      assert.equal(error.retryable, false);
      assert.ok(!error.message.includes(spec.leakedSecret), "secret leaked in a terminal error");
      return true;
    });
  });
}

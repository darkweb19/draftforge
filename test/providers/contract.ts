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
    assert.equal(
      spec.expected.workspaceAccess,
      spec.expected.transport === "harness",
      "only local harness transports may claim workspace access",
    );
  });

  await t.test("returns non-empty response text and honest usage on success", async () => {
    // One call only. The success fixtures are backed by single-outcome fakes,
    // and callers assert their transport was invoked exactly once, so the
    // usage assertion has to share this response rather than run again.
    const response = await spec.success.run(SAMPLE_ADAPTER_REQUEST);
    assert.equal(typeof response.text, "string");
    assert.ok(response.text.length > 0);

    // Usage is reported, never estimated: API adapters surface whatever the
    // provider reported (even if every field within it is null); harness
    // adapters report nothing, and that must stay visibly absent.
    if (spec.expected.transport === "api") {
      assert.ok(response.usage !== undefined, "API adapter must report a usage object");
    } else {
      assert.equal(response.usage, undefined, "harness adapter must leave usage absent");
    }
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

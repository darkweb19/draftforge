import { test } from "node:test";
import type { AdapterCapabilities } from "../../src/providers/adapter.js";
import { AdapterError, createRedactor } from "../../src/providers/reliability.js";
import { assertAdapterContract } from "./contract.js";
import { fakeAdapter } from "./fakes.js";

const SECRET = "sk-ant-super-secret-value-1234567890";
const CAPS: AdapterCapabilities = {
  id: "anthropic-api",
  transport: "api",
  authMode: "api-key",
  roles: ["architect", "worker", "reviewer"],
};
const redactor = createRedactor([SECRET]);

test("the adapter contract suite validates a conforming fake adapter", async (t) => {
  await assertAdapterContract(t, {
    expected: CAPS,
    success: fakeAdapter({ capabilities: CAPS, onRun: async () => ({ text: "ok" }) }),
    transientFailure: fakeAdapter({
      capabilities: CAPS,
      onRun: async () => {
        throw new AdapterError(redactor(`rate limited using ${SECRET}`), true);
      },
    }),
    terminalFailure: fakeAdapter({
      capabilities: CAPS,
      onRun: async () => {
        throw new AdapterError(redactor(`unauthorized using ${SECRET}`), false);
      },
    }),
    leakedSecret: SECRET,
  });
});

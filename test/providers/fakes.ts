import type { AdapterCapabilities, AdapterRequest, ModelAdapter } from "../../src/providers/adapter.js";
import type { ModelResponse } from "../../src/application/ports.js";

export interface FakeAdapterBehavior {
  readonly capabilities: AdapterCapabilities;
  readonly onRun: (request: AdapterRequest) => Promise<ModelResponse>;
}

/** A `ModelAdapter` whose behavior is supplied by the test. */
export function fakeAdapter(behavior: FakeAdapterBehavior): ModelAdapter {
  return {
    capabilities: behavior.capabilities,
    run: (request) => behavior.onRun(request),
  };
}

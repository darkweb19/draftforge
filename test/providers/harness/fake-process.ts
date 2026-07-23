import type {
  ProcessRequest,
  ProcessResult,
  ProcessTransport,
} from "../../../src/providers/harness/process.js";

export type FakeProcessOutcome = ProcessResult | Error;

export class FakeProcessTransport implements ProcessTransport {
  readonly requests: ProcessRequest[] = [];
  readonly #outcomes: FakeProcessOutcome[];

  constructor(...outcomes: FakeProcessOutcome[]) {
    this.#outcomes = [...outcomes];
  }

  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.requests.push(request);
    const outcome = this.#outcomes.shift();
    if (outcome === undefined) {
      throw new Error("Fake process transport has no remaining outcome.");
    }
    if (outcome instanceof Error) {
      throw outcome;
    }
    return outcome;
  }
}

export function processResult(
  stdout: string,
  options: {
    readonly stderr?: string;
    readonly exitCode?: number | null;
    readonly signal?: NodeJS.Signals | null;
  } = {},
): ProcessResult {
  return {
    stdout,
    stderr: options.stderr ?? "",
    exitCode: options.exitCode ?? 0,
    signal: options.signal ?? null,
  };
}

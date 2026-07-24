import type {
  FetchLike,
  HttpRequestInit,
  HttpResponse,
} from "../../../src/providers/api/http.js";

export type FakeFetchOutcome = HttpResponse | Error;

export interface RecordedFetch {
  readonly url: string;
  readonly init: HttpRequestInit;
}

/** In-memory `fetch` used by the API adapter tests; it never touches the network. */
export class FakeFetch {
  readonly requests: RecordedFetch[] = [];
  readonly #outcomes: FakeFetchOutcome[];

  constructor(...outcomes: FakeFetchOutcome[]) {
    this.#outcomes = [...outcomes];
  }

  readonly fetch: FetchLike = async (url, init) => {
    this.requests.push({ url, init });
    const outcome = this.#outcomes.shift();
    if (outcome === undefined) {
      throw new Error("Fake fetch has no remaining outcome.");
    }
    if (outcome instanceof Error) {
      throw outcome;
    }
    return outcome;
  };
}

export function httpResponse(
  body: string,
  options: { readonly ok?: boolean; readonly status?: number } = {},
): HttpResponse {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    text: async () => body,
  };
}

/** Parse a recorded request body back into a plain object for assertions. */
export function requestBody(recorded: RecordedFetch | undefined): Record<string, unknown> {
  if (recorded === undefined) {
    throw new Error("No request was recorded.");
  }
  return JSON.parse(recorded.init.body) as Record<string, unknown>;
}

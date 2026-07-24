import { AdapterError, redact } from "../reliability.js";

/**
 * Minimal request/response surface used by the API adapters. It is a structural
 * subset of the runtime `fetch`, so the real `fetch` satisfies it while tests
 * inject an in-memory fake and never touch the network.
 */
export interface HttpRequestInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly signal?: AbortSignal;
}

export interface HttpResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export type FetchLike = (url: string, init: HttpRequestInit) => Promise<HttpResponse>;

/** The real transport: the runtime `fetch`, narrowed to the shared surface. */
export const defaultFetch: FetchLike = (url, init) => fetch(url, init);

export type ApiAdapterErrorKind =
  | "missing-key"
  | "auth"
  | "rate-limit"
  | "server"
  | "client"
  | "network"
  | "aborted"
  | "bad-response"
  | "empty-response";

/** Typed API failure suitable for retry policy and user-facing diagnostics. */
export class ApiAdapterError extends AdapterError {
  readonly kind: ApiAdapterErrorKind;
  readonly provider: string;
  readonly status: number | null;

  constructor(
    message: string,
    retryable: boolean,
    details: {
      readonly kind: ApiAdapterErrorKind;
      readonly provider: string;
      readonly status?: number | null;
      readonly cause?: unknown;
    },
  ) {
    super(message, retryable, { cause: details.cause });
    this.name = "ApiAdapterError";
    this.kind = details.kind;
    this.provider = details.provider;
    this.status = details.status ?? null;
  }
}

const MAX_DETAIL_LENGTH = 500;

export interface SendApiRequestOptions {
  readonly provider: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly fetch: FetchLike;
  readonly signal?: AbortSignal;
  readonly redactor?: (text: string) => string;
}

/**
 * Send one JSON request and map every HTTP outcome onto the common adapter
 * error contract. On a 2xx the raw response body text is returned for the
 * adapter to parse; the key never reaches an error because every message is
 * scrubbed before it is thrown.
 */
export async function sendApiRequest(options: SendApiRequestOptions): Promise<string> {
  const scrub = options.redactor ?? redact;
  let response: HttpResponse;

  try {
    response = await options.fetch(options.url, {
      method: "POST",
      headers: options.headers,
      body: JSON.stringify(options.body),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error: unknown) {
    throw mapFetchFailure(options.provider, error, scrub);
  }

  if (response.ok) {
    return await response.text();
  }

  const detail = await safeText(response);
  throw mapStatus(options.provider, response.status, detail, scrub);
}

function mapStatus(
  provider: string,
  status: number,
  detail: string,
  scrub: (text: string) => string,
): ApiAdapterError {
  const trimmed = detail.trim().slice(0, MAX_DETAIL_LENGTH);
  const suffix = trimmed.length > 0 ? `: ${trimmed}` : ".";

  if (status === 401 || status === 403) {
    return new ApiAdapterError(
      scrub(`${provider} rejected the API key (HTTP ${String(status)})${suffix}`),
      false,
      { kind: "auth", provider, status },
    );
  }
  if (status === 429) {
    return new ApiAdapterError(
      scrub(`${provider} rate limited the request (HTTP 429)${suffix}`),
      true,
      { kind: "rate-limit", provider, status },
    );
  }
  if (status >= 500) {
    return new ApiAdapterError(
      scrub(`${provider} server error (HTTP ${String(status)})${suffix}`),
      true,
      { kind: "server", provider, status },
    );
  }
  return new ApiAdapterError(
    scrub(`${provider} rejected the request (HTTP ${String(status)})${suffix}`),
    false,
    { kind: "client", provider, status },
  );
}

function mapFetchFailure(
  provider: string,
  error: unknown,
  scrub: (text: string) => string,
): ApiAdapterError {
  if (isAbort(error)) {
    return new ApiAdapterError(`${provider} request was aborted before it completed.`, true, {
      kind: "aborted",
      provider,
      cause: error,
    });
  }
  return new ApiAdapterError(
    scrub(`Unable to reach ${provider}: ${errorMessage(error)}`),
    true,
    { kind: "network", provider, cause: error },
  );
}

async function safeText(response: HttpResponse): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function isAbort(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") {
    return true;
  }
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ABORT_ERR"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

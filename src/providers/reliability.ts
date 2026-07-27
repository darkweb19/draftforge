/**
 * Shared adapter reliability: a per-call timeout, bounded retry of transient
 * failures only, and secret redaction. Adapters classify failures through
 * `AdapterError.retryable`; authentication and contract errors are never
 * retried.
 */
export class AdapterError extends Error {
  readonly retryable: boolean;
  readonly timedOut: boolean;
  readonly processId: number | undefined;
  readonly definitelyTerminated: boolean | undefined;

  constructor(
    message: string,
    retryable: boolean,
    options: {
      readonly cause?: unknown;
      readonly timedOut?: boolean;
      readonly processId?: number;
      readonly definitelyTerminated?: boolean;
    } = {},
  ) {
    super(message, options);
    this.name = "AdapterError";
    this.retryable = retryable;
    this.timedOut = options.timedOut ?? false;
    this.processId = options.processId;
    this.definitelyTerminated = options.definitelyTerminated;
  }
}

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_RETRY_DELAY_MS = 200;
const SECRET_ENV_NAME = /(?:api.?key|authorization|credential|password|secret|token)/iu;

const REDACTIONS: ReadonlyArray<{ readonly pattern: RegExp; readonly replacement: string }> = [
  { pattern: /sk-ant-[A-Za-z0-9_-]{8,}/g, replacement: "[REDACTED]" },
  { pattern: /sk-[A-Za-z0-9_-]{8,}/g, replacement: "[REDACTED]" },
  { pattern: /(authorization\s*:\s*bearer\s+)\S+/gi, replacement: "$1[REDACTED]" },
  { pattern: /(x-api-key\s*:\s*)\S+/gi, replacement: "$1[REDACTED]" },
];

/** Replace known secret material — literal values first, then key patterns. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length > 0) {
      result = result.split(secret).join("[REDACTED]");
    }
  }
  for (const { pattern, replacement } of REDACTIONS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export function createRedactor(secrets: readonly string[] = []): (text: string) => string {
  const literals = [...new Set(secrets)].filter((secret) => secret.length > 0);
  return (text) => redact(text, literals);
}

export function secretsFromEnv(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return Object.entries(env)
    .filter(([name, value]) => SECRET_ENV_NAME.test(name) && typeof value === "string")
    .map(([, value]) => value as string)
    .filter((value) => value.length > 0);
}

export interface ReliabilityOptions {
  readonly timeoutMs: number;
  readonly attempts?: number;
  readonly delayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly redactor?: (text: string) => string;
  readonly processMetadata?: () => {
    readonly processId: number | undefined;
    readonly definitelyTerminated: boolean;
  };
}

/** Reject with a retryable timeout error, aborting the operation's signal. */
export function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  processMetadata?: ReliabilityOptions["processMetadata"],
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      const process = processMetadata?.();
      reject(new AdapterError(`Adapter call timed out after ${timeoutMs}ms.`, true, {
        timedOut: true,
        ...(process?.processId === undefined ? {} : { processId: process.processId }),
        definitelyTerminated: process?.definitelyTerminated ?? true,
      }));
    }, timeoutMs);

    operation(controller.signal).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export async function withReliability<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: ReliabilityOptions,
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_MAX_ATTEMPTS);
  const delayMs = options.delayMs ?? DEFAULT_RETRY_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await withTimeout(operation, options.timeoutMs, options.processMetadata);
    } catch (error: unknown) {
      lastError = error;
      if (!isRetryable(error) || attempt === attempts) {
        break;
      }
      await sleep(delayMs * attempt);
    }
  }

  throw redactError(lastError, options.redactor);
}

function isRetryable(error: unknown): boolean {
  return error instanceof AdapterError && error.retryable;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function redactError(error: unknown, redactor?: (text: string) => string): Error {
  const base = error instanceof Error ? error : new Error(String(error));
  if (redactor === undefined) {
    return base;
  }
  const message = redactor(base.message);
  if (base instanceof AdapterError) {
    return new AdapterError(message, base.retryable, {
      cause: base.cause,
      timedOut: base.timedOut,
      ...(base.processId === undefined ? {} : { processId: base.processId }),
      ...(base.definitelyTerminated === undefined
        ? {}
        : { definitelyTerminated: base.definitelyTerminated }),
    });
  }
  const redacted = new Error(message);
  redacted.name = base.name;
  return redacted;
}

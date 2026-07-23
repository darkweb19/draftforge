import { spawn } from "node:child_process";
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from "node:child_process";
import { AdapterError, redact } from "../reliability.js";

export interface ProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin: string;
  readonly signal?: AbortSignal;
}

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** Injectable boundary used by harness adapters; tests provide an in-memory fake. */
export interface ProcessTransport {
  run(request: ProcessRequest): Promise<ProcessResult>;
}

export type ProcessTransportErrorKind = "missing-command" | "aborted" | "spawn";

export class ProcessTransportError extends Error {
  readonly kind: ProcessTransportErrorKind;
  readonly code: string | undefined;

  constructor(
    message: string,
    kind: ProcessTransportErrorKind,
    options: { readonly cause?: unknown; readonly code?: string } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ProcessTransportError";
    this.kind = kind;
    this.code = options.code;
  }
}

export type HarnessAdapterErrorKind =
  | "missing-command"
  | "aborted"
  | "spawn"
  | "non-zero-exit"
  | "empty-response";

/** Typed adapter failure suitable for retry policy and user-facing diagnostics. */
export class HarnessAdapterError extends AdapterError {
  readonly kind: HarnessAdapterErrorKind;
  readonly command: string;
  readonly exitCode: number | null;

  constructor(
    message: string,
    retryable: boolean,
    details: {
      readonly kind: HarnessAdapterErrorKind;
      readonly command: string;
      readonly exitCode?: number | null;
      readonly cause?: unknown;
    },
  ) {
    super(message, retryable, { cause: details.cause });
    this.name = "HarnessAdapterError";
    this.kind = details.kind;
    this.command = details.command;
    this.exitCode = details.exitCode ?? null;
  }
}

export type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface ProcessTransportOptions {
  readonly spawn?: SpawnProcess;
}

/**
 * Create the real local child-process boundary. No shell is involved and all
 * prompt content is written to stdin rather than exposed in process arguments.
 */
export function createProcessTransport(options: ProcessTransportOptions = {}): ProcessTransport {
  const spawnProcess = options.spawn ?? spawn;

  return {
    run(request): Promise<ProcessResult> {
      if (request.signal?.aborted === true) {
        return Promise.reject(
          new ProcessTransportError(`Command "${request.command}" was aborted.`, "aborted"),
        );
      }

      return new Promise<ProcessResult>((resolve, reject) => {
        let child: ChildProcessWithoutNullStreams;
        try {
          child = spawnProcess(request.command, request.args, {
            shell: false,
            stdio: "pipe",
            windowsHide: true,
          });
        } catch (error: unknown) {
          reject(toProcessTransportError(request.command, error));
          return;
        }

        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let settled = false;

        const cleanup = (): void => {
          request.signal?.removeEventListener("abort", onAbort);
        };
        const rejectOnce = (error: ProcessTransportError): void => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          reject(error);
        };
        const onAbort = (): void => {
          try {
            child.kill();
          } catch {
            // The operation still rejects promptly if a platform cannot kill
            // an already-exited child.
          }
          rejectOnce(new ProcessTransportError(`Command "${request.command}" was aborted.`, "aborted"));
        };

        request.signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout.on("data", (chunk: Buffer | string) => {
          stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        child.stderr.on("data", (chunk: Buffer | string) => {
          stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        // A child may close stdin before consuming the whole prompt. Its exit
        // status/stderr is the useful diagnostic, so prevent an unhandled EPIPE.
        child.stdin.on("error", () => undefined);
        child.on("error", (error: Error) => {
          rejectOnce(toProcessTransportError(request.command, error));
        });
        child.on("close", (exitCode, signal) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          resolve({
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            exitCode,
            signal,
          });
        });

        // Cover an abort that happened after the pre-spawn check but before
        // the listener was registered.
        if (request.signal?.aborted === true) {
          onAbort();
        }
        if (!settled) {
          child.stdin.end(request.stdin, "utf8");
        }
      });
    },
  };
}

export interface RunHarnessProcessOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin: string;
  readonly signal?: AbortSignal;
  readonly transport: ProcessTransport;
  readonly redactor?: (text: string) => string;
}

/**
 * Run one harness command and map every process outcome into the common adapter
 * error contract. The returned text is the CLI's raw stdout.
 */
export async function runHarnessProcess(options: RunHarnessProcessOptions): Promise<string> {
  const scrub = options.redactor ?? redact;
  let result: ProcessResult;

  try {
    result = await options.transport.run({
      command: options.command,
      args: options.args,
      stdin: options.stdin,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error: unknown) {
    throw mapTransportFailure(options.command, error, scrub);
  }

  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "No diagnostic output.";
    const retryable = isTransientFailure(result.exitCode, result.signal, detail);
    throw new HarnessAdapterError(
      scrub(`${options.command} exited with code ${String(result.exitCode)}: ${detail}`),
      retryable,
      {
        kind: "non-zero-exit",
        command: options.command,
        exitCode: result.exitCode,
      },
    );
  }

  if (result.stdout.trim().length === 0) {
    throw new HarnessAdapterError(`${options.command} returned an empty response.`, false, {
      kind: "empty-response",
      command: options.command,
    });
  }

  return result.stdout;
}

function toProcessTransportError(command: string, error: unknown): ProcessTransportError {
  const code = errorCode(error);
  const kind: ProcessTransportErrorKind = code === "ENOENT" ? "missing-command" : "spawn";
  const message =
    kind === "missing-command"
      ? `Command "${command}" was not found.`
      : `Unable to start command "${command}": ${errorMessage(error)}`;
  return new ProcessTransportError(message, kind, {
    cause: error,
    ...(code === undefined ? {} : { code }),
  });
}

function mapTransportFailure(
  command: string,
  error: unknown,
  scrub: (text: string) => string,
): HarnessAdapterError {
  const kind = transportFailureKind(error);
  const retryable =
    kind === "aborted" || (kind === "spawn" && isTransientSpawnCode(errorCode(error)));
  const message =
    kind === "missing-command"
      ? `Required local command "${command}" was not found. Install it and authenticate locally.`
      : kind === "aborted"
        ? `${command} was aborted before it completed.`
        : `Unable to start ${command}: ${errorMessage(error)}`;

  return new HarnessAdapterError(scrub(message), retryable, {
    kind,
    command,
    cause: error,
  });
}

function transportFailureKind(error: unknown): "missing-command" | "aborted" | "spawn" {
  if (error instanceof ProcessTransportError) {
    return error.kind;
  }
  if (errorCode(error) === "ENOENT") {
    return "missing-command";
  }
  if (
    errorCode(error) === "ABORT_ERR" ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return "aborted";
  }
  return "spawn";
}

function isTransientSpawnCode(code: string | undefined): boolean {
  return code === "EAGAIN" || code === "ENOMEM" || code === "ETIMEDOUT";
}

function isTransientFailure(
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  detail: string,
): boolean {
  if (signal !== null || exitCode === 75 || exitCode === 124 || exitCode === 137 || exitCode === 143) {
    return true;
  }
  return /(?:timed?\s*out|timeout|rate.?limit|too many requests|\b429\b|\b5\d\d\b|overloaded|temporar(?:y|ily)|unavailable|network|connection (?:reset|refused)|eai_again|enotfound)/i.test(
    detail,
  );
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

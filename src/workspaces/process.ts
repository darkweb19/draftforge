import { spawn } from "node:child_process";
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from "node:child_process";
import type { ProcessLiveness } from "../application/workspace.js";

export interface GitProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export interface GitProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /** A normally closed process is known to be terminated. */
  readonly definitelyTerminated: boolean;
  readonly processId: number | undefined;
}

export type GitProcessErrorKind = "aborted" | "missing-command" | "spawn";

/**
 * An aborted child is deliberately reported as uncertain until its close event
 * is observed. A caller must retain the workspace rather than race another
 * worker into it.
 */
export class GitProcessError extends Error {
  readonly kind: GitProcessErrorKind;
  readonly processId: number | undefined;
  readonly definitelyTerminated: boolean;

  constructor(
    message: string,
    details: {
      readonly kind: GitProcessErrorKind;
      readonly processId?: number;
      readonly definitelyTerminated: boolean;
      readonly cause?: unknown;
    },
  ) {
    super(message, { cause: details.cause });
    this.name = "GitProcessError";
    this.kind = details.kind;
    this.processId = details.processId;
    this.definitelyTerminated = details.definitelyTerminated;
  }
}

/** Injectable, shell-free local-process boundary used by the Git adapter. */
export interface GitProcessTransport {
  run(request: GitProcessRequest): Promise<GitProcessResult>;
  liveness(processId: number): Promise<ProcessLiveness>;
}

export type SpawnGitProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface GitProcessTransportOptions {
  readonly spawn?: SpawnGitProcess;
  readonly liveness?: (processId: number) => ProcessLiveness;
}

export function createGitProcessTransport(
  options: GitProcessTransportOptions = {},
): GitProcessTransport {
  const spawnProcess = options.spawn ?? spawn;
  const inspectLiveness = options.liveness ?? defaultProcessLiveness;

  return {
    run(request): Promise<GitProcessResult> {
      if (request.signal?.aborted === true) {
        return Promise.reject(
          new GitProcessError(`Git command "${request.command}" was aborted.`, {
            kind: "aborted",
            definitelyTerminated: true,
          }),
        );
      }

      return new Promise<GitProcessResult>((resolve, reject) => {
        let child: ChildProcessWithoutNullStreams;
        try {
          child = spawnProcess(request.command, request.args, {
            cwd: request.cwd,
            shell: false,
            stdio: "pipe",
            windowsHide: true,
            windowsVerbatimArguments: false,
          });
        } catch (error: unknown) {
          reject(toGitProcessError(request.command, error));
          return;
        }

        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let settled = false;
        const processId = child.pid;
        const cleanup = (): void => request.signal?.removeEventListener("abort", onAbort);
        const rejectOnce = (error: GitProcessError): void => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          reject(error);
        };
        const onAbort = (): void => {
          let killed = false;
          try {
            killed = child.kill();
          } catch {
            // A process that cannot be signalled is unsafe to reuse.
          }
          rejectOnce(
            new GitProcessError(`Git command "${request.command}" was aborted.`, {
              kind: "aborted",
              ...(processId === undefined ? {} : { processId }),
              definitelyTerminated: false,
              cause: killed ? undefined : new Error("Unable to signal Git child process."),
            }),
          );
        };

        request.signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout.on("data", (chunk: Buffer | string) => {
          stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        child.stderr.on("data", (chunk: Buffer | string) => {
          stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        child.stdin.on("error", () => undefined);
        child.on("error", (error: Error) => rejectOnce(toGitProcessError(request.command, error, processId)));
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
            definitelyTerminated: true,
            processId,
          });
        });
        if (request.signal?.aborted === true) {
          onAbort();
        }
        if (!settled) {
          child.stdin.end();
        }
      });
    },
    async liveness(processId): Promise<ProcessLiveness> {
      return inspectLiveness(processId);
    },
  };
}

function defaultProcessLiveness(processId: number): ProcessLiveness {
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    return "unknown";
  }
  try {
    process.kill(processId, 0);
    return "alive";
  } catch (error: unknown) {
    if (isMissingProcessError(error)) {
      return "not-found";
    }
    return "unknown";
  }
}

function toGitProcessError(
  command: string,
  error: unknown,
  processId?: number,
): GitProcessError {
  const code = isNodeError(error) ? error.code : undefined;
  return new GitProcessError(
    code === "ENOENT" ? `Git executable "${command}" was not found.` : `Git command "${command}" could not start.`,
    {
      kind: code === "ENOENT" ? "missing-command" : "spawn",
      ...(processId === undefined ? {} : { processId }),
      definitelyTerminated: processId === undefined,
      cause: error,
    },
  );
}

function isMissingProcessError(error: unknown): boolean {
  return isNodeError(error) && error.code === "ESRCH";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

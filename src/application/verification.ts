import type {
  ProcessRequest,
  ProcessResult,
  ProcessTransport,
} from "../providers/harness/process.js";
import { createRedactor, secretsFromEnv } from "../providers/reliability.js";
import type {
  AttemptVerification,
  FailureClassification,
  VerificationCommandResult,
} from "../domain/execution.js";
import type { VerificationCommand } from "../domain/verification.js";

export interface VerificationRunInput {
  readonly commands: readonly VerificationCommand[];
  /** Absolute path to the attempt worktree. Commands run here, never the project root. */
  readonly worktreePath: string;
  readonly transport: ProcessTransport;
  readonly timeoutMs: number;
  /** Persists a redacted transcript and returns its project-relative path. */
  readonly persistTranscript: (index: number, command: string, contents: string) => Promise<string>;
  readonly redact?: (text: string) => string;
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
}

/** Truncated transcripts keep the head and tail; failures print at the end. */
const MAX_TRANSCRIPT_BYTES = 64 * 1024;
const TRUNCATION_MARKER = "\n...[transcript truncated]...\n";

const POSIX_ENV_ALLOWLIST: readonly string[] = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP"];
const WINDOWS_ONLY_ENV_ALLOWLIST: readonly string[] = [
  "SystemRoot",
  "SystemDrive",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
];
/**
 * Mirrors the private `SECRET_ENV_NAME` pattern in providers/reliability.ts.
 * That constant is not exported and this module does not own reliability.ts,
 * so this is a read-only local copy used only for the defensive checks below.
 */
const CREDENTIAL_ENV_NAME = /(?:api.?key|authorization|credential|password|secret|token)/iu;

/** Converts `limits.taskTimeoutMinutes` so the caller cannot get the unit wrong. */
export function verificationTimeoutMs(taskTimeoutMinutes: number): number {
  if (!Number.isFinite(taskTimeoutMinutes) || taskTimeoutMinutes <= 0) {
    throw new Error("taskTimeoutMinutes must be a positive finite number.");
  }
  return taskTimeoutMinutes * 60_000;
}

/**
 * Run a contract's allowlisted verification commands sequentially inside the
 * attempt worktree. Stops at the first failure: a later command's result is
 * meaningless once an earlier one failed, so only the commands that actually
 * ran are recorded.
 */
export async function runVerification(input: VerificationRunInput): Promise<AttemptVerification> {
  if (input.timeoutMs <= 0) {
    throw new Error("Verification timeoutMs must be positive.");
  }
  const now = input.now ?? ((): Date => new Date());
  const env = input.env ?? process.env;
  const redact = input.redact ?? createRedactor(secretsFromEnv(env));
  const childEnv = buildMinimalEnv(env, process.platform);

  const results: VerificationCommandResult[] = [];
  let classification: FailureClassification | null = null;

  for (const [index, command] of input.commands.entries()) {
    const outcome = await runOneCommand(input.transport, command, input.worktreePath, childEnv, input.timeoutMs);
    const transcript = buildTranscript(command, outcome, redact);
    const transcriptPath = await input.persistTranscript(index, command.declared, transcript);
    results.push({
      command: command.declared,
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      timedOut: outcome.timedOut,
      terminated: outcome.terminated,
      transcriptPath,
    });
    if (outcome.classification !== null) {
      classification = outcome.classification;
      break;
    }
  }

  return {
    status: classification === null ? "passed" : "failed",
    classification,
    commands: results,
    completedAt: now().toISOString(),
  };
}

interface CommandOutcome {
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly terminated: boolean;
  readonly classification: FailureClassification | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Present only when the command never produced normal stdout/stderr. */
  readonly diagnostic: string | null;
}

async function runOneCommand(
  transport: ProcessTransport,
  command: VerificationCommand,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<CommandOutcome> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const request: ProcessRequest = {
    command: command.program,
    args: command.args,
    stdin: "",
    cwd,
    signal: controller.signal,
    env,
  };
  const startedAt = Date.now();
  try {
    const result: ProcessResult = await transport.run(request);
    clearTimeout(timer);
    const durationMs = Date.now() - startedAt;
    return {
      exitCode: result.exitCode,
      durationMs,
      timedOut: false,
      terminated: result.definitelyTerminated,
      classification: result.exitCode === 0 ? null : "verification-failure",
      stdout: result.stdout,
      stderr: result.stderr,
      diagnostic: null,
    };
  } catch (error: unknown) {
    clearTimeout(timer);
    const durationMs = Date.now() - startedAt;
    const terminated = definitelyTerminatedOf(error);
    return {
      exitCode: null,
      durationMs,
      timedOut,
      // A transport error before the process could report an exit status
      // never leaves anything running, so absent evidence defaults to
      // terminated; a real abort reports its own (possibly uncertain) flag.
      terminated: terminated ?? true,
      classification: timedOut ? "timeout" : "contract-violation",
      stdout: "",
      stderr: "",
      diagnostic: messageOf(error),
    };
  }
}

function definitelyTerminatedOf(error: unknown): boolean | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "definitelyTerminated" in error &&
    typeof (error as { definitelyTerminated: unknown }).definitelyTerminated === "boolean"
  ) {
    return (error as { definitelyTerminated: boolean }).definitelyTerminated;
  }
  return undefined;
}

function buildTranscript(
  command: VerificationCommand,
  outcome: CommandOutcome,
  redact: (text: string) => string,
): string {
  const parts = [`$ ${command.declared}`, ""];
  if (outcome.diagnostic !== null) {
    parts.push("--- error ---", outcome.diagnostic, "");
  }
  parts.push("--- stdout ---", outcome.stdout, "", "--- stderr ---", outcome.stderr, "");
  return truncateTranscript(redact(parts.join("\n")), MAX_TRANSCRIPT_BYTES);
}

/** Keeps the head and the tail; the tail matters because failures print last. */
function truncateTranscript(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return text;
  }
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  const remaining = Math.max(0, maxBytes - markerBytes);
  const headBytes = Math.ceil(remaining / 2);
  const tailBytes = remaining - headBytes;
  const head = buffer.subarray(0, headBytes).toString("utf8");
  const tail = buffer.subarray(buffer.byteLength - tailBytes).toString("utf8");
  return `${head}${TRUNCATION_MARKER}${tail}`;
}

function buildMinimalEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const allowlist = platform === "win32" ? [...POSIX_ENV_ALLOWLIST, ...WINDOWS_ONLY_ENV_ALLOWLIST] : POSIX_ENV_ALLOWLIST;
  const secretValues = new Set(secretsFromEnv(env));
  const child: Record<string, string> = {};
  for (const name of allowlist) {
    const value = env[name];
    if (value === undefined) {
      continue;
    }
    // Defensive: the allowlist above is a fixed, known-safe set of names, but
    // assert at both the name and value level so a careless future edit to
    // the allowlist, or an unusual parent environment, can never forward a
    // credential-shaped variable to a verification command's child process.
    if (CREDENTIAL_ENV_NAME.test(name) || secretValues.has(value)) {
      throw new Error(`Refusing to forward environment variable "${name}": it matches a credential pattern.`);
    }
    child[name] = value;
  }
  return child;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

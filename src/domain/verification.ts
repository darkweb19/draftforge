/**
 * Pure, I/O-free contracts for machine-first review (ADR 0010): the
 * content-derived diff an attempt is judged against, and the allowlisted,
 * shell-free command shapes a task contract's `## Verification` section may
 * declare. Extraction here is strict validation of untrusted contract text,
 * so a malformed or unlisted command never reaches a process boundary.
 */

/** Authoritative content-derived diff for an attempt, supplied by the caller. */
export interface AttemptDiff {
  readonly changedPaths: readonly string[];
  /** Unified diff text. */
  readonly patch: string;
}

/** An allowlisted, shell-free command parsed from a task contract. */
export interface VerificationCommand {
  /** The literal declared string, preserved for evidence. */
  readonly declared: string;
  readonly program: "npm" | "node";
  readonly args: readonly string[];
}

export interface CommandParseFailure {
  readonly declared: string;
  readonly reason: string;
}

export type VerificationCommandPlan =
  | { readonly kind: "ok"; readonly commands: readonly VerificationCommand[] }
  | { readonly kind: "contract-violation"; readonly failures: readonly CommandParseFailure[] };

/** `npm run <script>`: exactly three tokens, a safe script-name shape. */
const NPM_SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;
/** Additional `node` arguments: literal-looking tokens only. */
const NODE_ARG = /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/;
/** Any of these anywhere in a declared span makes it unspawnable-by-design. */
const SHELL_METACHARACTERS = /[;&|<>$`(){}[\]*?!~\\'"]/;
const CONTROL_CHARACTERS = /[\n\r]/;
const BACKTICK_SPAN = /`([^`]*)`/g;

/**
 * Extract every backtick-quoted command span from a contract's `## Verification`
 * bullets, in order, and validate each against the shell-free allowlist. Every
 * failure is collected (never short-circuited) so an operator sees every bad
 * command at once. An empty `verification` array, or one where no bullet
 * declares a backtick span, is itself a contract violation: silent pass is
 * never an option.
 */
export function parseVerificationCommands(verification: readonly string[]): VerificationCommandPlan {
  const spans: string[] = [];
  for (const bullet of verification) {
    for (const match of bullet.matchAll(BACKTICK_SPAN)) {
      spans.push(match[1] ?? "");
    }
  }
  if (spans.length === 0) {
    return {
      kind: "contract-violation",
      failures: [
        {
          declared: "",
          reason: "No `## Verification` bullet declares a backtick-quoted command.",
        },
      ],
    };
  }

  const commands: VerificationCommand[] = [];
  const failures: CommandParseFailure[] = [];
  for (const span of spans) {
    const outcome = parseOneCommand(span);
    if ("reason" in outcome) {
      failures.push(outcome);
    } else {
      commands.push(outcome);
    }
  }
  return failures.length > 0
    ? { kind: "contract-violation", failures }
    : { kind: "ok", commands };
}

function parseOneCommand(declared: string): VerificationCommand | CommandParseFailure {
  if (declared.length === 0) {
    return { declared, reason: "Command must not be empty." };
  }
  if (CONTROL_CHARACTERS.test(declared) || declared.includes("\u0000")) {
    return { declared, reason: "Command must not contain a newline, carriage return, or NUL byte." };
  }
  if (declared !== declared.trim()) {
    return { declared, reason: "Command must not have leading or trailing whitespace." };
  }
  if (SHELL_METACHARACTERS.test(declared)) {
    return { declared, reason: "Command contains a shell metacharacter." };
  }
  // Tokenize on runs of single spaces only. If splitting on " " and rejoining
  // does not reproduce the original span, a tab or repeated space was used to
  // smuggle intent past a naive whitespace split.
  const tokens = declared.split(" ");
  if (tokens.join(" ") !== declared || tokens.some((token) => token.length === 0)) {
    return { declared, reason: "Command tokenization is ambiguous (tabs or repeated spaces)." };
  }

  const [program, ...rest] = tokens;
  if (program === "npm") {
    return parseNpmCommand(declared, rest);
  }
  if (program === "node") {
    return parseNodeCommand(declared, rest);
  }
  return { declared, reason: `Only "npm" and "node" are allowlisted programs, found "${program ?? ""}".` };
}

function parseNpmCommand(declared: string, rest: readonly string[]): VerificationCommand | CommandParseFailure {
  if (rest.length !== 2 || rest[0] !== "run") {
    return { declared, reason: 'npm commands must be exactly `npm run <script>`.' };
  }
  const script = rest[1];
  if (script === undefined || !NPM_SCRIPT_NAME.test(script)) {
    return { declared, reason: "npm script name is not allowlisted." };
  }
  return { declared, program: "npm", args: ["run", script] };
}

function parseNodeCommand(declared: string, rest: readonly string[]): VerificationCommand | CommandParseFailure {
  const path = rest[0];
  if (path === undefined) {
    return { declared, reason: "node commands require a project-relative path." };
  }
  if (!isSafeProjectRelativePath(path)) {
    return { declared, reason: "node path must be project-relative, with no leading slash, drive letter, `..` segment, or `~`." };
  }
  const args = rest.slice(1);
  const badArg = args.find((arg) => !NODE_ARG.test(arg));
  if (badArg !== undefined) {
    return { declared, reason: "node argument is not allowlisted." };
  }
  return { declared, program: "node", args: [path, ...args] };
}

function isSafeProjectRelativePath(path: string): boolean {
  if (path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:/.test(path)) {
    return false;
  }
  return !path.split("/").includes("..");
}

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseVerificationCommands,
  type VerificationCommand,
} from "../src/domain/verification.js";
import {
  runVerification,
  verificationTimeoutMs,
  type VerificationRunInput,
} from "../src/application/verification.js";
import type {
  ProcessRequest,
  ProcessResult,
  ProcessTransport,
} from "../src/providers/harness/process.js";

const NOW = new Date("2026-07-29T00:00:00.000Z");
const MAX_TRANSCRIPT_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Domain: parseVerificationCommands — extraction and allowlist
// ---------------------------------------------------------------------------

test("extracts a single backtick-quoted npm command from a bullet", () => {
  const plan = parseVerificationCommands(["Run `npm run test` before merging."]);
  assert.equal(plan.kind, "ok");
  if (plan.kind === "ok") {
    assert.deepEqual(plan.commands, [
      { declared: "npm run test", program: "npm", args: ["run", "test"] },
    ]);
  }
});

test("extracts multiple backtick spans from a single bullet, in order", () => {
  const plan = parseVerificationCommands(["Run `npm run lint` then `npm run test`."]);
  assert.equal(plan.kind, "ok");
  if (plan.kind === "ok") {
    assert.deepEqual(
      plan.commands.map((c) => c.declared),
      ["npm run lint", "npm run test"],
    );
  }
});

test("extracts backtick spans across multiple bullets, preserving order", () => {
  const plan = parseVerificationCommands(["First `npm run lint`.", "Second `node scripts/check.js`."]);
  assert.equal(plan.kind, "ok");
  if (plan.kind === "ok") {
    assert.deepEqual(
      plan.commands.map((c) => c.declared),
      ["npm run lint", "node scripts/check.js"],
    );
  }
});

test("parses a valid node command with literal alphanumeric arguments", () => {
  const plan = parseVerificationCommands(["Run `node scripts/check.js run`."]);
  assert.equal(plan.kind, "ok");
  if (plan.kind === "ok") {
    assert.deepEqual(plan.commands, [
      { declared: "node scripts/check.js run", program: "node", args: ["scripts/check.js", "run"] },
    ]);
  }
});

test("an empty verification array is a contract violation", () => {
  const plan = parseVerificationCommands([]);
  assert.equal(plan.kind, "contract-violation");
});

test("bullets with no backtick-quoted span at all are a contract violation", () => {
  const plan = parseVerificationCommands(["Run the tests and make sure they pass."]);
  assert.equal(plan.kind, "contract-violation");
});

test("collects every failure rather than short-circuiting on the first", () => {
  const plan = parseVerificationCommands(["Run `bash deploy.sh`.", "Then `npm test extra`."]);
  assert.equal(plan.kind, "contract-violation");
  if (plan.kind === "contract-violation") {
    assert.equal(plan.failures.length, 2);
  }
});

for (const bad of [
  "npm run test; rm -rf /",
  "npm run test | cat",
  "npm run test > out.txt",
  "npm run test < in.txt",
  "npm run test && echo done",
  "npm run test $(whoami)",
  "npm run `id`",
  "npm run test & echo bg",
]) {
  test(`rejects a shell-metacharacter command as a contract violation: ${bad}`, () => {
    const plan = parseVerificationCommands([`Run \`${bad}\`.`]);
    assert.equal(plan.kind, "contract-violation");
  });
}

test("rejects an env-var-prefixed command; the program token is not npm/node", () => {
  const plan = parseVerificationCommands(["Run `FOO=bar npm run test`."]);
  assert.equal(plan.kind, "contract-violation");
  if (plan.kind === "contract-violation") {
    assert.match(plan.failures[0]?.reason ?? "", /Only "npm" and "node"/);
  }
});

test("rejects an arbitrary binary that is not npm or node", () => {
  const plan = parseVerificationCommands(["Run `bash deploy.sh`."]);
  assert.equal(plan.kind, "contract-violation");
  if (plan.kind === "contract-violation") {
    assert.match(plan.failures[0]?.reason ?? "", /Only "npm" and "node"/);
  }
});

test("rejects npm subcommands other than run", () => {
  const plan = parseVerificationCommands(["Run `npm install left-pad`."]);
  assert.equal(plan.kind, "contract-violation");
});

test("rejects npm run with a trailing extra argument", () => {
  const plan = parseVerificationCommands(["Run `npm run test -- --bail`."]);
  assert.equal(plan.kind, "contract-violation");
});

test("rejects a node command with an absolute path", () => {
  const plan = parseVerificationCommands(["Run `node /etc/passwd`."]);
  assert.equal(plan.kind, "contract-violation");
});

test("rejects a node command with a parent-traversal path", () => {
  const plan = parseVerificationCommands(["Run `node ../evil.js`."]);
  assert.equal(plan.kind, "contract-violation");
});

test("rejects a node argument that begins with a hyphen (flags are not literal args)", () => {
  const plan = parseVerificationCommands(["Run `node scripts/check.js --flag`."]);
  assert.equal(plan.kind, "contract-violation");
});

test("rejects a command with tab/repeated-space tokenization ambiguity", () => {
  const plan = parseVerificationCommands(["Run `npm  run test`."]);
  assert.equal(plan.kind, "contract-violation");
});

test("rejects a command containing a control character smuggled inside a backtick span", () => {
  const plan = parseVerificationCommands(["Run `npm run test\nrm -rf /`."]);
  assert.equal(plan.kind, "contract-violation");
});

test("rejects an empty backtick span", () => {
  const plan = parseVerificationCommands(["Run `` for nothing."]);
  assert.equal(plan.kind, "contract-violation");
});

// ---------------------------------------------------------------------------
// Application: runVerification — transport fakes
// ---------------------------------------------------------------------------

function npmCommand(script = "test"): VerificationCommand {
  return { declared: `npm run ${script}`, program: "npm", args: ["run", script] };
}

function okResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    stdout: "ok\n",
    stderr: "",
    exitCode: 0,
    signal: null,
    processId: 4242,
    definitelyTerminated: true,
    ...overrides,
  };
}

function fixedTransport(result: ProcessResult | ((request: ProcessRequest) => ProcessResult)): ProcessTransport {
  return {
    async run(request: ProcessRequest): Promise<ProcessResult> {
      return typeof result === "function" ? result(request) : result;
    },
  };
}

interface CollectedTranscript {
  readonly index: number;
  readonly command: string;
  readonly contents: string;
}

function collectingPersist(): {
  readonly persist: VerificationRunInput["persistTranscript"];
  readonly transcripts: CollectedTranscript[];
} {
  const transcripts: CollectedTranscript[] = [];
  return {
    transcripts,
    persist: async (index, command, contents) => {
      transcripts.push({ index, command, contents });
      return `runs/x/transcript-${String(index)}.txt`;
    },
  };
}

function baseInput(overrides: Partial<VerificationRunInput> = {}): VerificationRunInput {
  const { persist } = collectingPersist();
  return {
    commands: [npmCommand()],
    worktreePath: "/work/attempt",
    transport: fixedTransport(okResult()),
    timeoutMs: 5_000,
    persistTranscript: persist,
    now: () => NOW,
    env: { PATH: "/usr/bin" },
    ...overrides,
  };
}

test("a successful command produces status passed with a null classification", async () => {
  const result = await runVerification(baseInput());
  assert.equal(result.status, "passed");
  assert.equal(result.classification, null);
  assert.equal(result.commands.length, 1);
  assert.equal(result.commands[0]?.exitCode, 0);
  assert.equal(result.commands[0]?.terminated, true);
  assert.equal(result.commands[0]?.timedOut, false);
});

test("a failed command produces status failed with a non-null classification", async () => {
  const result = await runVerification(
    baseInput({ transport: fixedTransport(okResult({ exitCode: 1, stderr: "boom" })) }),
  );
  assert.equal(result.status, "failed");
  assert.equal(result.classification, "verification-failure");
  assert.equal(result.commands[0]?.exitCode, 1);
});

test("stops at the first failure and never runs a later command", async () => {
  let calls = 0;
  const transport = fixedTransport((request) => {
    calls += 1;
    return okResult({ exitCode: request.args.includes("first") ? 1 : 0 });
  });
  const result = await runVerification(
    baseInput({
      commands: [npmCommand("first"), npmCommand("second")],
      transport,
    }),
  );
  assert.equal(calls, 1);
  assert.equal(result.commands.length, 1);
  assert.equal(result.status, "failed");
});

test("an abort-driven uncertain failure records exitCode null, timedOut true, terminated false, classified timeout", async () => {
  const transport: ProcessTransport = {
    run(request: ProcessRequest): Promise<ProcessResult> {
      return new Promise((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => {
          const error = Object.assign(new Error("aborted"), { definitelyTerminated: false });
          reject(error);
        });
      });
    },
  };
  const result = await runVerification(baseInput({ transport, timeoutMs: 15 }));
  assert.equal(result.status, "failed");
  assert.equal(result.classification, "timeout");
  const command = result.commands[0];
  assert.equal(command?.exitCode, null);
  assert.equal(command?.timedOut, true);
  assert.equal(command?.terminated, false);
});

test("a non-abort transport error records exitCode null, timedOut false, classified contract-violation, and defaults terminated true when unknown", async () => {
  const transport: ProcessTransport = {
    async run(): Promise<ProcessResult> {
      throw new Error("spawn EACCES");
    },
  };
  const result = await runVerification(baseInput({ transport, timeoutMs: 5_000 }));
  assert.equal(result.status, "failed");
  assert.equal(result.classification, "contract-violation");
  const command = result.commands[0];
  assert.equal(command?.exitCode, null);
  assert.equal(command?.timedOut, false);
  assert.equal(command?.terminated, true);
});

test("exitCode null / timedOut / terminated uncertainty is never coerced to a passing status", async () => {
  const transport: ProcessTransport = {
    run(request: ProcessRequest): Promise<ProcessResult> {
      return new Promise((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { definitelyTerminated: false }));
        });
      });
    },
  };
  const result = await runVerification(baseInput({ transport, timeoutMs: 10 }));
  assert.notEqual(result.status, "passed");
});

test("redacts a credential-shaped environment value out of the persisted transcript", async () => {
  const secretValue = "SYNTHETIC-TOKEN-abcdef1234567890";
  const { persist, transcripts } = collectingPersist();
  const transport = fixedTransport(okResult({ stdout: `leaked=${secretValue}\n`, exitCode: 0 }));
  await runVerification(
    baseInput({
      transport,
      persistTranscript: persist,
      env: { PATH: "/usr/bin", MY_API_TOKEN: secretValue },
    }),
  );
  assert.equal(transcripts.length, 1);
  const contents = transcripts[0]?.contents ?? "";
  assert.doesNotMatch(contents, new RegExp(secretValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(contents, /\[REDACTED\]/);
});

test("truncates an oversized transcript, keeping head and tail within the byte bound", async () => {
  const head = "HEAD-MARKER-START";
  const tail = "TAIL-MARKER-END";
  const filler = "x".repeat(200_000);
  const { persist, transcripts } = collectingPersist();
  const transport = fixedTransport(okResult({ stdout: `${head}${filler}${tail}\n`, exitCode: 0 }));
  await runVerification(baseInput({ transport, persistTranscript: persist }));
  const contents = transcripts[0]?.contents ?? "";
  assert.ok(Buffer.byteLength(contents, "utf8") <= MAX_TRANSCRIPT_BYTES);
  assert.match(contents, /HEAD-MARKER-START/);
  assert.match(contents, /TAIL-MARKER-END/);
  assert.match(contents, /transcript truncated/);
});

test("a transcript within the byte bound is left untruncated", async () => {
  const { persist, transcripts } = collectingPersist();
  const transport = fixedTransport(okResult({ stdout: "short output\n", exitCode: 0 }));
  await runVerification(baseInput({ transport, persistTranscript: persist }));
  const contents = transcripts[0]?.contents ?? "";
  assert.doesNotMatch(contents, /transcript truncated/);
});

// ---------------------------------------------------------------------------
// verificationTimeoutMs
// ---------------------------------------------------------------------------

test("verificationTimeoutMs converts minutes to milliseconds", () => {
  assert.equal(verificationTimeoutMs(5), 300_000);
});

for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
  test(`verificationTimeoutMs rejects non-positive or non-finite input: ${String(bad)}`, () => {
    assert.throws(() => verificationTimeoutMs(bad));
  });
}

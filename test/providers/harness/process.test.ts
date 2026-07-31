import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  createProcessTransport,
  HarnessAdapterError,
  ProcessTransportError,
  resolveWindowsCommand,
  runHarnessProcess,
} from "../../../src/providers/harness/process.js";
import { createRedactor } from "../../../src/providers/reliability.js";
import { FakeProcessTransport, processResult } from "./fake-process.js";

test("real process transport is fakeable and captures stdout/stderr without a shell", async () => {
  const child = fakeChild();
  let spawnCall:
    | {
      readonly command: string;
      readonly args: readonly string[];
      readonly shell: boolean | string | undefined;
      readonly cwd: string | URL | undefined;
      }
    | undefined;
  const transport = createProcessTransport({
    spawn(command, args, options) {
      spawnCall = { command, args, shell: options.shell, cwd: options.cwd };
      queueMicrotask(() => {
        (child.stdout as PassThrough).write("answer");
        (child.stderr as PassThrough).write("diagnostic");
        (child.stdout as PassThrough).end();
        (child.stderr as PassThrough).end();
        child.emit("close", 0, null);
      });
      return child;
    },
  });

  const result = await transport.run({
    command: "fake-cli",
    args: ["--mode", "test"],
    stdin: "private prompt",
    cwd: "/exact/worktree",
  });

  assert.deepEqual(spawnCall, {
    command: "fake-cli",
    args: ["--mode", "test"],
    shell: false,
    cwd: "/exact/worktree",
  });
  assert.equal(result.stdout, "answer");
  assert.equal(result.stderr, "diagnostic");
  assert.equal(result.exitCode, 0);
});

test("process transport forwards an explicitly supplied replacement environment", async () => {
  const child = fakeChild();
  let received: NodeJS.ProcessEnv | undefined;
  const transport = createProcessTransport({
    spawn(_command, _args, options) {
      received = options.env as NodeJS.ProcessEnv | undefined;
      queueMicrotask(() => { (child.stdout as PassThrough).end("ok"); (child.stderr as PassThrough).end(); child.emit("close", 0, null); });
      return child;
    },
  });
  await transport.run({ command: "node", args: [], stdin: "", env: { PATH: "/safe/bin", LANG: "C" } });
  assert.deepEqual(received, { PATH: "/safe/bin", LANG: "C" });
});

test("Windows cmd shims use cmd.exe with escaped arguments and no shell expansion", async () => {
  const child = fakeChild();
  let spawnCall:
    | {
        readonly command: string;
        readonly args: readonly string[];
        readonly shell: boolean | string | undefined;
        readonly windowsVerbatimArguments: boolean | undefined;
      }
    | undefined;
  const transport = createProcessTransport({
    platform: "win32",
    commandShell: "C:\\Windows\\System32\\cmd.exe",
    resolveCommand: () => "C:\\Users\\Sujan AppData\\npm\\codex.cmd",
    spawn(command, args, options) {
      spawnCall = {
        command,
        args,
        shell: options.shell,
        windowsVerbatimArguments: options.windowsVerbatimArguments,
      };
      queueMicrotask(() => {
        (child.stdout as PassThrough).end("answer");
        (child.stderr as PassThrough).end();
        child.emit("close", 0, null);
      });
      return child;
    },
  });

  await transport.run({
    command: "codex",
    args: ["--model", "safe & echo PWNED", "quoted\" | calc"],
    stdin: "private prompt",
  });

  assert.equal(spawnCall?.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(spawnCall?.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(spawnCall?.shell, false);
  assert.equal(spawnCall?.windowsVerbatimArguments, true);
  const commandLine = spawnCall?.args[3] ?? "";
  assert.match(commandLine, /codex\.cmd/u);
  assert.match(commandLine, /\^\^\^&/u);
  assert.match(commandLine, /\^\^\^\|/u);
  assert.doesNotMatch(commandLine, /safe & echo|quoted" \| calc/u);
});

test("Windows command resolution ignores extensionless aliases before a cmd shim", () => {
  const resolved = resolveWindowsCommand(
    "npm",
    () => [
      "C:\\Program Files\\nodejs\\npm",
      "C:\\Program Files\\nodejs\\npm.cmd",
    ].join("\r\n"),
  );

  assert.equal(resolved, "C:\\Program Files\\nodejs\\npm.cmd");
});

test("Windows command resolution preserves locator order across supported extensions", () => {
  const resolved = resolveWindowsCommand(
    "tool",
    () => [
      "C:\\first-on-path\\tool.cmd",
      "C:\\later-on-path\\tool.exe",
    ].join("\r\n"),
  );

  assert.equal(resolved, "C:\\first-on-path\\tool.cmd");
});

test("process transport maps a missing executable without spawning a real CLI", async () => {
  const child = fakeChild();
  const transport = createProcessTransport({
    spawn() {
      queueMicrotask(() => {
        child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
      });
      return child;
    },
  });

  await assert.rejects(
    transport.run({ command: "missing-cli", args: [], stdin: "" }),
    (error: unknown) => {
      assert.ok(error instanceof ProcessTransportError);
      assert.equal(error.kind, "missing-command");
      return true;
    },
  );
});

test("harness mapping turns a missing executable into a terminal typed error", async () => {
  const transport = new FakeProcessTransport(
    new ProcessTransportError("spawn missing-cli ENOENT", "missing-command", {
      code: "ENOENT",
    }),
  );

  await assert.rejects(
    runHarnessProcess({
      command: "missing-cli",
      args: [],
      stdin: "",
      transport,
    }),
    (error: unknown) => {
      assert.ok(error instanceof HarnessAdapterError);
      assert.equal(error.kind, "missing-command");
      assert.equal(error.retryable, false);
      assert.match(error.message, /Install it and authenticate locally/);
      return true;
    },
  );
});

test("kill refusal without close reports the started PID and uncertain termination", async () => {
  const child = fakeChild(8124);
  let killed = false;
  child.kill = () => {
    killed = true;
    return false;
  };
  const transport = createProcessTransport({ spawn: () => child });
  const controller = new AbortController();
  let startedProcessId: number | undefined;
  const pending = runHarnessProcess({
    command: "fake-cli",
    args: [],
    stdin: "prompt",
    signal: controller.signal,
    transport,
    onProcessStart(process) {
      startedProcessId = process.processId;
    },
  });

  controller.abort();

  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof HarnessAdapterError);
    assert.equal(error.kind, "aborted");
    assert.equal(error.retryable, true);
    assert.equal(error.processId, 8124);
    assert.equal(error.definitelyTerminated, false);
    return true;
  });
  assert.equal(killed, true);
  assert.equal(startedProcessId, 8124);
});

test("a late parent close cannot prove descendants terminated after abort", async () => {
  const child = fakeChild(8125);
  const transport = createProcessTransport({ spawn: () => child });
  const controller = new AbortController();
  const pending = transport.run({
    command: "fake-cli",
    args: [],
    stdin: "prompt",
    signal: controller.signal,
  });

  controller.abort();
  const error = await pending.catch((caught: unknown) => caught);
  // A close only proves the direct child exited. Descendants may still hold the
  // worktree, so the already-reported timeout/abort remains conservative.
  child.emit("close", 0, null);
  assert.ok(error instanceof ProcessTransportError);
  assert.equal(error.processId, 8125);
  assert.equal(error.definitelyTerminated, false);
});

test("process failure mapping redacts diagnostics and distinguishes retryability", async () => {
  const secret = "arbitrary-local-secret-12345";
  const redactor = createRedactor([secret]);
  const transient = new FakeProcessTransport(
    processResult("", { exitCode: 75, stderr: `temporary ${secret}` }),
  );
  const terminal = new FakeProcessTransport(
    processResult("", { exitCode: 2, stderr: `bad arguments ${secret}` }),
  );

  await assert.rejects(
    runHarnessProcess({
      command: "fake-cli",
      args: [],
      stdin: "",
      transport: transient,
      redactor,
    }),
    (error: unknown) => {
      assert.ok(error instanceof HarnessAdapterError);
      assert.equal(error.kind, "non-zero-exit");
      assert.equal(error.retryable, true);
      assert.ok(!error.message.includes(secret));
      return true;
    },
  );
  await assert.rejects(
    runHarnessProcess({
      command: "fake-cli",
      args: [],
      stdin: "",
      transport: terminal,
      redactor,
    }),
    (error: unknown) => {
      assert.ok(error instanceof HarnessAdapterError);
      assert.equal(error.retryable, false);
      assert.ok(!error.message.includes(secret));
      return true;
    },
  );
});

test("empty successful output is a terminal contract failure", async () => {
  await assert.rejects(
    runHarnessProcess({
      command: "fake-cli",
      args: [],
      stdin: "",
      transport: new FakeProcessTransport(processResult("  \n")),
    }),
    (error: unknown) => {
      assert.ok(error instanceof HarnessAdapterError);
      assert.equal(error.kind, "empty-response");
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

function fakeChild(processId?: number): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: () => boolean;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  if (processId !== undefined) {
    Object.defineProperty(child, "pid", { value: processId });
  }
  return child as unknown as ChildProcessWithoutNullStreams;
}

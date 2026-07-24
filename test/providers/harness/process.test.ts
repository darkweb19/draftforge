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
      }
    | undefined;
  const transport = createProcessTransport({
    spawn(command, args, options) {
      spawnCall = { command, args, shell: options.shell };
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
  });

  assert.deepEqual(spawnCall, {
    command: "fake-cli",
    args: ["--mode", "test"],
    shell: false,
  });
  assert.equal(result.stdout, "answer");
  assert.equal(result.stderr, "diagnostic");
  assert.equal(result.exitCode, 0);
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

test("aborting a process kills it and produces a retryable typed adapter error", async () => {
  const child = fakeChild();
  let killed = false;
  child.kill = () => {
    killed = true;
    return true;
  };
  const transport = createProcessTransport({ spawn: () => child });
  const controller = new AbortController();
  const pending = runHarnessProcess({
    command: "fake-cli",
    args: [],
    stdin: "prompt",
    signal: controller.signal,
    transport,
  });

  controller.abort();

  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof HarnessAdapterError);
    assert.equal(error.kind, "aborted");
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(killed, true);
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

function fakeChild(): ChildProcessWithoutNullStreams {
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
  return child as unknown as ChildProcessWithoutNullStreams;
}

import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_LOCK_POLL_INTERVAL_MS,
  DEFAULT_LOCK_WAIT_TIMEOUT_MS,
  withProjectLock,
} from "../src/state/lock.js";

test("recovers a lock whose owning process no longer exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "draftforge-stale-lock-"));
  try {
    await mkdir(resolve(root, ".draftforge"));
    await writeFile(
      resolve(root, ".draftforge/state.lock"),
      `${JSON.stringify({
        token: "stale-token",
        pid: 2_147_483_647,
        acquiredAt: "2026-01-01T00:00:00.000Z",
        operation: "interrupted approval",
      })}\n`,
      "utf8",
    );

    const value = await withProjectLock(root, "recovery test", async () => "recovered");
    assert.equal(value, "recovered");
    await assert.rejects(
      readFile(resolve(root, ".draftforge/state.lock"), "utf8"),
      { code: "ENOENT" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("two concurrent acquirers of one stale lock both succeed by waiting", async () => {
  const root = await mkdtemp(join(tmpdir(), "draftforge-stale-race-"));
  try {
    await mkdir(resolve(root, ".draftforge"));
    await writeFile(
      resolve(root, ".draftforge/state.lock"),
      `${JSON.stringify({
        token: "stale-token",
        pid: 2_147_483_647,
        acquiredAt: "2026-01-01T00:00:00.000Z",
        operation: "interrupted approval",
      })}\n`,
      "utf8",
    );

    // Exactly one acquirer wins the recovery race; the loser must wait it out
    // rather than be refused, so both critical sections eventually run.
    const results = await Promise.all([
      withProjectLock(root, "racing recovery a", async () => "a", {
        waitTimeoutMs: 5_000,
        pollIntervalMs: 5,
      }),
      withProjectLock(root, "racing recovery b", async () => "b", {
        waitTimeoutMs: 5_000,
        pollIntervalMs: 5,
      }),
    ]);
    assert.deepEqual([...results].sort(), ["a", "b"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not steal a lock owned by a live process, but waits for it", async () => {
  const root = await mkdtemp(join(tmpdir(), "draftforge-live-lock-"));
  try {
    await mkdir(resolve(root, ".draftforge"));
    await writeFile(
      resolve(root, ".draftforge/state.lock"),
      `${JSON.stringify({
        token: "live-token",
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        operation: "live operation",
      })}\n`,
      "utf8",
    );

    await assert.rejects(
      withProjectLock(root, "competing operation", async () => undefined, {
        waitTimeoutMs: 100,
        pollIntervalMs: 10,
      }),
      /Timed out after 100ms waiting for the project lock \(operation: competing operation\)/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("many concurrent callers serialize instead of refusing", async () => {
  const root = await mkdtemp(join(tmpdir(), "draftforge-serialize-lock-"));
  try {
    await mkdir(resolve(root, ".draftforge"));
    let active = 0;
    let peakActive = 0;
    const completed: string[] = [];

    async function critical(name: string): Promise<void> {
      await withProjectLock(root, `operation ${name}`, async () => {
        active += 1;
        peakActive = Math.max(peakActive, active);
        // Yield so a concurrent (buggy) implementation would interleave here.
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
        completed.push(name);
        active -= 1;
      });
    }

    await Promise.all(Array.from({ length: 10 }, (_, index) => critical(String(index))));

    assert.equal(peakActive, 1);
    assert.equal(completed.length, 10);
    assert.equal(new Set(completed).size, 10);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not race another stale-lock recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "draftforge-recovery-lock-"));
  try {
    await mkdir(resolve(root, ".draftforge"));
    await writeFile(resolve(root, ".draftforge/state.lock.recovery"), "claimed\n", "utf8");

    await assert.rejects(
      withProjectLock(root, "competing recovery", async () => undefined, {
        waitTimeoutMs: 100,
        pollIntervalMs: 10,
      }),
      /Timed out after 100ms waiting for the project lock \(operation: competing recovery\)/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovers once a stale recovery lock is removed mid-wait", async () => {
  const root = await mkdtemp(join(tmpdir(), "draftforge-recovery-midwait-"));
  try {
    await mkdir(resolve(root, ".draftforge"));
    await writeFile(resolve(root, ".draftforge/state.lock.recovery"), "claimed\n", "utf8");

    const removal = new Promise<void>((resolveRemoval) => {
      setTimeout(() => {
        rm(resolve(root, ".draftforge/state.lock.recovery"), { force: true })
          .then(resolveRemoval)
          .catch(resolveRemoval);
      }, 40);
    });

    const [value] = await Promise.all([
      withProjectLock(root, "waits for recovery", async () => "acquired", {
        waitTimeoutMs: 2_000,
        pollIntervalMs: 10,
      }),
      removal,
    ]);
    assert.equal(value, "acquired");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exports the default wait budget and poll interval", () => {
  assert.equal(DEFAULT_LOCK_WAIT_TIMEOUT_MS, 30_000);
  assert.equal(DEFAULT_LOCK_POLL_INTERVAL_MS, 25);
});

test("does not turn a permanent lock inspection failure into contention", async () => {
  const root = await mkdtemp(join(tmpdir(), "draftforge-invalid-lock-entry-"));
  try {
    await mkdir(resolve(root, ".draftforge/state.lock"), { recursive: true });

    await assert.rejects(
      withProjectLock(root, "inspect invalid lock entry", async () => undefined, {
        waitTimeoutMs: 250,
        pollIntervalMs: 5,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /Timed out .* waiting for the project lock/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("keeps a recent malformed lock fail-closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "draftforge-malformed-lock-"));
  const lockPath = resolve(root, ".draftforge/state.lock");
  try {
    await mkdir(resolve(root, ".draftforge"));
    await writeFile(lockPath, "{not-json\n", "utf8");

    await assert.rejects(
      withProjectLock(root, "inspect malformed lock", async () => undefined, {
        waitTimeoutMs: 100,
        pollIntervalMs: 5,
      }),
      /Timed out after 100ms waiting for the project lock/,
    );
    assert.equal(await readFile(lockPath, "utf8"), "{not-json\n");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test(
  "waits through a transient Windows sharing violation while inspecting the lock",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "draftforge-shared-lock-"));
    const lockPath = resolve(root, ".draftforge/state.lock");
    let blocker: ChildProcessWithoutNullStreams | undefined;
    try {
      await mkdir(resolve(root, ".draftforge"));
      await writeFile(
        lockPath,
        `${JSON.stringify({
          token: "temporarily-shared-token",
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
          operation: "temporary sharing violation",
        })}\n`,
        "utf8",
      );

      blocker = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          [
            "$lockPath = [Environment]::GetEnvironmentVariable('DRAFTFORGE_TEST_LOCK_PATH')",
            "$stream = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)",
            "[Console]::Out.WriteLine('ready')",
            "[Console]::Out.Flush()",
            "Start-Sleep -Milliseconds 150",
            "$stream.Dispose()",
            "Remove-Item -LiteralPath $lockPath -Force",
          ].join("; "),
        ],
        {
          env: { ...process.env, DRAFTFORGE_TEST_LOCK_PATH: lockPath },
        },
      );

      await new Promise<void>((resolveReady, rejectReady) => {
        let output = "";
        blocker?.stdout.setEncoding("utf8");
        blocker?.stdout.on("data", (chunk: string) => {
          output += chunk;
          if (output.includes("ready")) {
            resolveReady();
          }
        });
        blocker?.once("error", rejectReady);
        blocker?.once("exit", (code) => {
          if (!output.includes("ready")) {
            rejectReady(new Error(`sharing-violation helper exited with code ${String(code)}`));
          }
        });
      });

      const value = await withProjectLock(root, "wait through sharing violation", async () => "acquired", {
        waitTimeoutMs: 5_000,
        pollIntervalMs: 5,
      });
      assert.equal(value, "acquired");
    } finally {
      blocker?.kill();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  },
);

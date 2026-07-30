import assert from "node:assert/strict";
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

test("two concurrent callers serialize instead of one refusing", async () => {
  const root = await mkdtemp(join(tmpdir(), "draftforge-serialize-lock-"));
  try {
    await mkdir(resolve(root, ".draftforge"));
    const order: string[] = [];
    const observed: string[][] = [];

    async function critical(name: string): Promise<void> {
      await withProjectLock(root, `operation ${name}`, async () => {
        order.push(`${name}-start`);
        // Yield so a concurrent (buggy) implementation would interleave here.
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
        order.push(`${name}-end`);
        observed.push([...order]);
      });
    }

    await Promise.all([critical("a"), critical("b")]);

    // Each critical section must complete (`-start` immediately followed by
    // `-end`) before the other one starts; no interleaving is observed.
    assert.equal(order.length, 4);
    const firstPair = order.slice(0, 2);
    const secondPair = order.slice(2, 4);
    assert.equal(firstPair[0]?.endsWith("-start"), true);
    assert.equal(firstPair[1]?.endsWith("-end"), true);
    assert.equal(firstPair[0]?.split("-")[0], firstPair[1]?.split("-")[0]);
    assert.equal(secondPair[0]?.endsWith("-start"), true);
    assert.equal(secondPair[1]?.endsWith("-end"), true);
    assert.equal(secondPair[0]?.split("-")[0], secondPair[1]?.split("-")[0]);
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

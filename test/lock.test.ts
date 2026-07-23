import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { withProjectLock } from "../src/state/lock.js";

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

test("does not steal a lock owned by a live process", async () => {
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
      withProjectLock(root, "competing operation", async () => undefined),
      /Another state transition is already in progress/,
    );
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
      withProjectLock(root, "competing recovery", async () => undefined),
      /Project lock recovery is already in progress/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import { randomBytes } from "node:crypto";
import { open, readFile, rename, rm, stat, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";

const LOCK_PATH = ".draftforge/state.lock";
const RECOVERY_LOCK_PATH = ".draftforge/state.lock.recovery";
const INCOMPLETE_LOCK_GRACE_MS = 30_000;

/** Total time a caller waits for a held lock before giving up. */
export const DEFAULT_LOCK_WAIT_TIMEOUT_MS = 30_000;
/** Base delay between acquisition retries; jitter is added on top. */
export const DEFAULT_LOCK_POLL_INTERVAL_MS = 25;

export interface ProjectLockWaitOptions {
  readonly waitTimeoutMs?: number;
  readonly pollIntervalMs?: number;
}

interface ProjectLock {
  readonly handle: FileHandle;
  readonly path: string;
}

interface LockRecord {
  readonly token: string;
  readonly pid: number;
  readonly acquiredAt: string;
  readonly operation: string;
}

interface LockInspection {
  readonly raw: string;
  readonly stale: boolean;
}

/**
 * Signals that acquisition hit transient contention (a live holder or an
 * in-progress recovery) rather than a hard failure. The acquisition loop
 * catches this and retries until the wait budget is exhausted.
 */
class RetryableLockContention extends Error {}

export async function withProjectLock<T>(
  root: string,
  operation: string,
  run: () => Promise<T>,
  options?: ProjectLockWaitOptions,
): Promise<T> {
  const lock = await acquireProjectLock(root, operation, options);
  try {
    return await run();
  } finally {
    await lock.handle.close();
    await rm(lock.path, { force: true });
  }
}

async function acquireProjectLock(
  root: string,
  operation: string,
  options?: ProjectLockWaitOptions,
): Promise<ProjectLock> {
  const waitTimeoutMs = options?.waitTimeoutMs ?? DEFAULT_LOCK_WAIT_TIMEOUT_MS;
  const pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_LOCK_POLL_INTERVAL_MS;
  const lockPath = resolve(root, LOCK_PATH);
  const recoveryPath = resolve(root, RECOVERY_LOCK_PATH);
  // Computed once at entry so retries share one budget rather than each
  // waiting the full timeout in sequence.
  const deadline = Date.now() + waitTimeoutMs;

  for (;;) {
    try {
      return await tryAcquireProjectLock(lockPath, recoveryPath, operation);
    } catch (error: unknown) {
      if (!(error instanceof RetryableLockContention)) {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw timeoutError(operation, waitTimeoutMs);
      }
      await sleep(jitteredDelay(pollIntervalMs));
    }
  }
}

async function tryAcquireProjectLock(
  lockPath: string,
  recoveryPath: string,
  operation: string,
): Promise<ProjectLock> {
  await assertNoRecoveryInProgress(recoveryPath);

  try {
    return await createLock(lockPath, operation);
  } catch (error: unknown) {
    if (!hasErrorCode(error, "EEXIST")) {
      throw error;
    }
  }

  const inspection = await inspectLock(lockPath);
  if (inspection === null) {
    return createLock(lockPath, operation);
  }
  if (!inspection.stale) {
    throw new RetryableLockContention();
  }
  return recoverStaleLock(lockPath, recoveryPath, inspection.raw, operation);
}

async function recoverStaleLock(
  lockPath: string,
  recoveryPath: string,
  expectedRaw: string,
  operation: string,
): Promise<ProjectLock> {
  let recovery: FileHandle;
  try {
    recovery = await open(recoveryPath, "wx");
  } catch (error: unknown) {
    if (hasErrorCode(error, "EEXIST")) {
      // Same condition assertNoRecoveryInProgress treats as retryable: another
      // process is mid-recovery and will release shortly.
      throw new RetryableLockContention();
    }
    throw error;
  }

  const recoveryToken = randomBytes(16).toString("hex");
  const quarantine = `${lockPath}.stale-${recoveryToken}`;
  try {
    await writeLockRecord(recovery, "stale lock recovery", recoveryToken);

    // The recovery lock serializes stale breakers. Re-inspection prevents a
    // stale observation from removing a lock acquired before recovery began.
    const current = await inspectLock(lockPath);
    if (current === null) {
      return await createLock(lockPath, operation);
    }
    if (!current.stale || current.raw !== expectedRaw) {
      // Another process legitimately holds the lock now. Under the waiting
      // contract that is contention to wait out, not a refusal.
      throw new RetryableLockContention();
    }

    await rename(lockPath, quarantine);
    const quarantined = await readFile(quarantine, "utf8");
    if (quarantined !== expectedRaw) {
      throw new Error("Project lock changed during stale recovery; no new lock was acquired.");
    }

    try {
      return await createLock(lockPath, operation);
    } catch (error: unknown) {
      if (hasErrorCode(error, "EEXIST")) {
        // Lost the post-quarantine race to another acquirer; wait it out.
        throw new RetryableLockContention();
      }
      throw error;
    }
  } finally {
    await recovery.close();
    await rm(quarantine, { force: true });
    await rm(recoveryPath, { force: true });
  }
}

async function createLock(path: string, operation: string): Promise<ProjectLock> {
  const handle = await open(path, "wx");
  try {
    await writeLockRecord(handle, operation, randomBytes(16).toString("hex"));
    return { handle, path };
  } catch (error: unknown) {
    await handle.close();
    await rm(path, { force: true });
    throw error;
  }
}

async function writeLockRecord(
  handle: FileHandle,
  operation: string,
  token: string,
): Promise<void> {
  const record: LockRecord = {
    token,
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    operation,
  };
  await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
  await handle.sync();
}

async function inspectLock(path: string): Promise<LockInspection | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (hasErrorCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }

  try {
    const value: unknown = JSON.parse(raw);
    if (!isLockRecord(value)) {
      return { raw, stale: await isOlderThanGracePeriod(path) };
    }
    return { raw, stale: !isProcessAlive(value.pid) };
  } catch {
    return { raw, stale: await isOlderThanGracePeriod(path) };
  }
}

/**
 * A recovery in progress is transient: the process holding it either
 * completes the quarantine dance or its own stale-lock detection eventually
 * reclaims it. Signal retryable contention rather than failing outright.
 */
async function assertNoRecoveryInProgress(path: string): Promise<void> {
  try {
    await stat(path);
    throw new RetryableLockContention();
  } catch (error: unknown) {
    if (error instanceof RetryableLockContention) {
      throw error;
    }
    if (hasErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
}

async function isOlderThanGracePeriod(path: string): Promise<boolean> {
  try {
    const metadata = await stat(path);
    return Date.now() - metadata.mtimeMs >= INCOMPLETE_LOCK_GRACE_MS;
  } catch (error: unknown) {
    return hasErrorCode(error, "ENOENT");
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return hasErrorCode(error, "EPERM");
  }
}

function isLockRecord(value: unknown): value is LockRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    "token" in value &&
    typeof value.token === "string" &&
    value.token.length > 0 &&
    "pid" in value &&
    typeof value.pid === "number" &&
    Number.isInteger(value.pid) &&
    value.pid > 0 &&
    "acquiredAt" in value &&
    typeof value.acquiredAt === "string" &&
    !Number.isNaN(Date.parse(value.acquiredAt)) &&
    "operation" in value &&
    typeof value.operation === "string" &&
    value.operation.length > 0
  );
}

function timeoutError(operation: string, waitTimeoutMs: number): Error {
  return new Error(
    `Timed out after ${waitTimeoutMs}ms waiting for the project lock (operation: ${operation}). Another DraftForge process is holding it.`,
  );
}

function jitteredDelay(pollIntervalMs: number): number {
  return pollIntervalMs + Math.random() * pollIntervalMs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

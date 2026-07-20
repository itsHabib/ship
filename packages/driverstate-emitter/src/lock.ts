/**
 * A minimal synchronous cross-process file lock: `O_EXCL`-create a sentinel
 * file, spin with a short blocking sleep on contention, and reclaim a lock
 * file older than `STALE_LOCK_MS` (a crashed holder never released it). Not
 * workbench `driverstate`'s full withLock/withRetry discipline — kept simple
 * per spec, since ship's engine is the single writer for its own runs and
 * this only needs to serialize an append against a rare concurrent one.
 */

import { closeSync, openSync, rmSync, statSync, writeSync } from "node:fs";

const STALE_LOCK_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const RETRY_DELAY_MS = 10;

/** Runs `fn` while holding the lock file at `lockFile`, releasing it after. */
export function withLock<T>(lockFile: string, fn: () => T, timeoutMs = DEFAULT_TIMEOUT_MS): T {
  acquireLock(lockFile, timeoutMs);
  try {
    return fn();
  } finally {
    rmSync(lockFile, { force: true });
  }
}

function acquireLock(lockFile: string, timeoutMs = DEFAULT_TIMEOUT_MS): void {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (tryCreateLock(lockFile)) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`driverstate: lock timeout: ${lockFile}`);
    }
    reclaimIfStale(lockFile);
    sleepSync(RETRY_DELAY_MS);
  }
}

function tryCreateLock(lockFile: string): boolean {
  try {
    const fd = openSync(lockFile, "wx");
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch (err) {
    if (isErrnoCode(err, "EEXIST")) {
      return false;
    }
    throw err;
  }
}

function reclaimIfStale(lockFile: string): void {
  try {
    const age = Date.now() - statSync(lockFile).mtimeMs;
    if (age > STALE_LOCK_MS) {
      rmSync(lockFile, { force: true });
    }
  } catch {
    // Lock vanished between the failed create and this check — fine, the
    // next loop iteration's create will win it.
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isErrnoCode(err: unknown, code: string): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === code;
}

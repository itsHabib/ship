/**
 * Store-open orchestration for `bin.ts`: open the shared store, retrying the
 * brief reopen race that a just-reaped WAL holder leaves behind, while treating
 * real corruption as terminal.
 *
 * Extracted from `bin.ts` so the retry policy — and specifically the invariant
 * that a {@link StoreIntegrityError} is NEVER retried — is unit-testable without
 * a subprocess. Pure policy: the `open` thunk and `sleep` are injected.
 */

import type { Logger } from "@ship/logger";

import { isSqliteCorruptError, StoreIntegrityError } from "@ship/store";

/** Tunables for {@link openStoreWithRetry}; all injectable for tests. */
export interface OpenStoreRetryOptions {
  maxAttempts?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
}

/**
 * Call `open` until it succeeds, retrying only the transient reopen race a
 * just-reaped sibling leaves behind ("disk I/O error" / "database is locked" /
 * store contention). Corruption is terminal and never retried: an integrity
 * error from the store's gate, or a raw `SQLITE_CORRUPT` surfaced later (e.g. a
 * migration read on damage `quick_check` didn't catch), both propagate as a
 * {@link StoreIntegrityError} carrying the operator recovery path.
 */
export async function openStoreWithRetry(
  open: () => void,
  dbPath: string,
  opts: OpenStoreRetryOptions = {},
): Promise<void> {
  const maxAttempts = opts.maxAttempts ?? 5;
  const backoffMs = opts.backoffMs ?? 100;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 1; ; attempt++) {
    try {
      open();
      return;
    } catch (err: unknown) {
      throwIfNotRetryable(err, dbPath, attempt, maxAttempts);
      opts.logger?.warn(
        { attempt, err: errorText(err) },
        "transient store-open error after reaping a sibling; retrying",
      );
      await sleep(backoffMs * attempt);
    }
  }
}

/**
 * Rethrows when a store-open failure must NOT be retried: corruption (mapped to
 * a {@link StoreIntegrityError}), a non-transient error, or the last attempt.
 * Returns normally only when the caller should back off and retry.
 */
function throwIfNotRetryable(
  err: unknown,
  dbPath: string,
  attempt: number,
  maxAttempts: number,
): void {
  const terminal = asTerminalIntegrityError(err, dbPath);
  if (terminal !== undefined) throw terminal;
  if (attempt >= maxAttempts || !isTransientOpenError(err)) throw err;
}

/**
 * A store-open error that a brief wait-and-retry is expected to clear: the
 * store's own contention error, or the Windows reap→reopen "disk I/O error" /
 * "database is locked" race.
 */
export function isTransientOpenError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "StoreContentionError") return true;
  const message = err.message.toLowerCase();
  return message.includes("disk i/o error") || message.includes("database is locked");
}

/**
 * Returns a {@link StoreIntegrityError} when `err` is corruption (already the
 * gate's error, or a raw `SQLITE_CORRUPT`), else `undefined`. Never a transient
 * — corruption must not be retried, and must reach the operator with recovery
 * guidance even when it surfaces past the open-time gate.
 */
function asTerminalIntegrityError(err: unknown, dbPath: string): StoreIntegrityError | undefined {
  if (err instanceof StoreIntegrityError) return err;
  if (isSqliteCorruptError(err)) return new StoreIntegrityError(dbPath, (err as Error).message);
  return undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Tests for the store-open retry policy. The `open` thunk and `sleep` are
 * injected, so the retry/terminal decisions are pinned without a real store or
 * wall-clock delay.
 */

import { StoreIntegrityError } from "@ship/store";
import { describe, expect, test } from "vitest";

import { isTransientOpenError, openStoreWithRetry } from "./store-open.js";

const DB = "C:/tmp/state.db";
const noSleep = (): Promise<void> => Promise.resolve();

function transientError(): Error {
  return new Error("disk I/O error");
}

function corruptError(): Error {
  const err = new Error("database disk image is malformed") as Error & { code: string };
  err.code = "SQLITE_CORRUPT";
  return err;
}

describe("openStoreWithRetry", () => {
  test("succeeds on the first try without sleeping", async () => {
    let calls = 0;
    await openStoreWithRetry(
      () => {
        calls += 1;
      },
      DB,
      { sleep: noSleep },
    );
    expect(calls).toBe(1);
  });

  test("retries a transient error and succeeds once it clears", async () => {
    let calls = 0;
    await openStoreWithRetry(
      () => {
        calls += 1;
        if (calls < 3) throw transientError();
      },
      DB,
      { sleep: noSleep, maxAttempts: 5 },
    );
    expect(calls).toBe(3);
  });

  test("rethrows after exhausting maxAttempts on a persistent transient error", async () => {
    let calls = 0;
    await expect(
      openStoreWithRetry(
        () => {
          calls += 1;
          throw transientError();
        },
        DB,
        { sleep: noSleep, maxAttempts: 4 },
      ),
    ).rejects.toThrow(/disk I\/O error/);
    expect(calls).toBe(4);
  });

  test("NEVER retries a StoreIntegrityError — throws it on the first attempt", async () => {
    let calls = 0;
    await expect(
      openStoreWithRetry(
        () => {
          calls += 1;
          throw new StoreIntegrityError(DB, "quick_check: page 3 is corrupt");
        },
        DB,
        { sleep: noSleep, maxAttempts: 5 },
      ),
    ).rejects.toBeInstanceOf(StoreIntegrityError);
    expect(calls).toBe(1);
  });

  test("maps a raw SQLITE_CORRUPT (e.g. from a migration read) to StoreIntegrityError, unretried", async () => {
    let calls = 0;
    await expect(
      openStoreWithRetry(
        () => {
          calls += 1;
          throw corruptError();
        },
        DB,
        { sleep: noSleep, maxAttempts: 5 },
      ),
    ).rejects.toBeInstanceOf(StoreIntegrityError);
    expect(calls).toBe(1);
  });

  test("a non-transient, non-corrupt error is thrown immediately", async () => {
    let calls = 0;
    await expect(
      openStoreWithRetry(
        () => {
          calls += 1;
          throw new Error("permission denied");
        },
        DB,
        { sleep: noSleep, maxAttempts: 5 },
      ),
    ).rejects.toThrow(/permission denied/);
    expect(calls).toBe(1);
  });
});

describe("isTransientOpenError", () => {
  test("truth table", () => {
    expect(isTransientOpenError(new Error("disk I/O error"))).toBe(true);
    expect(isTransientOpenError(new Error("database is locked"))).toBe(true);
    const contention = new Error("busy") as Error & { name: string };
    contention.name = "StoreContentionError";
    expect(isTransientOpenError(contention)).toBe(true);
    expect(isTransientOpenError(new Error("database disk image is malformed"))).toBe(false);
    expect(isTransientOpenError(new Error("permission denied"))).toBe(false);
    expect(isTransientOpenError("not an error")).toBe(false);
  });
});

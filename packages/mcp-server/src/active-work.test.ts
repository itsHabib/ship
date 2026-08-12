import { describe, expect, test } from "vitest";

import { createActiveWorkTracker } from "./active-work.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, reject, resolve };
}

describe("active MCP work", () => {
  test("drain waits for tracked work", async () => {
    const tracker = createActiveWorkTracker();
    const work = deferred<number>();
    const tracked = tracker.track(work.promise);

    let drained = false;
    const drain = tracker.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    work.resolve(42);
    await expect(drain).resolves.toBeUndefined();
    await expect(tracked).resolves.toBe(42);
  });

  test("rejected work is removed without making drain reject", async () => {
    const tracker = createActiveWorkTracker();
    const work = deferred<undefined>();
    const tracked = tracker.track(work.promise);
    work.reject(new Error("driver failed"));

    await expect(tracked).rejects.toThrow("driver failed");
    await expect(tracker.drain()).resolves.toBeUndefined();
  });

  test("drain includes work registered while an earlier item settles", async () => {
    const tracker = createActiveWorkTracker();
    const first = deferred<undefined>();
    const second = deferred<undefined>();
    let secondTracked: Promise<undefined> | undefined;
    const firstTracked = tracker.track(
      first.promise.then(() => {
        secondTracked = tracker.track(second.promise);
      }),
    );

    let drained = false;
    const drain = tracker.drain().then(() => {
      drained = true;
    });
    first.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(drained).toBe(false);

    second.resolve(undefined);
    await expect(drain).resolves.toBeUndefined();
    await expect(firstTracked).resolves.toBeUndefined();
    await expect(secondTracked).resolves.toBeUndefined();
  });
});

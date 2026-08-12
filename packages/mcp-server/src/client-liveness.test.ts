import { afterEach, describe, expect, test, vi } from "vitest";

import { startClientLivenessWatch } from "./client-liveness.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("startClientLivenessWatch", () => {
  test("does nothing while the original client is alive", () => {
    vi.useFakeTimers();
    const onClientGone = vi.fn();
    const timer = startClientLivenessWatch(42, { isAlive: () => true }, onClientGone, 100);

    vi.advanceTimersByTime(500);

    expect(onClientGone).not.toHaveBeenCalled();
    clearInterval(timer);
  });

  test("requests graceful shutdown exactly once when the original client dies", () => {
    vi.useFakeTimers();
    let alive = true;
    const onClientGone = vi.fn();
    const timer = startClientLivenessWatch(42, { isAlive: () => alive }, onClientGone, 100);

    vi.advanceTimersByTime(100);
    alive = false;
    vi.advanceTimersByTime(500);

    expect(onClientGone).toHaveBeenCalledTimes(1);
    clearInterval(timer);
  });
});

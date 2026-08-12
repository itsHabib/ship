import { afterEach, describe, expect, test, vi } from "vitest";

import { startClientLivenessWatch } from "./client-liveness.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("startClientLivenessWatch", () => {
  test("does nothing while the original client is alive", () => {
    vi.useFakeTimers();
    const onClientGone = vi.fn();
    const timer = startClientLivenessWatch(
      42,
      "born-1",
      { identity: () => "born-1", isAlive: () => true },
      onClientGone,
      100,
    );

    vi.advanceTimersByTime(500);

    expect(onClientGone).not.toHaveBeenCalled();
    timer.stop();
  });

  test("requests graceful shutdown exactly once when the original client dies", () => {
    vi.useFakeTimers();
    let alive = true;
    const onClientGone = vi.fn();
    const timer = startClientLivenessWatch(
      42,
      "born-1",
      { identity: () => (alive ? "born-1" : undefined), isAlive: () => alive },
      onClientGone,
      100,
    );

    vi.advanceTimersByTime(100);
    alive = false;
    vi.advanceTimersByTime(500);

    expect(onClientGone).toHaveBeenCalledTimes(1);
    timer.stop();
  });

  test("detects PID reuse even while that PID remains alive", () => {
    vi.useFakeTimers();
    let identity = "born-1";
    const onClientGone = vi.fn();
    const timer = startClientLivenessWatch(
      42,
      identity,
      { identity: () => identity, isAlive: () => true },
      onClientGone,
      100,
    );

    identity = "born-2";
    vi.advanceTimersByTime(100);

    expect(onClientGone).toHaveBeenCalledTimes(1);
    timer.stop();
  });

  test("prefers a stable OS process-exit watch when available", () => {
    const onClientGone = vi.fn();
    const stop = vi.fn();
    const watchExit = vi.fn(() => stop);
    const watch = startClientLivenessWatch(
      42,
      undefined,
      { identity: () => undefined, isAlive: () => true, watchExit },
      onClientGone,
    );

    expect(watchExit).toHaveBeenCalledWith(42, onClientGone);
    watch.stop();
    expect(stop).toHaveBeenCalledOnce();
  });
});

/** Tests for terminal artifact listing timeout helper. */

import { describe, expect, test, vi } from "vitest";

import { captureListedArtifacts, LIST_ARTIFACTS_TIMEOUT_MS } from "./artifacts-capture.js";

describe("captureListedArtifacts", () => {
  test("returns validated refs on success", async () => {
    const refs = await captureListedArtifacts(() =>
      Promise.resolve([{ path: "a.txt", sizeBytes: 1, updatedAt: "2026-01-01T00:00:00.000Z" }]),
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]?.path).toBe("a.txt");
  });

  test("stalled list resolves to empty after timeout", async () => {
    vi.useFakeTimers();
    const promise = captureListedArtifacts(() => new Promise(() => undefined));
    await vi.advanceTimersByTimeAsync(LIST_ARTIFACTS_TIMEOUT_MS + 1);
    await expect(promise).resolves.toEqual([]);
    vi.useRealTimers();
  });

  test("non-array list resolves to empty", async () => {
    await expect(captureListedArtifacts(() => Promise.resolve(null))).resolves.toEqual([]);
  });

  test("drops malformed artifact entries", async () => {
    const refs = await captureListedArtifacts(() =>
      Promise.resolve([
        { path: 123 },
        { path: "ok.txt", sizeBytes: 1, updatedAt: "2026-01-01T00:00:00.000Z" },
      ]),
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]?.path).toBe("ok.txt");
  });

  test("logs timeout via provided logger", async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const promise = captureListedArtifacts(() => new Promise(() => undefined), {
      warn,
    } as never);
    await vi.advanceTimersByTimeAsync(LIST_ARTIFACTS_TIMEOUT_MS + 1);
    await promise;
    expect(warn).toHaveBeenCalled();
    vi.useRealTimers();
  });
});

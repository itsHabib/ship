/**
 * Tests for `clock.ts`.
 *
 * Coverage shape:
 * - Auto-advance: consecutive calls produce strictly-monotonic timestamps.
 * - `.advance(ms)`: jumps forward without producing a string; next call reflects the jump.
 * - `.set(iso)`: jumps absolute; next call reflects the new position.
 * - Bad input: invalid ISO / negative stepMs / non-finite advance → RangeError.
 */

import { describe, expect, test } from "vitest";

import { createTestClock } from "./clock.js";

describe("createTestClock", () => {
  test("default step: consecutive calls advance by 1ms", () => {
    const clock = createTestClock("2026-05-09T00:00:00.000Z");
    expect(clock()).toBe("2026-05-09T00:00:00.001Z");
    expect(clock()).toBe("2026-05-09T00:00:00.002Z");
    expect(clock()).toBe("2026-05-09T00:00:00.003Z");
  });

  test("custom step: consecutive calls advance by that step", () => {
    const clock = createTestClock("2026-05-09T00:00:00.000Z", 1000);
    expect(clock()).toBe("2026-05-09T00:00:01.000Z");
    expect(clock()).toBe("2026-05-09T00:00:02.000Z");
  });

  test("step 0: consecutive calls return the same timestamp (rare; useful for collision tests)", () => {
    const clock = createTestClock("2026-05-09T00:00:00.000Z", 0);
    expect(clock()).toBe("2026-05-09T00:00:00.000Z");
    expect(clock()).toBe("2026-05-09T00:00:00.000Z");
  });

  test(".advance(ms) jumps forward without emitting; next call reflects the jump + step", () => {
    const clock = createTestClock("2026-05-09T00:00:00.000Z");
    clock(); // → 001
    clock.advance(60_000);
    expect(clock()).toBe("2026-05-09T00:01:00.002Z");
  });

  test(".set(iso) jumps absolute; next call returns set + step", () => {
    const clock = createTestClock("2026-05-09T00:00:00.000Z");
    clock(); // → 001
    clock.set("2027-01-01T00:00:00.000Z");
    expect(clock()).toBe("2027-01-01T00:00:00.001Z");
  });

  test("invalid start ISO throws RangeError at construction", () => {
    expect(() => createTestClock("not-a-date")).toThrow(RangeError);
  });

  test("negative stepMs throws RangeError at construction", () => {
    expect(() => createTestClock("2026-05-09T00:00:00.000Z", -1)).toThrow(RangeError);
  });

  test("non-finite stepMs throws RangeError at construction", () => {
    expect(() => createTestClock("2026-05-09T00:00:00.000Z", Infinity)).toThrow(RangeError);
    expect(() => createTestClock("2026-05-09T00:00:00.000Z", NaN)).toThrow(RangeError);
  });

  test(".advance(NaN) throws RangeError", () => {
    const clock = createTestClock("2026-05-09T00:00:00.000Z");
    expect(() => {
      clock.advance(NaN);
    }).toThrow(RangeError);
  });

  test(".set with invalid ISO throws RangeError", () => {
    const clock = createTestClock("2026-05-09T00:00:00.000Z");
    expect(() => {
      clock.set("not-a-date");
    }).toThrow(RangeError);
  });
});

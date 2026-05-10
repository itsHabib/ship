/**
 * Regression test for `parseAndCatch`'s exit-code passthrough.
 * Commander's `--help` and `--version` paths throw `CommanderError`
 * with `exitCode: 0`; the helper used to map that through
 * `Number(err.exitCode) || 1`, silently flipping a legitimate `0`
 * to `1`. This test pins the fix so the same regression doesn't
 * sneak back via a `||` shortcut.
 */

import { describe, expect, test } from "vitest";

import { createCliHarness, parseAndCatch } from "./cli-harness.js";

describe("parseAndCatch — Commander exitCode 0 passthrough", () => {
  test("--help exits 0 (the harness must not flip Commander's exitCode 0 to 1)", async () => {
    const h = await createCliHarness();
    try {
      const { code } = await parseAndCatch(h.program, ["--help"]);
      expect(code).toBe(0);
    } finally {
      h.close();
    }
  });
});

/** CLI tests for `ship prune`. */

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createCliHarness, runArgv } from "./cli-harness.js";

describe("ship prune", () => {
  let h: Awaited<ReturnType<typeof createCliHarness>>;

  beforeEach(async () => {
    h = await createCliHarness();
  });

  afterEach(() => {
    h.close();
  });

  test("requires --before", async () => {
    const { code } = await runArgv(h.program, ["prune"]);
    expect(code).toBe(1);
    expect(h.stderr.join("")).toMatch(/required option|--before/i);
  });

  test("rejects invalid --before duration", async () => {
    const { code } = await runArgv(h.program, ["prune", "--before", "nope"]);
    expect(code).toBe(1);
    expect(h.stderr.join("")).toMatch(/invalid --before duration/);
  });

  test("dry-run with no candidates exits 0", async () => {
    const { code } = await runArgv(h.program, ["prune", "--before", "30d", "--dry-run"]);
    expect(code).toBe(0);
    expect(h.stdout.join("")).toMatch(/dry-run/);
  });
});

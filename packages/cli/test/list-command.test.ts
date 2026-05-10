/** Argv → service.listRuns plumbing for the `ship list` subcommand. */

import { afterEach, beforeEach, expect, test } from "vitest";

import type { CliHarness } from "./cli-harness.js";

import { createCliHarness, parseAndCatch, TEST_WORKDIR } from "./cli-harness.js";

let h: CliHarness;

beforeEach(async () => {
  h = await createCliHarness();
});

afterEach(() => {
  h.close();
});

async function shipN(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    h.harness.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    await h.service.ship({ workdir: TEST_WORKDIR, repo: "ship", docPath: "docs.md" });
  }
}

test("empty list prints header only and exits 0", async () => {
  const { code } = await parseAndCatch(h.program, ["list"]);
  expect(code).toBe(0);
  const lines = h.stdout.join("").trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("ID");
});

test("list --json emits { runs: [...] }", async () => {
  await shipN(2);
  h.stdout.length = 0;
  await parseAndCatch(h.program, ["list", "--json"]);
  const parsed = JSON.parse(h.stdout.join("").trim()) as { runs: unknown[] };
  expect(parsed.runs).toHaveLength(2);
});

test("--repo + repeated --status + --limit reach the service", async () => {
  await shipN(1);
  h.stdout.length = 0;
  const { code } = await parseAndCatch(h.program, [
    "list",
    "--repo",
    "ship",
    "--status",
    "succeeded",
    "--status",
    "failed",
    "--limit",
    "10",
    "--json",
  ]);
  expect(code).toBe(0);
  const parsed = JSON.parse(h.stdout.join("").trim()) as { runs: unknown[] };
  expect(parsed.runs.length).toBeGreaterThanOrEqual(1);
});

test("invalid --status value is rejected with exit 1 (InvalidArgumentError → user)", async () => {
  const { code } = await parseAndCatch(h.program, ["list", "--status", "bogus"]);
  expect(code).toBe(1);
  expect(h.stderr.join("")).toMatch(/invalid --status: bogus/);
});

test("invalid --limit value is rejected with exit 1", async () => {
  const { code } = await parseAndCatch(h.program, ["list", "--limit", "nope"]);
  expect(code).toBe(1);
  expect(h.stderr.join("")).toMatch(/invalid --limit: nope/);
});

test("--limit above 200 cap → exit 1 (RangeError from store → user)", async () => {
  const { code } = await parseAndCatch(h.program, ["list", "--limit", "99999999"]);
  expect(code).toBe(1);
  expect(h.stderr.join("")).toMatch(/exceeds maximum/);
});

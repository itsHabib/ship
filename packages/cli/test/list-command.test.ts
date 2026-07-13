/** Argv → service.listRuns plumbing for the `ship list` subcommand. */

import { afterEach, beforeEach, expect, test } from "vitest";

import type { CliHarness } from "./cli-harness.js";

import { createCliHarness, runArgv, TEST_WORKDIR } from "./cli-harness.js";

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
  const { code } = await runArgv(h.program, ["list"]);
  expect(code).toBe(0);
  const lines = h.stdout.join("").trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("ID");
});

test("list --json emits { runs: [...] }", async () => {
  await shipN(2);
  h.stdout.length = 0;
  await runArgv(h.program, ["list", "--json"]);
  const parsed = JSON.parse(h.stdout.join("").trim()) as { runs: unknown[] };
  expect(parsed.runs).toHaveLength(2);
});

test("list and status observability subviews match for the same run", async () => {
  h.harness.cursor.enqueue({
    events: [],
    result: { status: "succeeded", durationMs: 321, branches: [] },
  });
  const out = await h.service.ship({
    workdir: TEST_WORKDIR,
    repo: "ship",
    docPath: "docs.md",
  });
  h.stdout.length = 0;
  await runArgv(h.program, ["list", "--json"]);
  const listed = JSON.parse(h.stdout.join("").trim()) as {
    runs: { id: string; observability?: unknown }[];
  };
  h.stdout.length = 0;
  await runArgv(h.program, ["status", out.workflowRunId, "--json"]);
  const status = JSON.parse(h.stdout.join("").trim()) as { observability?: unknown };
  const listRow = listed.runs.find((row) => row.id === out.workflowRunId);
  expect(listRow?.observability).toEqual(status.observability);
  expect(listRow?.observability).toBeDefined();
});

test("--repo + repeated --status + --limit reach the service", async () => {
  await shipN(1);
  h.stdout.length = 0;
  const { code } = await runArgv(h.program, [
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
  const { code } = await runArgv(h.program, ["list", "--status", "bogus"]);
  expect(code).toBe(1);
  expect(h.stderr.join("")).toMatch(/invalid --status: bogus/);
});

test("invalid --limit value is rejected with exit 1", async () => {
  const { code } = await runArgv(h.program, ["list", "--limit", "nope"]);
  expect(code).toBe(1);
  expect(h.stderr.join("")).toMatch(/invalid --limit: nope/);
});

test("--limit above 200 cap → exit 1 (RangeError from store → user)", async () => {
  const { code } = await runArgv(h.program, ["list", "--limit", "99999999"]);
  expect(code).toBe(1);
  expect(h.stderr.join("")).toMatch(/exceeds the maximum allowed value/);
});

test("--limit with trailing garbage (e.g. '10abc') is rejected, not silently coerced to 10", async () => {
  const { code } = await runArgv(h.program, ["list", "--limit", "10abc"]);
  expect(code).toBe(1);
  expect(h.stderr.join("")).toMatch(/invalid --limit: 10abc/);
});

test("--limit with a fractional value (e.g. '3.5') is rejected", async () => {
  const { code } = await runArgv(h.program, ["list", "--limit", "3.5"]);
  expect(code).toBe(1);
  expect(h.stderr.join("")).toMatch(/invalid --limit: 3.5/);
});

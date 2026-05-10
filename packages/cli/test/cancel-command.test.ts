/** Argv → service.cancelRun plumbing for the `ship cancel` subcommand. */

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

test("cancel terminal run → returns the existing terminal status; exit 0", async () => {
  h.harness.cursor.enqueue({
    events: [],
    result: { status: "succeeded", durationMs: 0, branches: [] },
  });
  const out = await h.service.ship({
    workdir: TEST_WORKDIR,
    repo: "ship",
    docPath: "docs.md",
  });
  h.stdout.length = 0;

  const { code } = await parseAndCatch(h.program, ["cancel", out.workflowRunId]);
  expect(code).toBe(0);
  expect(h.stdout.join("")).toContain("status: succeeded");
});

test("cancel --json emits the envelope", async () => {
  h.harness.cursor.enqueue({
    events: [],
    result: { status: "succeeded", durationMs: 0, branches: [] },
  });
  const out = await h.service.ship({
    workdir: TEST_WORKDIR,
    repo: "ship",
    docPath: "docs.md",
  });
  h.stdout.length = 0;

  await parseAndCatch(h.program, ["cancel", out.workflowRunId, "--json"]);
  const parsed = JSON.parse(h.stdout.join("").trim()) as { workflowRunId: string; status: string };
  expect(parsed.workflowRunId).toBe(out.workflowRunId);
});

test("cancel unknown id → exit 1 (user error: WorkflowRunNotFoundError)", async () => {
  const { code } = await parseAndCatch(h.program, ["cancel", "wf_01J0000000000000000000000Z"]);
  expect(code).toBe(1);
  expect(h.stderr.join("")).toMatch(/workflow run not found/);
});

/** Argv → service.getRun plumbing for the `ship status` subcommand. */

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

async function shipOnce(): Promise<string> {
  h.harness.cursor.enqueue({
    events: [],
    result: { status: "succeeded", durationMs: 0, branches: [] },
  });
  const out = await h.service.ship({
    workdir: TEST_WORKDIR,
    repo: "ship",
    docPath: "docs.md",
  });
  return out.workflowRunId;
}

test("status existing run → pretty output names the row", async () => {
  const id = await shipOnce();
  h.stdout.length = 0;
  const { code } = await parseAndCatch(h.program, ["status", id]);
  expect(code).toBe(0);
  const out = h.stdout.join("");
  expect(out).toContain(`id:        ${id}`);
  expect(out).toContain("status:    succeeded");
});

test("status --json emits a hydrated WorkflowRun envelope", async () => {
  const id = await shipOnce();
  h.stdout.length = 0;
  await parseAndCatch(h.program, ["status", id, "--json"]);
  const parsed = JSON.parse(h.stdout.join("").trim()) as { id: string; status: string };
  expect(parsed.id).toBe(id);
  expect(parsed.status).toBe("succeeded");
});

test("status unknown id → exit 1; stderr 'not found'", async () => {
  const { code } = await parseAndCatch(h.program, ["status", "wf_01J0000000000000000000000Z"]);
  expect(code).toBe(1);
  expect(h.stderr.join("")).toContain("not found");
});

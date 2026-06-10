/** Argv → service.getRun plumbing for the `ship diagnose` subcommand. */

import { DEFAULT_WORKFLOW_POLICY } from "@ship/workflow";
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

async function shipFailedRun(): Promise<string> {
  const statusEv = { type: "status", status: "ERROR", ts: "2026-06-01T12:06:00.000Z" };
  const runningShell = {
    type: "tool_call",
    status: "running",
    name: "shell",
    args: { command: "make check" },
    ts: "2026-06-01T12:00:00.000Z",
  };
  h.harness.cursor.enqueue({
    events: [runningShell, statusEv] as never[],
    result: {
      status: "failed",
      durationMs: 6 * 60 * 1000,
      errorMessage:
        "SDK status ERROR after 6m (cap 30m); last activity: shell 'make check' running 6m, never completed",
      sdkTerminalStatus: "ERROR",
      branches: [],
    },
  });
  const out = await h.service.ship({
    workdir: TEST_WORKDIR,
    repo: "ship",
    docPath: "docs.md",
  });
  return out.workflowRunId;
}

test("diagnose failed run → pretty output includes category, error, duration, last activity", async () => {
  const id = await shipFailedRun();
  h.stdout.length = 0;
  const { code } = await runArgv(h.program, ["diagnose", id]);
  expect(code).toBe(0);
  const out = h.stdout.join("");
  expect(out).toContain("status:    failed");
  expect(out).toContain("category:  unknown");
  expect(out).toContain("error:");
  expect(out).toContain(
    `duration:  ${String(6 * 60 * 1000)}ms / cap ${String(DEFAULT_WORKFLOW_POLICY.maxRunDurationMs)}ms`,
  );
  expect(out).toContain("last:");
});

test("diagnose --json emits a hydrated GetWorkflowRunOutput envelope", async () => {
  const id = await shipFailedRun();
  h.stdout.length = 0;
  await runArgv(h.program, ["diagnose", id, "--json"]);
  const parsed = JSON.parse(h.stdout.join("").trim()) as {
    id: string;
    status: string;
    failureCategory?: string;
  };
  expect(parsed.id).toBe(id);
  expect(parsed.status).toBe("failed");
  expect(parsed.failureCategory).toBeDefined();
});

test("diagnose succeeded run → note that there is nothing to diagnose", async () => {
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
  const { code } = await runArgv(h.program, ["diagnose", out.workflowRunId]);
  expect(code).toBe(0);
  expect(h.stdout.join("")).toContain("nothing to diagnose");
});

test("diagnose unknown id → exit 1; stderr 'not found'", async () => {
  const { code } = await runArgv(h.program, ["diagnose", "wf_01J0000000000000000000000Z"]);
  expect(code).toBe(1);
  expect(h.stderr.join("")).toContain("not found");
});

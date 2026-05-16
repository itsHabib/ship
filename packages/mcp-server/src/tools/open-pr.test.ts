// `open_pr` MCP tool — handler-level tests. Exercises the
// InMemoryTransport round-trip from a real `Client` so input/output
// schema enforcement + the error mapper are wired the same way they
// will be in production.

import type { OpenPrOutput } from "@ship/mcp";
import type { CreateWorkflowRunInput } from "@ship/store";

import { createSampleAppendPhaseInput, createSampleWorkflowRunInput } from "@ship/test-harness";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  createMcpHarness,
  expectToolError,
  type McpHarness,
  parseToolJson,
} from "../../test/mcp-harness.js";

const WORKDIR = "/work/wt/feat";
const BRANCH = "tower/sample";

let h: McpHarness;

beforeEach(async () => {
  h = await createMcpHarness();
  // Seed a workflow run with a succeeded implement phase and a
  // workdir whose `.git` exists in the in-memory fs.
  const workflowRunId = h.harness.ids.workflowRun();
  const input: CreateWorkflowRunInput = createSampleWorkflowRunInput(workflowRunId, {
    worktree: {
      repo: "ship",
      name: "sample",
      branch: BRANCH,
      path: WORKDIR,
      baseRef: "main",
    },
  });
  h.harness.store.createWorkflowRun(input);
  const phaseId = h.harness.ids.phase();
  h.harness.store.appendPhase(
    createSampleAppendPhaseInput(phaseId, workflowRunId, { kind: "implement" }),
  );
  h.harness.store.updatePhase(phaseId, { status: "succeeded", endedAt: h.harness.clock() });
  await h.openPrBundle.fs.mkdir(`${WORKDIR}/.git`, { recursive: true });
  (globalThis as { __runId?: string }).__runId = workflowRunId;
});

afterEach(async () => {
  await h.close();
});

function runId(): string {
  const id = (globalThis as { __runId?: string }).__runId;
  if (id === undefined) throw new Error("test setup did not stash runId");
  return id;
}

describe("open_pr tool", () => {
  test("happy path: returns the validated OpenPrOutput shape", async () => {
    const raw = await h.client.callTool({
      name: "open_pr",
      arguments: { workflowRunId: runId() },
    });
    const out = parseToolJson(raw) as OpenPrOutput;
    expect(out.status).toBe("succeeded");
    expect(out.workflowRunId).toBe(runId());
    expect(out.alreadyExisted).toBe(false);
    expect(out.prNumber).toBe(1);
    // Strict-mode output: exactly the documented keys, no leaks.
    expect(Object.keys(out).sort((a, b) => a.localeCompare(b))).toEqual([
      "alreadyExisted",
      "base",
      "head",
      "phaseId",
      "prNumber",
      "prUrl",
      "status",
      "workflowRunId",
    ]);
  });

  test("malformed input (bad workflowRunId) → isError tool result", async () => {
    const raw = await h.client.callTool({
      name: "open_pr",
      arguments: { workflowRunId: "not-a-ulid" },
    });
    expect(expectToolError(raw).text).toMatch(/workflowRunId|invalid/i);
  });

  test("idempotent path surfaces alreadyExisted: true on retry", async () => {
    h.gh.setOpenPrs([{ number: 42, url: "https://github.com/x/y/pull/42" }]);
    const raw = await h.client.callTool({
      name: "open_pr",
      arguments: { workflowRunId: runId() },
    });
    const out = parseToolJson(raw) as OpenPrOutput;
    expect(out.alreadyExisted).toBe(true);
    expect(out.prNumber).toBe(42);
  });

  test("EmptyBranchError from the service surfaces as isError", async () => {
    h.git.setCommitSubjects([]);
    const raw = await h.client.callTool({
      name: "open_pr",
      arguments: { workflowRunId: runId() },
    });
    expect(expectToolError(raw).text).toMatch(/no commits/i);
  });
});

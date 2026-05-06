/**
 * Tests for `mcp.ts` — input/output schemas for the four V1 MCP tools.
 *
 * For each tool we exercise the input schema (positive, .strict() rejection,
 * malformed `wf_<ulid>` id rejection where applicable, missing required
 * field) and the output schema (positive, .strict() rejection). The
 * `listWorkflowRunsInputSchema` tests additionally cover the `limit`
 * boundary and integer enforcement.
 */

import type { CursorRunRef, WorkflowRun, WorktreeRef } from "@ship/workflow";

import { DEFAULT_WORKFLOW_POLICY } from "@ship/workflow";
import { describe, expect, test } from "vitest";

import type { ShipInput, ShipOutput } from "./mcp.js";

import {
  cancelWorkflowRunInputSchema,
  cancelWorkflowRunOutputSchema,
  getWorkflowRunInputSchema,
  getWorkflowRunOutputSchema,
  listWorkflowRunsInputSchema,
  listWorkflowRunsOutputSchema,
  shipArtifactsSchema,
  shipInputSchema,
  shipOutputSchema,
} from "./mcp.js";

const WF_ID = "wf_01ARZ3NDEKTSV4RRFFQ69G5FAV";

const validWorktree: WorktreeRef = {
  repo: "ship",
  name: "feat-domain",
  branch: "ship/feat-domain",
  path: "/repo/.worktrees/feat-domain",
  baseRef: "main",
};

const validCursorRunRef: CursorRunRef = {
  id: "cr_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  agentId: "agent_abc",
  runtime: "local",
  startedAt: "2026-05-06T12:00:00Z",
  status: "succeeded",
  artifactsDir: "/runs/wf_01ARZ3NDEKTSV4RRFFQ69G5FAV/",
};

const validWorkflowRun: WorkflowRun = {
  id: WF_ID,
  repo: "ship",
  docPath: "docs/features/hello.md",
  status: "succeeded",
  baseRef: "main",
  worktree: validWorktree,
  policy: DEFAULT_WORKFLOW_POLICY,
  createdAt: "2026-05-06T12:00:00Z",
  updatedAt: "2026-05-06T12:30:00Z",
  phases: [],
};

describe("shipInputSchema", () => {
  test("accepts a minimal input", () => {
    const v: ShipInput = { repo: "ship", docPath: "docs/x.md" };
    expect(shipInputSchema.parse(v)).toEqual(v);
  });

  test("accepts input with all optional fields", () => {
    const v: ShipInput = {
      repo: "ship",
      docPath: "docs/x.md",
      worktreeName: "feat-x",
      baseRef: "main",
      model: "composer-2",
    };
    expect(shipInputSchema.parse(v)).toEqual(v);
  });

  test("rejects unknown keys", () => {
    expect(shipInputSchema.safeParse({ repo: "ship", docPath: "x", extra: 1 }).success).toBe(false);
  });

  test("rejects missing required field", () => {
    expect(shipInputSchema.safeParse({ repo: "ship" }).success).toBe(false);
  });

  test("rejects empty string in required field", () => {
    expect(shipInputSchema.safeParse({ repo: "", docPath: "x" }).success).toBe(false);
    expect(shipInputSchema.safeParse({ repo: "ship", docPath: "" }).success).toBe(false);
  });
});

describe("shipArtifactsSchema", () => {
  test("accepts a valid artifacts object", () => {
    const v = {
      promptPath: "/runs/wf/prompt.md",
      eventsPath: "/runs/wf/events.ndjson",
      resultPath: "/runs/wf/result.json",
    };
    expect(shipArtifactsSchema.parse(v)).toEqual(v);
  });

  test("rejects unknown keys", () => {
    expect(
      shipArtifactsSchema.safeParse({
        promptPath: "/p",
        eventsPath: "/e",
        resultPath: "/r",
        extra: 1,
      }).success,
    ).toBe(false);
  });

  test("rejects empty path", () => {
    expect(
      shipArtifactsSchema.safeParse({ promptPath: "", eventsPath: "/e", resultPath: "/r" }).success,
    ).toBe(false);
  });
});

describe("shipOutputSchema", () => {
  const validOutput: ShipOutput = {
    workflowRunId: WF_ID,
    status: "succeeded",
    worktree: validWorktree,
    cursorRun: validCursorRunRef,
    artifacts: {
      promptPath: "/runs/wf/prompt.md",
      eventsPath: "/runs/wf/events.ndjson",
      resultPath: "/runs/wf/result.json",
    },
  };

  test("accepts a valid output", () => {
    expect(shipOutputSchema.parse(validOutput)).toEqual(validOutput);
  });

  test("accepts a valid output with summary", () => {
    const withSummary: ShipOutput = { ...validOutput, summary: "Wrote hello.ts and tests." };
    expect(shipOutputSchema.parse(withSummary)).toEqual(withSummary);
  });

  test("rejects unknown keys", () => {
    expect(shipOutputSchema.safeParse({ ...validOutput, extra: 1 }).success).toBe(false);
  });

  test("rejects malformed workflowRunId", () => {
    expect(shipOutputSchema.safeParse({ ...validOutput, workflowRunId: "wf_short" }).success).toBe(
      false,
    );
    expect(
      shipOutputSchema.safeParse({ ...validOutput, workflowRunId: "ph_01ARZ3NDEKTSV4RRFFQ69G5FAV" })
        .success,
    ).toBe(false);
  });

  test("rejects empty summary if present", () => {
    expect(shipOutputSchema.safeParse({ ...validOutput, summary: "" }).success).toBe(false);
  });
});

describe("getWorkflowRunInputSchema", () => {
  test("accepts a valid id", () => {
    expect(getWorkflowRunInputSchema.parse({ workflowRunId: WF_ID })).toEqual({
      workflowRunId: WF_ID,
    });
  });

  test("rejects malformed id", () => {
    expect(getWorkflowRunInputSchema.safeParse({ workflowRunId: "abc" }).success).toBe(false);
    expect(
      getWorkflowRunInputSchema.safeParse({ workflowRunId: "ph_01ARZ3NDEKTSV4RRFFQ69G5FAV" })
        .success,
    ).toBe(false);
  });

  test("rejects unknown keys", () => {
    expect(getWorkflowRunInputSchema.safeParse({ workflowRunId: WF_ID, extra: 1 }).success).toBe(
      false,
    );
  });

  test("rejects missing id", () => {
    expect(getWorkflowRunInputSchema.safeParse({}).success).toBe(false);
  });
});

describe("getWorkflowRunOutputSchema", () => {
  test("accepts a valid workflow run", () => {
    expect(getWorkflowRunOutputSchema.parse(validWorkflowRun)).toEqual(validWorkflowRun);
  });

  test("rejects unknown keys", () => {
    expect(getWorkflowRunOutputSchema.safeParse({ ...validWorkflowRun, extra: 1 }).success).toBe(
      false,
    );
  });
});

describe("listWorkflowRunsInputSchema", () => {
  test("accepts an empty filter", () => {
    expect(listWorkflowRunsInputSchema.parse({})).toEqual({});
  });

  test("accepts a fully populated filter", () => {
    const v = { repo: "ship", status: ["pending", "running"] as const, limit: 100 };
    expect(listWorkflowRunsInputSchema.parse(v)).toEqual(v);
  });

  test("rejects limit above max (200)", () => {
    expect(listWorkflowRunsInputSchema.safeParse({ limit: 201 }).success).toBe(false);
  });

  test("accepts limit at the max boundary", () => {
    expect(listWorkflowRunsInputSchema.safeParse({ limit: 200 }).success).toBe(true);
  });

  test("rejects zero or negative limit", () => {
    expect(listWorkflowRunsInputSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(listWorkflowRunsInputSchema.safeParse({ limit: -1 }).success).toBe(false);
  });

  test("rejects fractional limit", () => {
    expect(listWorkflowRunsInputSchema.safeParse({ limit: 1.5 }).success).toBe(false);
  });

  test("rejects unknown status value", () => {
    expect(listWorkflowRunsInputSchema.safeParse({ status: ["done"] }).success).toBe(false);
  });

  test("rejects unknown keys", () => {
    expect(listWorkflowRunsInputSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});

describe("listWorkflowRunsOutputSchema", () => {
  test("accepts an empty list", () => {
    expect(listWorkflowRunsOutputSchema.parse({ runs: [] })).toEqual({ runs: [] });
  });

  test("accepts a populated list", () => {
    expect(listWorkflowRunsOutputSchema.parse({ runs: [validWorkflowRun] })).toEqual({
      runs: [validWorkflowRun],
    });
  });

  test("rejects unknown keys", () => {
    expect(listWorkflowRunsOutputSchema.safeParse({ runs: [], extra: 1 }).success).toBe(false);
  });
});

describe("cancelWorkflowRunInputSchema", () => {
  test("accepts a valid id", () => {
    expect(cancelWorkflowRunInputSchema.parse({ workflowRunId: WF_ID })).toEqual({
      workflowRunId: WF_ID,
    });
  });

  test("rejects malformed id", () => {
    expect(cancelWorkflowRunInputSchema.safeParse({ workflowRunId: "x" }).success).toBe(false);
  });
});

describe("cancelWorkflowRunOutputSchema", () => {
  test("accepts a valid output", () => {
    const v = { workflowRunId: WF_ID, status: "cancelled" as const };
    expect(cancelWorkflowRunOutputSchema.parse(v)).toEqual(v);
  });

  test("rejects unknown keys", () => {
    expect(
      cancelWorkflowRunOutputSchema.safeParse({
        workflowRunId: WF_ID,
        status: "cancelled",
        extra: 1,
      }).success,
    ).toBe(false);
  });
});

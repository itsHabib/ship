/** Tests for the four V1 MCP tools' input/output schemas. */

import type { TerminalCursorRunRef, WorkflowRun, WorktreeRef } from "@ship/workflow";

import { DEFAULT_WORKFLOW_POLICY } from "@ship/workflow";
import { describe, expect, test } from "vitest";

import type { ShipInput, ShipOutput, ShipStartOutput } from "./mcp.js";

import {
  cancelWorkflowRunInputSchema,
  cancelWorkflowRunOutputSchema,
  driverDecideInputSchema,
  driverRunInputSchema,
  driverTickResultSchema,
  getWorkflowRunInputSchema,
  getWorkflowRunOutputSchema,
  listWorkflowRunsInputSchema,
  listWorkflowRunsOutputSchema,
  shipArtifactsSchema,
  shipInputSchema,
  shipOutputSchema,
  shipStartOutputSchema,
} from "./mcp.js";

const WF_ID = "wf_01ARZ3NDEKTSV4RRFFQ69G5FAV";

const validWorktree: WorktreeRef = {
  repo: "ship",
  name: "feat-domain",
  branch: "ship/feat-domain",
  path: "/repo/.worktrees/feat-domain",
  baseRef: "main",
};

const validCursorRunRef: TerminalCursorRunRef = {
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
    const v: ShipInput = { workdir: "/work/wt/feat", repo: "ship", docPath: "docs/x.md" };
    expect(shipInputSchema.parse(v)).toEqual(v);
  });

  test("accepts input with all optional fields", () => {
    const v: ShipInput = {
      workdir: "/work/wt/feat",
      repo: "ship",
      docPath: "docs/x.md",
      worktreeName: "feat-x",
      branch: "ship/feat-x",
      baseRef: "main",
      model: "composer-2",
      modelParams: [{ id: "fast", value: true }],
    };
    expect(shipInputSchema.parse(v)).toEqual(v);
  });

  test("accepts runtime local / cloud and optional cloud spec", () => {
    const local = shipInputSchema.parse({
      workdir: "/w",
      repo: "ship",
      docPath: "x",
      runtime: "local",
    });
    expect(local.runtime).toBe("local");

    const cloud = shipInputSchema.parse({
      workdir: "/w",
      repo: "ship",
      docPath: "x",
      runtime: "cloud",
      cloud: { repos: [{ url: "https://github.com/o/r" }] },
    });
    expect(cloud.runtime).toBe("cloud");
    expect(cloud.cloud?.repos[0]?.url).toBe("https://github.com/o/r");
  });

  test("accepts cloud call without workdir or repo", () => {
    const cloud = shipInputSchema.parse({
      docPath: "/tmp/task.md",
      runtime: "cloud",
      cloud: { repos: [{ url: "https://github.com/itsHabib/roxiq" }] },
    });
    expect(cloud.workdir).toBeUndefined();
    expect(cloud.repo).toBeUndefined();
  });

  test("rejects local call without workdir", () => {
    expect(
      shipInputSchema.safeParse({ repo: "ship", docPath: "x", runtime: "local" }).success,
    ).toBe(false);
  });

  test("rejects runtime: 'cloud' without a cloud spec (cross-field refinement)", () => {
    const result = shipInputSchema.safeParse({
      workdir: "/w",
      repo: "ship",
      docPath: "x",
      runtime: "cloud",
      // cloud omitted
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join(".") === "cloud");
      expect(issue?.message).toMatch(/cloud config is required/);
    }
  });

  test("accepts runtime rooms with a room spec (workdir/repo omitted)", () => {
    const rooms = shipInputSchema.parse({
      docPath: "docs/x.md",
      runtime: "rooms",
      room: { repos: [{ url: "https://github.com/itsHabib/roxiq", startingRef: "main" }] },
    });
    expect(rooms.runtime).toBe("rooms");
    expect(rooms.room?.repos[0]?.url).toBe("https://github.com/itsHabib/roxiq");
    expect(rooms.workdir).toBeUndefined();
    expect(rooms.repo).toBeUndefined();
  });

  test("accepts optional room image + pushBranch; rejects unknown room keys", () => {
    const rooms = shipInputSchema.parse({
      docPath: "x",
      runtime: "rooms",
      room: {
        repos: [{ url: "https://github.com/itsHabib/roxiq" }],
        image: "agent-alpine-cursor.ext4",
        pushBranch: "rooms/custom",
      },
    });
    expect(rooms.room?.image).toBe("agent-alpine-cursor.ext4");
    expect(rooms.room?.pushBranch).toBe("rooms/custom");
    expect(
      shipInputSchema.safeParse({
        docPath: "x",
        runtime: "rooms",
        room: { repos: [{ url: "https://github.com/o/r" }], autoCreatePR: true },
      }).success,
    ).toBe(false);
  });

  test("rejects runtime: 'rooms' without a room spec (cross-field refinement)", () => {
    const result = shipInputSchema.safeParse({
      docPath: "x",
      runtime: "rooms",
      // room omitted
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join(".") === "room");
      expect(issue?.message).toMatch(/room config is required/);
    }
  });

  test("accepts modelParams arrays with string / boolean values; omits when undefined", () => {
    const parsed = shipInputSchema.parse({
      workdir: "/w",
      repo: "ship",
      docPath: "x",
      modelParams: [
        { id: "fast", value: "true" },
        { id: "flag", value: false },
      ],
    });
    expect(parsed.modelParams).toEqual([
      { id: "fast", value: "true" },
      { id: "flag", value: false },
    ]);
    const noParams = shipInputSchema.parse({ workdir: "/w", repo: "ship", docPath: "x" });
    expect(noParams.modelParams).toBeUndefined();
  });

  test("rejects modelParams rows with structural junk", () => {
    expect(
      shipInputSchema.safeParse({
        workdir: "/w",
        repo: "ship",
        docPath: "x",
        modelParams: [{ id: "k", value: true, nested: 1 }],
      }).success,
    ).toBe(false);
  });

  test("rejects modelParams rows with empty id or empty string value at the MCP boundary", () => {
    // Without this guard, downstream `modelParameterValueSchema` (.min(1))
    // would convert a caller input error into a mid-run StoreSchemaError.
    expect(
      shipInputSchema.safeParse({
        workdir: "/w",
        repo: "ship",
        docPath: "x",
        modelParams: [{ id: "", value: "high" }],
      }).success,
    ).toBe(false);
    expect(
      shipInputSchema.safeParse({
        workdir: "/w",
        repo: "ship",
        docPath: "x",
        modelParams: [{ id: "fast", value: "" }],
      }).success,
    ).toBe(false);
    // Boolean false is a legitimate value (composer-2.5 takes fast: false).
    expect(
      shipInputSchema.safeParse({
        workdir: "/w",
        repo: "ship",
        docPath: "x",
        modelParams: [{ id: "fast", value: false }],
      }).success,
    ).toBe(true);
  });

  test("rejects unknown keys", () => {
    expect(
      shipInputSchema.safeParse({
        workdir: "/w",
        repo: "ship",
        docPath: "x",
        extra: 1,
      }).success,
    ).toBe(false);
  });

  test("rejects missing required field", () => {
    expect(shipInputSchema.safeParse({ repo: "ship", docPath: "x" }).success).toBe(false);
    expect(shipInputSchema.safeParse({ workdir: "/w", repo: "ship" }).success).toBe(false);
    expect(shipInputSchema.safeParse({ workdir: "/w", docPath: "x" }).success).toBe(false);
  });

  test("rejects empty string in required field", () => {
    expect(shipInputSchema.safeParse({ workdir: "", repo: "ship", docPath: "x" }).success).toBe(
      false,
    );
    expect(shipInputSchema.safeParse({ workdir: "/w", repo: "", docPath: "x" }).success).toBe(
      false,
    );
    expect(shipInputSchema.safeParse({ workdir: "/w", repo: "ship", docPath: "" }).success).toBe(
      false,
    );
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

  test("rejects non-terminal status (pending / running)", () => {
    expect(shipOutputSchema.safeParse({ ...validOutput, status: "pending" }).success).toBe(false);
    expect(shipOutputSchema.safeParse({ ...validOutput, status: "running" }).success).toBe(false);
  });

  test("rejects a still-running cursorRun", () => {
    expect(
      shipOutputSchema.safeParse({
        ...validOutput,
        cursorRun: { ...validCursorRunRef, status: "running" },
      }).success,
    ).toBe(false);
  });

  test("accepts each terminal status / cursor-run status combination", () => {
    for (const s of ["succeeded", "failed", "cancelled"] as const) {
      expect(
        shipOutputSchema.safeParse({
          ...validOutput,
          status: s,
          cursorRun: { ...validCursorRunRef, status: s },
        }).success,
      ).toBe(true);
    }
  });
});

describe("shipStartOutputSchema", () => {
  const validStart: ShipStartOutput = { workflowRunId: WF_ID, status: "running" };

  test("accepts a valid start output", () => {
    expect(shipStartOutputSchema.parse(validStart)).toEqual(validStart);
  });

  test("rejects unknown keys", () => {
    expect(shipStartOutputSchema.safeParse({ ...validStart, extra: 1 }).success).toBe(false);
  });

  test("rejects malformed workflowRunId", () => {
    expect(
      shipStartOutputSchema.safeParse({ workflowRunId: "wf_short", status: "running" }).success,
    ).toBe(false);
    expect(
      shipStartOutputSchema.safeParse({
        workflowRunId: "ph_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        status: "running",
      }).success,
    ).toBe(false);
  });

  test("rejects status other than running (literal-pinned)", () => {
    for (const s of ["pending", "succeeded", "failed", "cancelled"]) {
      expect(shipStartOutputSchema.safeParse({ workflowRunId: WF_ID, status: s }).success).toBe(
        false,
      );
    }
  });

  test("rejects missing fields", () => {
    expect(shipStartOutputSchema.safeParse({ status: "running" }).success).toBe(false);
    expect(shipStartOutputSchema.safeParse({ workflowRunId: WF_ID }).success).toBe(false);
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

  test("rejects ULID body whose first char is outside 0-7 (non-canonical ULID)", () => {
    // 8 onward is impossible for a real ULID — the first base32 char only
    // encodes 3 bits of the 48-bit timestamp.
    expect(
      getWorkflowRunInputSchema.safeParse({ workflowRunId: "wf_8ARZ3NDEKTSV4RRFFQ69G5FAV" })
        .success,
    ).toBe(false);
    expect(
      getWorkflowRunInputSchema.safeParse({ workflowRunId: "wf_ZARZ3NDEKTSV4RRFFQ69G5FAV" })
        .success,
    ).toBe(false);
  });

  test("accepts ULID body whose first char is each of 0-7", () => {
    for (const first of ["0", "1", "2", "3", "4", "5", "6", "7"]) {
      const id = `wf_${first}1ARZ3NDEKTSV4RRFFQ69G5FAV`;
      expect(getWorkflowRunInputSchema.safeParse({ workflowRunId: id }).success).toBe(true);
    }
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

  test("accepts optional cursorAgentId and watchUrl for cloud runs", () => {
    const withWatch = {
      ...validWorkflowRun,
      cursorAgentId: "bc-test-agent-0001",
      watchUrl: "https://cursor.com/agents/bc-test-agent-0001",
    };
    expect(getWorkflowRunOutputSchema.parse(withWatch)).toEqual(withWatch);
  });

  test("rejects unknown keys", () => {
    expect(getWorkflowRunOutputSchema.safeParse({ ...validWorkflowRun, extra: 1 }).success).toBe(
      false,
    );
  });

  test("rejects invalid watchUrl", () => {
    expect(
      getWorkflowRunOutputSchema.safeParse({
        ...validWorkflowRun,
        cursorAgentId: "bc-x",
        watchUrl: "not-a-url",
      }).success,
    ).toBe(false);
  });

  test("accepts failure diagnostics and round-trips them", () => {
    const withDiagnostics = {
      ...validWorkflowRun,
      status: "failed" as const,
      runDurationMs: 1_620_000,
      maxRunDurationMs: DEFAULT_WORKFLOW_POLICY.maxRunDurationMs,
      sdkTerminalStatus: "ERROR",
      recentEvents: [{ type: "status", status: "ERROR" }],
    };
    expect(getWorkflowRunOutputSchema.parse(withDiagnostics)).toEqual(withDiagnostics);
  });

  test("accepts branches[] (cloud + rooms pushed branches) and round-trips them", () => {
    const withBranches = {
      ...validWorkflowRun,
      branches: [{ repoUrl: "https://github.com/itsHabib/roxiq", branch: "rooms/ship-x-abcd1234" }],
    };
    expect(getWorkflowRunOutputSchema.parse(withBranches)).toEqual(withBranches);
  });

  test("rejects branch entry missing repoUrl", () => {
    expect(
      getWorkflowRunOutputSchema.safeParse({
        ...validWorkflowRun,
        branches: [{ branch: "rooms/x" }],
      }).success,
    ).toBe(false);
  });

  test("accepts optional failureCategory on failed runs and omits on succeeded", () => {
    const failed = {
      ...validWorkflowRun,
      status: "failed" as const,
      failureCategory: "logic" as const,
    };
    expect(getWorkflowRunOutputSchema.parse(failed)).toEqual(failed);
    expect(getWorkflowRunOutputSchema.parse(validWorkflowRun)).toEqual(validWorkflowRun);
  });

  test("rejects invalid failureCategory literals", () => {
    expect(
      getWorkflowRunOutputSchema.safeParse({
        ...validWorkflowRun,
        status: "failed",
        failureCategory: "not-a-category",
      }).success,
    ).toBe(false);
  });

  test("rejects failureCategory on non-failed runs (present-iff-failed invariant)", () => {
    for (const status of ["succeeded", "cancelled", "running", "pending"] as const) {
      expect(
        getWorkflowRunOutputSchema.safeParse({
          ...validWorkflowRun,
          status,
          failureCategory: "logic",
        }).success,
      ).toBe(false);
    }
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

  test("accepts each terminal status (already-terminal runs return what we found)", () => {
    for (const s of ["succeeded", "failed", "cancelled"] as const) {
      expect(
        cancelWorkflowRunOutputSchema.safeParse({ workflowRunId: WF_ID, status: s }).success,
      ).toBe(true);
    }
  });

  test("rejects non-terminal status (pending / running) — cancel always returns terminal", () => {
    expect(
      cancelWorkflowRunOutputSchema.safeParse({ workflowRunId: WF_ID, status: "pending" }).success,
    ).toBe(false);
    expect(
      cancelWorkflowRunOutputSchema.safeParse({ workflowRunId: WF_ID, status: "running" }).success,
    ).toBe(false);
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

describe("driver MCP schemas", () => {
  const DRV_ID = "drv_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const DS_ID = "ds_01ARZ3NDEKTSV4RRFFQ69G5FAV";

  test("driverRunInputSchema defaults maxWaitMs to 0", () => {
    const parsed = driverRunInputSchema.parse({ driverRunId: DRV_ID });
    expect(parsed.maxWaitMs).toBe(0);
  });

  test("driverRunInputSchema requires exactly one ref", () => {
    expect(driverRunInputSchema.safeParse({}).success).toBe(false);
    expect(
      driverRunInputSchema.safeParse({ driverRunId: DRV_ID, manifestPath: "/x.md" }).success,
    ).toBe(false);
  });

  test("driverTickResultSchema accepts a zero-attempt failure-triage (dispatch-time failure)", () => {
    const result = {
      driverRunId: DRV_ID,
      status: "awaiting_judgment",
      awaiting: [
        {
          kind: "failure-triage",
          driverRunId: DRV_ID,
          streamId: DS_ID,
          failureCategory: "unknown",
          attempts: 0,
        },
      ],
      unmerged: [],
      progress: { batchIndex: 1, dispatched: 0, landed: 0, failed: 1, remaining: 0 },
      streams: [],
    };
    expect(driverTickResultSchema.safeParse(result).success).toBe(true);
  });

  test("driverDecideInputSchema accepts retry/skip/abort/adopt decisions", () => {
    expect(
      driverDecideInputSchema.safeParse({
        driverRunId: DRV_ID,
        streamId: DS_ID,
        decision: { kind: "retry" },
      }).success,
    ).toBe(true);
    expect(
      driverDecideInputSchema.safeParse({
        driverRunId: DRV_ID,
        streamId: DS_ID,
        decision: { kind: "skip", reason: "n/a" },
      }).success,
    ).toBe(true);
    expect(
      driverDecideInputSchema.safeParse({
        driverRunId: DRV_ID,
        streamId: DS_ID,
        decision: { kind: "abort", reason: "n/a" },
      }).success,
    ).toBe(true);
    expect(
      driverDecideInputSchema.safeParse({
        driverRunId: DRV_ID,
        streamId: DS_ID,
        decision: { kind: "adopt", workflowRunId: WF_ID },
      }).success,
    ).toBe(true);
  });
});

/** Tests for `format.ts` — pretty + JSON variants per output shape. */

import type { GetWorkflowRunOutput, ShipOutput } from "@ship/core";
import type { WorkflowRun } from "@ship/workflow";

import { getWorkflowRunOutputSchema } from "@ship/mcp";
import { createStore, newDriverBatchId, newDriverRunId, newDriverStreamId } from "@ship/store";
import { describe, expect, test } from "vitest";

import {
  formatCancelOutput,
  formatDiagnoseRun,
  formatDriverAssignOutput,
  formatDriverImportOutput,
  formatDriverListOutput,
  formatDriverRunOutput,
  formatDriverStatusOutput,
  formatShipOutput,
  formatWorkflowRun,
  formatWorkflowRunList,
  summarizeCursorRun,
} from "./format.js";

const SAMPLE_OUTPUT: ShipOutput = {
  workflowRunId: "wf_01J0000000000000000000000A",
  status: "succeeded",
  worktree: { repo: "ship", name: "feat", branch: "main", path: "/work/wt", baseRef: "main" },
  cursorRun: {
    id: "cr_01",
    agentId: "agent-1",
    provider: "cursor",
    runtime: "local",
    status: "succeeded",
    startedAt: "2026-05-10T00:00:00.000Z",
    endedAt: "2026-05-10T00:00:01.000Z",
    artifactsDir: "/state/runs/wf_1",
  },
  artifacts: {
    promptPath: "/state/runs/wf_1/prompt.md",
    eventsPath: "/state/runs/wf_1/events.ndjson",
    resultPath: "/state/runs/wf_1/result.json",
  },
  summary: "shipped",
};

const SAMPLE_RUN: WorkflowRun = {
  id: "wf_01J0000000000000000000000A",
  repo: "ship",
  docPath: "docs.md",
  status: "succeeded",
  baseRef: "main",
  worktree: SAMPLE_OUTPUT.worktree,
  policy: { baseRef: "main", maxRunDurationMs: 1, agentTimeoutMs: 1 },
  createdAt: "2026-05-10T00:00:00.000Z",
  updatedAt: "2026-05-10T00:00:02.000Z",
  phases: [
    {
      id: "ph_01",
      workflowRunId: "wf_01J0000000000000000000000A",
      kind: "implement",
      inputJson: "{}",
      status: "succeeded",
      startedAt: "2026-05-10T00:00:00.500Z",
      endedAt: "2026-05-10T00:00:02.000Z",
      cursorRunId: "cr_01",
    },
  ],
};

describe("formatDriverImportOutput", () => {
  test("emits driverRunId only when there are no warnings", () => {
    expect(formatDriverImportOutput("drv_01")).toBe('{"driverRunId":"drv_01"}');
  });

  test("includes warnings when present", () => {
    const text = formatDriverImportOutput("drv_01", [
      'line 10: unknown field "base_branch" at manifest root',
    ]);
    expect(JSON.parse(text)).toEqual({
      driverRunId: "drv_01",
      warnings: ['line 10: unknown field "base_branch" at manifest root'],
    });
  });
});

describe("formatDriverAssignOutput", () => {
  test("renders the pool header, per-stream rows, and skipped streams", () => {
    const text = formatDriverAssignOutput({
      text: "",
      pool: [
        { provider: "cursor", modelId: "grok-4.5" },
        { provider: "claude", modelId: "claude-opus-4-8", runtime: "local" },
      ],
      effectivePool: [
        { provider: "cursor", modelId: "grok-4.5" },
        { provider: "claude", modelId: "claude-opus-4-8", runtime: "local" },
      ],
      dropped: [],
      assignments: [
        {
          batchPos: 0,
          streamPos: 0,
          specPath: "docs/a.md",
          provider: "cursor",
          modelId: "grok-4.5",
          resolvedRuntime: "cloud",
        },
      ],
      skipped: [{ specPath: "docs/b.md", status: "done" }],
    });
    expect(text).toContain(
      "assigned 1 stream(s) from pool [cursor:grok-4.5, local/claude:claude-opus-4-8]",
    );
    expect(text).toContain("docs/a.md -> cloud/cursor:grok-4.5");
    expect(text).toContain("docs/b.md -> skipped (done)");
  });

  test("renders members dropped by preflight with their reason", () => {
    const text = formatDriverAssignOutput({
      text: "",
      pool: [
        { provider: "cursor", modelId: "grok-4.5" },
        { provider: "cursor", modelId: "ghost-1" },
      ],
      effectivePool: [{ provider: "cursor", modelId: "grok-4.5" }],
      dropped: [
        { member: { provider: "cursor", modelId: "ghost-1" }, reason: "not in /v1/models" },
      ],
      assignments: [
        {
          batchPos: 0,
          streamPos: 0,
          specPath: "docs/a.md",
          provider: "cursor",
          modelId: "grok-4.5",
          resolvedRuntime: "cloud",
        },
      ],
      skipped: [],
    });
    expect(text).toContain("dropped cursor:ghost-1 (not in /v1/models)");
  });
});

describe("formatDriverRunOutput", () => {
  const BASE_TICK = {
    driverRunId: "drv_01",
    status: "done" as const,
    awaiting: [],
    unmerged: [],
    progress: {
      batchIndex: 1,
      dispatched: 0,
      landed: 0,
      failed: 0,
      remaining: 0,
    },
    streams: [],
  };

  test("text mode appends warnings line when import warnings are present", () => {
    const warnings = ['line 10: unknown field "base_branch" at manifest root'];
    const text = formatDriverRunOutput({ ...BASE_TICK, warnings }, false);
    expect(text).toContain("driverRunId: drv_01");
    expect(text).toContain(`warnings:    ${JSON.stringify(warnings)}`);
  });

  test("text mode omits warnings line when absent", () => {
    const text = formatDriverRunOutput(BASE_TICK, false);
    expect(text).not.toContain("warnings:");
  });

  test("--json includes warnings in the tick result object", () => {
    const warnings = ['line 10: unknown field "base_branch" at manifest root'];
    const parsed = JSON.parse(formatDriverRunOutput({ ...BASE_TICK, warnings }, true)) as {
      warnings?: string[];
    };
    expect(parsed.warnings).toEqual(warnings);
  });
});

describe("formatDriverListOutput", () => {
  const SAMPLE_ENVELOPE = {
    runs: [
      {
        batches: [],
        createdAt: "2026-05-10T00:00:00.000Z",
        driverRunId: "drv_01J0000000000000000000000A",
        repo: "ship",
        sourceHash: "abc123",
        status: "pending" as const,
        updatedAt: "2026-05-10T00:00:02.000Z",
      },
    ],
    v: 1 as const,
  };

  test("empty list prints header only", () => {
    const text = formatDriverListOutput({ runs: [], v: 1 }, false);
    const lines = text.split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("DRIVER RUN ID");
  });

  test("non-empty list prints header + one row per run", () => {
    const text = formatDriverListOutput(SAMPLE_ENVELOPE, false);
    expect(text.split("\n")).toHaveLength(2);
    expect(text).toContain("drv_01J0000000000000000000000A");
  });

  test("--json emits versioned envelope", () => {
    expect(JSON.parse(formatDriverListOutput(SAMPLE_ENVELOPE, true))).toEqual(SAMPLE_ENVELOPE);
  });
});

describe("formatShipOutput", () => {
  test("pretty mode lists status, id, summary, artifact paths", () => {
    const text = formatShipOutput(SAMPLE_OUTPUT, false);
    expect(text).toContain("status:        succeeded");
    expect(text).toContain("workflowRunId: wf_01J0000000000000000000000A");
    expect(text).toContain("summary:       shipped");
    expect(text).toContain("/state/runs/wf_1/prompt.md");
    expect(text).toContain("/state/runs/wf_1/events.ndjson");
    expect(text).toContain("/state/runs/wf_1/result.json");
  });

  test("pretty mode omits the summary line when summary is unset", () => {
    const without: ShipOutput = { ...SAMPLE_OUTPUT };
    delete (without as { summary?: string }).summary;
    const text = formatShipOutput(without, false);
    expect(text).not.toContain("summary:");
  });

  test("--json emits parseable JSON that round-trips", () => {
    const text = formatShipOutput(SAMPLE_OUTPUT, true);
    expect(JSON.parse(text)).toEqual(SAMPLE_OUTPUT);
  });
});

describe("formatWorkflowRun", () => {
  test("pretty mode lists id, status, repo, docPath, timestamps, phases", () => {
    const text = formatWorkflowRun(SAMPLE_RUN, false);
    expect(text).toContain("id:        wf_01J0000000000000000000000A");
    expect(text).toContain("status:    succeeded");
    expect(text).toContain("repo:      ship");
    expect(text).toContain("docPath:   docs.md");
    expect(text).toContain("createdAt: 2026-05-10T00:00:00.000Z");
    expect(text).toContain("- implement: succeeded");
  });

  test("phase errorMessage is appended when present", () => {
    const failed: WorkflowRun = {
      ...SAMPLE_RUN,
      phases: SAMPLE_RUN.phases[0]
        ? [{ ...SAMPLE_RUN.phases[0], status: "failed", errorMessage: "boom" }]
        : [],
    };
    expect(formatWorkflowRun(failed, false)).toContain("- implement: failed (boom)");
  });

  test("--json emits parseable JSON that round-trips", () => {
    expect(JSON.parse(formatWorkflowRun(SAMPLE_RUN, true))).toEqual(SAMPLE_RUN);
  });
});

describe("formatWorkflowRunList", () => {
  test("empty list prints header only", () => {
    const text = formatWorkflowRunList([], false);
    const lines = text.split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("ID");
    expect(lines[0]).toContain("STATUS");
  });

  test("non-empty list prints header + one row per run", () => {
    const text = formatWorkflowRunList([SAMPLE_RUN, SAMPLE_RUN], false);
    expect(text.split("\n")).toHaveLength(3);
  });

  test("--json emits { runs: [...] }", () => {
    const text = formatWorkflowRunList([SAMPLE_RUN], true);
    expect(JSON.parse(text)).toEqual({ runs: [SAMPLE_RUN] });
  });

  test("--json passes through observability on list rows", () => {
    const row = {
      ...SAMPLE_RUN,
      observability: {
        actual: { runtime: "local" as const, provider: "cursor" as const },
        evidence: {
          availability: "unavailable" as const,
          reason: "no-persisted-artifact-manifest",
        },
      },
    };
    const text = formatWorkflowRunList([row], true);
    expect(JSON.parse(text)).toEqual({ runs: [row] });
  });
});

describe("formatCancelOutput", () => {
  test("pretty mode lists status + id", () => {
    const text = formatCancelOutput(
      { workflowRunId: "wf_01J0000000000000000000000A", status: "cancelled" },
      false,
    );
    expect(text).toContain("status: cancelled");
    expect(text).toContain("workflowRunId: wf_01J0000000000000000000000A");
  });

  test("--json emits the envelope", () => {
    const text = formatCancelOutput(
      { workflowRunId: "wf_01J0000000000000000000000A", status: "cancelled" },
      true,
    );
    expect(JSON.parse(text)).toEqual({
      workflowRunId: "wf_01J0000000000000000000000A",
      status: "cancelled",
    });
  });
});

describe("summarizeCursorRun", () => {
  test("includes id, status, runtime", () => {
    expect(summarizeCursorRun(SAMPLE_OUTPUT.cursorRun)).toBe("cr_01 (succeeded, local)");
  });
});

const SAMPLE_DIAGNOSE_RUN: GetWorkflowRunOutput = {
  ...SAMPLE_RUN,
  status: "failed",
  failureCategory: "logic",
  runDurationMs: 360_000,
  maxRunDurationMs: 1_800_000,
  sdkTerminalStatus: "ERROR",
  watchUrl: "https://cursor.com/agents/agent-1",
  recentEvents: [
    { type: "tool_call", name: "shell", status: "running", ts: "2026-06-01T12:04:12.000Z" },
  ],
  phases: SAMPLE_RUN.phases[0]
    ? [
        {
          ...SAMPLE_RUN.phases[0],
          status: "failed",
          errorMessage: "logic; make check failed",
        },
      ]
    : [],
};

describe("formatDiagnoseRun", () => {
  test("pretty mode renders diagnosis fields for a failed run", () => {
    const text = formatDiagnoseRun(SAMPLE_DIAGNOSE_RUN, false);
    expect(text).toContain("status:    failed");
    expect(text).toContain("category:  logic");
    expect(text).toContain("error:     logic; make check failed");
    expect(text).toContain("duration:  360000ms / cap 1800000ms");
    expect(text).toContain("sdkStatus: ERROR");
    expect(text).toContain("last:      shell running (2026-06-01T12:04:12.000Z)");
    expect(text).toContain("watchUrl:  https://cursor.com/agents/agent-1");
  });

  test("renders enriched sdk-throw errorMessage with HTTP status/code line", () => {
    const enriched: GetWorkflowRunOutput = {
      ...SAMPLE_DIAGNOSE_RUN,
      failureCategory: "sdk-throw",
      phases: SAMPLE_DIAGNOSE_RUN.phases[0]
        ? [
            {
              ...SAMPLE_DIAGNOSE_RUN.phases[0],
              errorMessage:
                "sdk-throw; agent.send failed after Agent.create (HTTP 400 invalid_request_error, request_id req_abc)",
            },
          ]
        : [],
    };
    const text = formatDiagnoseRun(enriched, false);
    expect(text).toContain("category:  sdk-throw");
    expect(text).toContain("HTTP 400 invalid_request_error");
    expect(text).toContain("request_id req_abc");
  });

  test("non-failed run prints a nothing-to-diagnose note", () => {
    const text = formatDiagnoseRun(SAMPLE_RUN, false);
    expect(text).toContain("status:    succeeded");
    expect(text).toContain("note:      nothing to diagnose");
    expect(text).not.toContain("category:");
  });

  test("failed run without a persisted category renders (unclassified)", () => {
    const unclassified: GetWorkflowRunOutput = { ...SAMPLE_DIAGNOSE_RUN };
    delete (unclassified as { failureCategory?: unknown }).failureCategory;
    const text = formatDiagnoseRun(unclassified, false);
    expect(text).toContain("category:  (unclassified)");
  });

  test("omits last activity when recentEvents is absent", () => {
    const withoutEvents: GetWorkflowRunOutput = { ...SAMPLE_DIAGNOSE_RUN };
    delete (withoutEvents as { recentEvents?: unknown }).recentEvents;
    const text = formatDiagnoseRun(withoutEvents, false);
    expect(text).not.toContain("last:");
  });

  test("falls back to the last event type when no tool_call exists", () => {
    const statusOnly: GetWorkflowRunOutput = {
      ...SAMPLE_DIAGNOSE_RUN,
      recentEvents: [{ type: "status", status: "ERROR" }],
    };
    expect(formatDiagnoseRun(statusOnly, false)).toContain("last:      status");
  });

  test("--json emits the enriched GetWorkflowRunOutput", () => {
    const parsed = JSON.parse(formatDiagnoseRun(SAMPLE_DIAGNOSE_RUN, true)) as GetWorkflowRunOutput;
    expect(parsed).toEqual(SAMPLE_DIAGNOSE_RUN);
    expect(getWorkflowRunOutputSchema.parse(parsed)).toEqual(SAMPLE_DIAGNOSE_RUN);
  });
});

describe("formatDriverStatusOutput", () => {
  test("renders per-stream tier and fallback diagnostic lines", () => {
    const store = createStore({ dbPath: ":memory:" });
    const runId = newDriverRunId();
    store.insertDriverRun({
      batches: [
        {
          batchIndex: 1,
          dependsOn: [],
          id: newDriverBatchId(),
          status: "pending",
          streams: [
            {
              attempts: [],
              fallbackChain: [{ provider: "claude", runtime: "local" }],
              fallbackCursor: 1,
              fallbackLog: [
                {
                  from: { provider: "cursor", runtime: "cloud" },
                  to: { provider: "claude", runtime: "local" },
                  category: "gateway-auth",
                  at: "2026-07-13T00:00:00.000Z",
                },
              ],
              id: newDriverStreamId(),
              modelTier: "opus",
              runtime: "local",
              specPath: "docs/a.md",
              status: "pending",
              streamIndex: 0,
              taskSlug: "alpha",
              touches: [],
            },
          ],
        },
      ],
      id: runId,
      manifestPath: "/tmp/driver.md",
      repo: "ship",
      sourceJson: "---\ndriver_version: 1\n---\n",
      status: "pending",
    });

    const run = store.getDriverRun(runId);
    expect(run).not.toBeNull();
    const text = formatDriverStatusOutput(run!, false, false);
    expect(text).toMatch(/stream\[1\] alpha: .*requested=opus/);
    expect(text).toContain(
      "stream[1] alpha: fallback: cloud/cursor → local/claude on gateway-auth",
    );
    store.close();
  });

  test("renders the triage classification line", () => {
    const store = createStore({ dbPath: ":memory:" });
    const runId = newDriverRunId();
    const streamId = newDriverStreamId();
    store.insertDriverRun({
      batches: [
        {
          batchIndex: 1,
          dependsOn: [],
          id: newDriverBatchId(),
          status: "running",
          streams: [
            {
              attempts: [],
              id: streamId,
              runtime: "cloud",
              specPath: "docs/a.md",
              status: "landed",
              streamIndex: 0,
              taskSlug: "alpha",
              touches: [],
            },
          ],
        },
      ],
      id: runId,
      manifestPath: "/tmp/driver.md",
      repo: "ship",
      sourceJson: "---\ndriver_version: 1\n---\n",
      status: "running",
    });
    // Triage is engine-computed post-land — persisted via updateDriverStream.
    store.updateDriverStream(streamId, {
      triageHeadSha: "abc1234def",
      triageTier: "T1",
      triageTierSource: "classified",
    });

    const run = store.getDriverRun(runId);
    const text = formatDriverStatusOutput(run!, false, false);
    expect(text).toContain("stream[1] alpha: triage=T1 (classified, head abc1234)");
    store.close();
  });
});

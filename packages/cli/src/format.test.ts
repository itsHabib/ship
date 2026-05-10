/** Tests for `format.ts` — pretty + JSON variants per output shape. */

import type { ShipOutput } from "@ship/core";
import type { WorkflowRun } from "@ship/workflow";

import { describe, expect, test } from "vitest";

import {
  formatCancelOutput,
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

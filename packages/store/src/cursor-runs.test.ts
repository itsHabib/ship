/** Tests for `cursor-runs.ts` via the public `createStore` API. */

import type { ModelSelection, WorkflowPolicy, WorktreeRef } from "@ship/workflow";

import { newCursorRunId, newWorkflowRunId } from "@ship/workflow";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { Store } from "./store.js";

import { CursorRunNotFoundError, WorkflowRunNotFoundError } from "./errors.js";
import { createStore } from "./store.js";

const validWorktree: WorktreeRef = {
  baseRef: "main",
  branch: "ship/feat-x",
  name: "feat-x",
  path: "/repo/.worktrees/feat-x",
  repo: "ship",
};

const validPolicy: WorkflowPolicy = {
  agentTimeoutMs: 30 * 60 * 1000,
  baseRef: "main",
  maxRunDurationMs: 30 * 60 * 1000,
};

describe("cursor runs (via createStore)", () => {
  let store: Store;
  let currentNow: string;

  beforeEach(() => {
    currentNow = "2026-05-08T00:00:00.000Z";
    store = createStore({ clock: () => currentNow, dbPath: ":memory:" });
  });

  afterEach(() => {
    store.close();
  });

  function seedRun(): string {
    const id = newWorkflowRunId();
    store.createWorkflowRun({
      baseRef: "main",
      docPath: "docs/x.md",
      id,
      policy: validPolicy,
      repo: "ship",
      worktree: validWorktree,
    });
    return id;
  }

  test("recordCursorRun: row appears with status running and startedAt = clock()", () => {
    const runId = seedRun();
    const cursorRunId = newCursorRunId();
    const ref = store.recordCursorRun({
      agentId: "agent_xyz",
      artifactsDir: "/runs/wf_x",
      id: cursorRunId,
      runtime: "local",
      workflowRunId: runId,
    });
    expect(ref.id).toBe(cursorRunId);
    expect(ref.agentId).toBe("agent_xyz");
    expect(ref.runtime).toBe("local");
    expect(ref.status).toBe("running");
    expect(ref.startedAt).toBe(currentNow);
    expect(ref.artifactsDir).toBe("/runs/wf_x");
    expect(ref.provider).toBe("cursor");
    expect(ref.endedAt).toBeUndefined();
    expect(ref.durationMs).toBeUndefined();
    expect(ref.model).toBeUndefined();
  });

  test("recordCursorRun + getCursorRun: round-trip via point-read", () => {
    const runId = seedRun();
    const id = newCursorRunId();
    const recorded = store.recordCursorRun({
      agentId: "agent_xyz",
      artifactsDir: "/runs/wf_x",
      id,
      runtime: "local",
      workflowRunId: runId,
    });
    const fetched = store.getCursorRun(id);
    expect(fetched).toEqual(recorded);
  });

  test("recordCursorRun with provider claude round-trips non-default provider", () => {
    const runId = seedRun();
    const id = newCursorRunId();
    store.recordCursorRun({
      agentId: "agent_claude",
      artifactsDir: "/runs/wf_claude",
      id,
      provider: "claude",
      runtime: "local",
      workflowRunId: runId,
    });
    expect(store.getCursorRun(id)?.provider).toBe("claude");
  });

  test("recordCursorRun with provider codex round-trips non-default provider", () => {
    const runId = seedRun();
    const id = newCursorRunId();
    store.recordCursorRun({
      agentId: "agent_codex",
      artifactsDir: "/runs/wf_codex",
      id,
      provider: "codex",
      runtime: "local",
      workflowRunId: runId,
    });
    expect(store.getCursorRun(id)?.provider).toBe("codex");
  });

  test("getCursorRun: unknown id returns null (does not throw)", () => {
    expect(store.getCursorRun(newCursorRunId())).toBeNull();
  });

  test("recordCursorRun for unknown workflowRunId: WorkflowRunNotFoundError", () => {
    expect(() =>
      store.recordCursorRun({
        agentId: "agent_xyz",
        artifactsDir: "/runs/wf_x",
        id: newCursorRunId(),
        runtime: "local",
        workflowRunId: newWorkflowRunId(),
      }),
    ).toThrow(WorkflowRunNotFoundError);
  });

  test("recordCursorRun: optional model round-trips through the JSON column", () => {
    const runId = seedRun();
    const id = newCursorRunId();
    const model: ModelSelection = {
      id: "composer-2",
      params: [{ id: "temperature", value: "0.5" }],
    };
    store.recordCursorRun({
      agentId: "agent_xyz",
      artifactsDir: "/runs/wf_x",
      id,
      model,
      runtime: "local",
      workflowRunId: runId,
    });
    const fetched = store.getCursorRun(id);
    expect(fetched?.model).toEqual(model);
  });

  test("updateCursorRunStatus: status / endedAt / durationMs round-trip", () => {
    const runId = seedRun();
    const id = newCursorRunId();
    store.recordCursorRun({
      agentId: "agent_xyz",
      artifactsDir: "/runs/wf_x",
      id,
      runtime: "local",
      workflowRunId: runId,
    });

    currentNow = "2026-05-08T00:01:00.000Z";
    const updated = store.updateCursorRunStatus(id, {
      durationMs: 60_000,
      endedAt: currentNow,
      status: "succeeded",
    });
    expect(updated.status).toBe("succeeded");
    expect(updated.endedAt).toBe(currentNow);
    expect(updated.durationMs).toBe(60_000);
  });

  test("updateCursorRunStatus: fractional durationMs is rounded to a whole ms", () => {
    // SDK terminals report fractional wall time; duration_ms is an integer
    // column and the read-back Zod parse is `.int()`. Without rounding at the
    // persistence boundary the txn rolls back and strands a completed run.
    const runId = seedRun();
    const id = newCursorRunId();
    store.recordCursorRun({
      agentId: "agent_frac",
      artifactsDir: "/runs/wf_x",
      id,
      runtime: "local",
      workflowRunId: runId,
    });

    const updated = store.updateCursorRunStatus(id, {
      durationMs: 3_723_030.9877,
      endedAt: "2026-05-08T00:01:00.000Z",
      status: "succeeded",
    });
    expect(updated.durationMs).toBe(3_723_031);
    expect(store.getCursorRun(id)?.durationMs).toBe(3_723_031);
  });

  test("updateCursorRunStatus: negative fractional durationMs still rolls back", () => {
    // Rounding must not slip a negative past the nonnegative guard: -0.1 must
    // NOT become -0 and commit. Left unrounded it fails int/nonnegative and the
    // txn rolls back, preserving the negative-duration rejection invariant.
    const runId = seedRun();
    const id = newCursorRunId();
    store.recordCursorRun({
      agentId: "agent_neg",
      artifactsDir: "/runs/wf_x",
      id,
      runtime: "local",
      workflowRunId: runId,
    });

    expect(() => store.updateCursorRunStatus(id, { durationMs: -0.1 })).toThrow();
    expect(store.getCursorRun(id)?.durationMs).toBeUndefined();
  });

  test("updateCursorRunStatus persists artifacts; getCursorRun round-trips them", () => {
    const runId = seedRun();
    const id = newCursorRunId();
    store.recordCursorRun({
      agentId: "bc-art",
      artifactsDir: "/runs/wf_x",
      id,
      runtime: "cloud",
      workflowRunId: runId,
    });
    const artifacts = [
      { path: "out/report.txt", sizeBytes: 14, updatedAt: "2026-05-29T00:00:00.000Z" },
      { path: "build/app.bin", sizeBytes: 2048, updatedAt: "2026-05-29T00:01:00.000Z" },
    ];
    const updated = store.updateCursorRunStatus(id, { artifacts });
    expect(updated.artifacts).toEqual(artifacts);
    // Read back exercises parseCursorRun's artifacts_json → ArtifactRef[] branch.
    expect(store.getCursorRun(id)?.artifacts).toEqual(artifacts);
  });

  test("updateCursorRunStatus: empty patch returns the current row", () => {
    const runId = seedRun();
    const id = newCursorRunId();
    const recorded = store.recordCursorRun({
      agentId: "agent_xyz",
      artifactsDir: "/runs/wf_x",
      id,
      runtime: "local",
      workflowRunId: runId,
    });
    const noop = store.updateCursorRunStatus(id, {});
    expect(noop).toEqual(recorded);
  });

  test("updateCursorRunStatus: unknown id throws CursorRunNotFoundError (with patch)", () => {
    expect(() => store.updateCursorRunStatus(newCursorRunId(), { status: "succeeded" })).toThrow(
      CursorRunNotFoundError,
    );
  });

  test("updateCursorRunStatus: unknown id throws CursorRunNotFoundError (empty patch path)", () => {
    expect(() => store.updateCursorRunStatus(newCursorRunId(), {})).toThrow(CursorRunNotFoundError);
  });

  test("updateCursorRunStatus: invalid post-state rolls back (durationMs negative)", () => {
    // Schema demands nonnegative durationMs; the txn-wrap rolls back on Zod failure.
    const runId = seedRun();
    const id = newCursorRunId();
    store.recordCursorRun({
      agentId: "agent_xyz",
      artifactsDir: "/runs/wf_x",
      id,
      runtime: "local",
      workflowRunId: runId,
    });

    expect(() => store.updateCursorRunStatus(id, { durationMs: -1 })).toThrow();

    // Row must still match its pre-call shape.
    const fetched = store.getCursorRun(id);
    expect(fetched?.durationMs).toBeUndefined();
    expect(fetched?.status).toBe("running");
  });

  describe("listResumableCloudCursorRuns", () => {
    test("empty store returns empty array", () => {
      expect(store.listResumableCloudCursorRuns()).toEqual([]);
    });

    test("cloud row with run_id is returned (happy path)", () => {
      const wfId = seedRun();
      const cursorRunId = newCursorRunId();
      const model: ModelSelection = { id: "composer-2.5" };
      store.recordCursorRun({
        agentId: "bc-test-001",
        artifactsDir: "/runs/wf_x",
        id: cursorRunId,
        model,
        runId: "run-test-001",
        runtime: "cloud",
        workflowRunId: wfId,
      });

      const resumable = store.listResumableCloudCursorRuns();
      expect(resumable).toHaveLength(1);
      expect(resumable[0]).toEqual({
        agentId: "bc-test-001",
        artifactsDir: "/runs/wf_x",
        id: cursorRunId,
        model,
        provider: "cursor",
        runId: "run-test-001",
        workflowRunId: wfId,
      });
    });

    test("claude-cloud row surfaces provider: 'claude' for resume routing (FR7)", () => {
      const wfId = seedRun();
      const cursorRunId = newCursorRunId();
      store.recordCursorRun({
        agentId: "ses-claude-001",
        artifactsDir: "/runs/wf_claude",
        id: cursorRunId,
        provider: "claude",
        runId: "ses-claude-001",
        runtime: "cloud",
        workflowRunId: wfId,
      });

      const resumable = store.listResumableCloudCursorRuns();
      expect(resumable).toHaveLength(1);
      expect(resumable[0]?.provider).toBe("claude");
    });

    test("cloud row WITHOUT run_id is skipped (pre-migration legacy)", () => {
      const wfId = seedRun();
      const cursorRunId = newCursorRunId();
      store.recordCursorRun({
        agentId: "bc-test-002",
        artifactsDir: "/runs/wf_y",
        id: cursorRunId,
        // runId intentionally omitted — legacy row, no SDK run id persisted
        runtime: "cloud",
        workflowRunId: wfId,
      });

      expect(store.listResumableCloudCursorRuns()).toEqual([]);
    });

    test("local row is skipped regardless of run_id presence", () => {
      const wfId = seedRun();
      store.recordCursorRun({
        agentId: "agent-local-001",
        artifactsDir: "/runs/wf_z",
        id: newCursorRunId(),
        runId: "run-local-001",
        runtime: "local",
        workflowRunId: wfId,
      });

      expect(store.listResumableCloudCursorRuns()).toEqual([]);
    });

    test("only resumable cloud rows are returned from a mixed set", () => {
      const wfId = seedRun();
      // Cloud + run_id → returned
      const cloudWithRun = newCursorRunId();
      store.recordCursorRun({
        agentId: "bc-001",
        artifactsDir: "/runs/a",
        id: cloudWithRun,
        runId: "run-001",
        runtime: "cloud",
        workflowRunId: wfId,
      });
      // Cloud, no run_id → skipped
      store.recordCursorRun({
        agentId: "bc-002",
        artifactsDir: "/runs/b",
        id: newCursorRunId(),
        runtime: "cloud",
        workflowRunId: wfId,
      });
      // Local → skipped
      store.recordCursorRun({
        agentId: "agent-local-002",
        artifactsDir: "/runs/c",
        id: newCursorRunId(),
        runId: "run-local-002",
        runtime: "local",
        workflowRunId: wfId,
      });

      const resumable = store.listResumableCloudCursorRuns();
      expect(resumable.map((r) => r.id)).toEqual([cloudWithRun]);
    });

    test("terminal cloud row (succeeded/failed/cancelled) is skipped", () => {
      const wfId = seedRun();
      const cursorRunId = newCursorRunId();
      store.recordCursorRun({
        agentId: "bc-test-terminal",
        artifactsDir: "/runs/wf_term",
        id: cursorRunId,
        runId: "run-test-terminal",
        runtime: "cloud",
        workflowRunId: wfId,
      });
      store.updateCursorRunStatus(cursorRunId, {
        durationMs: 1000,
        endedAt: currentNow,
        status: "succeeded",
      });

      expect(store.listResumableCloudCursorRuns()).toEqual([]);
    });
  });

  test("listLatestCursorRunsByWorkflowRunIds: returns latest row per workflow in one query", () => {
    const runA = seedRun();
    const runB = seedRun();
    const olderA = newCursorRunId();
    const newerA = newCursorRunId();
    currentNow = "2026-05-08T00:00:00.000Z";
    store.recordCursorRun({
      agentId: "agent_a_old",
      artifactsDir: "/runs/a-old",
      id: olderA,
      runtime: "local",
      workflowRunId: runA,
    });
    currentNow = "2026-05-08T00:00:10.000Z";
    store.recordCursorRun({
      agentId: "agent_a_new",
      artifactsDir: "/runs/a-new",
      id: newerA,
      runtime: "cloud",
      workflowRunId: runA,
    });
    const onlyB = newCursorRunId();
    store.recordCursorRun({
      agentId: "agent_b",
      artifactsDir: "/runs/b",
      id: onlyB,
      runtime: "rooms",
      workflowRunId: runB,
    });

    const latest = store.listLatestCursorRunsByWorkflowRunIds([runA, runB, "wf_missing"]);
    expect(latest.size).toBe(2);
    expect(latest.get(runA)?.id).toBe(newerA);
    expect(latest.get(runA)?.runtime).toBe("cloud");
    expect(latest.get(runB)?.id).toBe(onlyB);
    expect(latest.has("wf_missing")).toBe(false);
  });

  test("listLatestCursorRunsByWorkflowRunIds: empty input returns empty map", () => {
    expect(store.listLatestCursorRunsByWorkflowRunIds([])).toEqual(new Map());
  });

  test("listLatestCursorRunsByWorkflowRunIds: rejects more than 200 ids", () => {
    const ids = Array.from({ length: 201 }, (_, index) => `wf_${String(index)}`);
    expect(() => store.listLatestCursorRunsByWorkflowRunIds(ids)).toThrow(RangeError);
  });
});

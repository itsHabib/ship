/**
 * Tests for `cursor-runs.ts` exercised via the public `createStore` API.
 *
 * Coverage shape (per phases/03-store.md § "Validation plan"):
 * - recordCursorRun + updateCursorRunStatus + getCursorRun round-trip
 *   matches `cursorRunRefSchema`.
 * - getCursorRun of a non-existent id returns `null` (does not throw).
 * - recordCursorRun for a bad workflowRunId raises (we translate the
 *   FK violation to `WorkflowRunNotFoundError`).
 * - The optional `model` field round-trips through the JSON column.
 */

import type { ModelSelection, WorkflowPolicy, WorktreeRef } from "@ship/workflow";

import { newCursorRunId, newWorkflowRunId } from "@ship/workflow";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { Store } from "./store.js";

import { WorkflowRunNotFoundError } from "./errors.js";
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

  test("updateCursorRunStatus: unknown id throws", () => {
    expect(() => store.updateCursorRunStatus(newCursorRunId(), { status: "succeeded" })).toThrow();
  });
});

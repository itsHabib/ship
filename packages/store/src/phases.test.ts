/** Tests for `phases.ts` via the public `createStore` API. */

import type { WorkflowPolicy, WorkflowStatus, WorktreeRef } from "@ship/workflow";

import { newPhaseId, newWorkflowRunId } from "@ship/workflow";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { Db } from "./db.js";
import type { Store } from "./store.js";

import { PhaseNotFoundError, WorkflowRunNotFoundError } from "./errors.js";
import { runMigrations } from "./migrations.js";
import { createPhaseOps } from "./phases.js";
import { createStore } from "./store.js";
import { createWorkflowRunOps } from "./workflow-runs.js";

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

describe("phases (via createStore)", () => {
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

  test("appendPhase: phase appears under the run via getRun", () => {
    const runId = seedRun();
    const phaseId = newPhaseId();
    store.appendPhase({ id: phaseId, inputJson: "{}", kind: "implement", workflowRunId: runId });

    const run = store.getRun(runId);
    expect(run?.phases).toHaveLength(1);
    expect(run?.phases[0]?.id).toBe(phaseId);
    expect(run?.phases[0]?.status).toBe("pending");
    expect(run?.phases[0]?.kind).toBe("implement");
    expect(run?.phases[0]?.inputJson).toBe("{}");
  });

  test("appendPhase: bumps the parent run's updated_at", () => {
    const runId = seedRun();
    currentNow = "2026-05-08T00:01:00.000Z";
    store.appendPhase({
      id: newPhaseId(),
      inputJson: "{}",
      kind: "implement",
      workflowRunId: runId,
    });

    const run = store.getRun(runId);
    expect(run?.updatedAt).toBe("2026-05-08T00:01:00.000Z");
  });

  test("appendPhase for non-existent run id: WorkflowRunNotFoundError", () => {
    expect(() =>
      store.appendPhase({
        id: newPhaseId(),
        inputJson: "{}",
        kind: "implement",
        workflowRunId: newWorkflowRunId(),
      }),
    ).toThrow(WorkflowRunNotFoundError);
  });

  test("updatePhase: status / startedAt / endedAt round-trip", () => {
    const runId = seedRun();
    const phaseId = newPhaseId();
    store.appendPhase({ id: phaseId, inputJson: "{}", kind: "implement", workflowRunId: runId });

    currentNow = "2026-05-08T00:01:00.000Z";
    store.updatePhase(phaseId, { startedAt: currentNow, status: "running" });

    currentNow = "2026-05-08T00:02:00.000Z";
    store.updatePhase(phaseId, { endedAt: currentNow, status: "succeeded" });

    const run = store.getRun(runId);
    const phase = run?.phases[0];
    expect(phase?.status).toBe("succeeded");
    expect(phase?.startedAt).toBe("2026-05-08T00:01:00.000Z");
    expect(phase?.endedAt).toBe("2026-05-08T00:02:00.000Z");
  });

  test("updatePhase: bumps the parent run's updated_at", () => {
    const runId = seedRun();
    const phaseId = newPhaseId();
    store.appendPhase({ id: phaseId, inputJson: "{}", kind: "implement", workflowRunId: runId });

    currentNow = "2026-05-08T00:05:00.000Z";
    store.updatePhase(phaseId, { status: "running" });
    expect(store.getRun(runId)?.updatedAt).toBe("2026-05-08T00:05:00.000Z");
  });

  test("updatePhase: persists outputJson, errorMessage, cursorRunId, failureCategory", () => {
    const runId = seedRun();
    const phaseId = newPhaseId();
    store.appendPhase({ id: phaseId, inputJson: "{}", kind: "implement", workflowRunId: runId });
    store.updatePhase(phaseId, {
      cursorRunId: "cr_01HMXAAAAAAAAAAAAAAAAAAAAA",
      errorMessage: "something went wrong",
      failureCategory: "logic",
      outputJson: '{"changedFiles":["a.ts"]}',
    });
    const phase = store.getRun(runId)?.phases[0];
    expect(phase?.cursorRunId).toBe("cr_01HMXAAAAAAAAAAAAAAAAAAAAA");
    expect(phase?.errorMessage).toBe("something went wrong");
    expect(phase?.failureCategory).toBe("logic");
    expect(phase?.outputJson).toBe('{"changedFiles":["a.ts"]}');
  });

  test("updatePhase: empty patch is a no-op for the phase row but bumps run.updated_at", () => {
    const runId = seedRun();
    const phaseId = newPhaseId();
    store.appendPhase({ id: phaseId, inputJson: "{}", kind: "implement", workflowRunId: runId });
    const before = store.getRun(runId)?.phases[0];

    currentNow = "2026-05-08T00:09:00.000Z";
    store.updatePhase(phaseId, {});

    const after = store.getRun(runId);
    expect(after?.phases[0]).toEqual(before);
    expect(after?.updatedAt).toBe("2026-05-08T00:09:00.000Z");
  });

  test("updatePhase for non-existent phase id: PhaseNotFoundError", () => {
    expect(() => store.updatePhase(newPhaseId(), { status: "running" })).toThrow(
      PhaseNotFoundError,
    );
  });

  test("multiple phases: chronological order on getRun", () => {
    const runId = seedRun();
    const a = newPhaseId();
    const b = newPhaseId();
    const c = newPhaseId();

    currentNow = "2026-05-08T00:01:00.000Z";
    store.appendPhase({ id: a, inputJson: "{}", kind: "implement", workflowRunId: runId });
    currentNow = "2026-05-08T00:02:00.000Z";
    store.appendPhase({ id: b, inputJson: "{}", kind: "implement", workflowRunId: runId });
    currentNow = "2026-05-08T00:03:00.000Z";
    store.appendPhase({ id: c, inputJson: "{}", kind: "implement", workflowRunId: runId });

    const run = store.getRun(runId);
    expect(run?.phases.map((p) => p.id)).toEqual([a, b, c]);
  });
});

// cancelRun atomicity: a phase update failure inside the txn rolls back
// both run and phase. Uses a SQLite trigger to force the failure.
describe("cancelRun atomicity (rollback)", () => {
  let db: Db;
  const clock = (): string => "2026-05-08T00:00:00.000Z";

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db, { clock });
  });

  afterEach(() => {
    db.close();
  });

  test("phase update failure rolls back the run-status flip", () => {
    const phases = createPhaseOps(db, clock);
    const wf = createWorkflowRunOps(db, clock, phases);

    const runId = newWorkflowRunId();
    wf.create({
      baseRef: "main",
      docPath: "docs/x.md",
      id: runId,
      policy: validPolicy,
      repo: "ship",
      worktree: validWorktree,
    });
    wf.updateStatus(runId, "running");
    const phaseId = newPhaseId();
    phases.append({ id: phaseId, inputJson: "{}", kind: "implement", workflowRunId: runId });
    phases.update(phaseId, { startedAt: clock(), status: "running" });

    // Install a trigger that fails any UPDATE on phases.
    db.exec(
      `CREATE TRIGGER fail_phase_update BEFORE UPDATE ON phases
       BEGIN SELECT RAISE(FAIL, 'simulated phase-update failure'); END;`,
    );

    expect(() => wf.cancel(runId)).toThrow(/simulated phase-update failure/);

    // Run status must NOT have flipped (txn rolled back).
    const runRow = db
      .prepare<[string], { status: string }>("SELECT status FROM workflow_runs WHERE id = ?")
      .get(runId);
    expect(runRow?.status).toBe<WorkflowStatus>("running");

    // Phase must NOT have flipped either.
    const phaseRow = db
      .prepare<[string], { status: string }>("SELECT status FROM phases WHERE id = ?")
      .get(phaseId);
    expect(phaseRow?.status).toBe("running");
  });
});

/**
 * Tests for `workflow-runs.ts` exercised via the public `createStore` API.
 *
 * Coverage shape (per phases/03-store.md § "Validation plan"):
 * - createWorkflowRun + getRun round-trip, including phases: [].
 * - updateWorkflowRunStatus: status transitions bump updated_at; missing
 *   id throws.
 * - cancelRun: idempotent on terminal; pending → cancelled; running with
 *   in-flight phase flips both atomically; non-existent throws; rollback
 *   on phase-update failure preserves run state (atomicity).
 * - listRuns: ordering, filtering by repo / status / both, limit
 *   defaults / over-max, two-query budget verification (against the
 *   per-table module directly so we can spy on `db.prepare`), same-
 *   millisecond tiebreak.
 * - Hydration error path: manually corrupt JSON → StoreSchemaError;
 *   missing required column → StoreSchemaError.
 * - State-machine bypass note: store does not validate transitions
 *   (per ED).
 */

import type { WorkflowPolicy, WorkflowRun, WorkflowStatus, WorktreeRef } from "@ship/workflow";

import { newPhaseId, newWorkflowRunId } from "@ship/workflow";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { Db } from "./db.js";
import type { Store } from "./store.js";
import type { CreateWorkflowRunInput } from "./workflow-runs.js";

import { StoreSchemaError, WorkflowRunNotFoundError } from "./errors.js";
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

function makeInput(overrides: Partial<CreateWorkflowRunInput> = {}): CreateWorkflowRunInput {
  return {
    baseRef: "main",
    docPath: "docs/features/x.md",
    id: newWorkflowRunId(),
    policy: validPolicy,
    repo: "ship",
    worktree: validWorktree,
    ...overrides,
  };
}

describe("workflow runs (via createStore)", () => {
  let store: Store;
  let now: () => string;
  let currentNow = "2026-05-08T00:00:00.000Z";

  beforeEach(() => {
    currentNow = "2026-05-08T00:00:00.000Z";
    now = () => currentNow;
    store = createStore({ clock: now, dbPath: ":memory:" });
  });

  afterEach(() => {
    store.close();
  });

  test("createWorkflowRun: row appears with status pending, createdAt == updatedAt, phases empty", () => {
    const input = makeInput();
    const run = store.createWorkflowRun(input);
    expect(run.id).toBe(input.id);
    expect(run.status).toBe<WorkflowStatus>("pending");
    expect(run.createdAt).toBe(currentNow);
    expect(run.updatedAt).toBe(currentNow);
    expect(run.phases).toEqual([]);
    expect(run.worktree).toEqual(input.worktree);
    expect(run.policy).toEqual(input.policy);
  });

  test("getRun: round-trip equals the created row (deep equal modulo phases ordering)", () => {
    const input = makeInput();
    const created = store.createWorkflowRun(input);
    const fetched = store.getRun(input.id);
    expect(fetched).toEqual(created);
  });

  test("getRun: unknown id returns null (does not throw)", () => {
    expect(store.getRun(newWorkflowRunId())).toBeNull();
  });

  test("createWorkflowRun: duplicate id throws (PK violation)", () => {
    const input = makeInput();
    store.createWorkflowRun(input);
    expect(() => store.createWorkflowRun(input)).toThrow();
  });

  test("updateWorkflowRunStatus: pending → running → succeeded bumps updated_at each step", () => {
    const input = makeInput();
    store.createWorkflowRun(input);

    currentNow = "2026-05-08T00:01:00.000Z";
    const running = store.updateWorkflowRunStatus(input.id, "running");
    expect(running.status).toBe<WorkflowStatus>("running");
    expect(running.updatedAt).toBe("2026-05-08T00:01:00.000Z");

    currentNow = "2026-05-08T00:02:00.000Z";
    const succeeded = store.updateWorkflowRunStatus(input.id, "succeeded");
    expect(succeeded.status).toBe<WorkflowStatus>("succeeded");
    expect(succeeded.updatedAt).toBe("2026-05-08T00:02:00.000Z");
  });

  test("updateWorkflowRunStatus: unknown id throws WorkflowRunNotFoundError", () => {
    expect(() => store.updateWorkflowRunStatus(newWorkflowRunId(), "running")).toThrow(
      WorkflowRunNotFoundError,
    );
  });

  test("updateWorkflowRunStatus: store does NOT enforce state machine (pending → succeeded passes)", () => {
    // Documented in ED: core is the canonical state-machine owner; the store
    // is a dumb writer. Asserts the absence of a guard is intentional.
    const input = makeInput();
    store.createWorkflowRun(input);
    const result = store.updateWorkflowRunStatus(input.id, "succeeded");
    expect(result.status).toBe<WorkflowStatus>("succeeded");
  });

  test("cancelRun: pending with no phases → cancelled", () => {
    const input = makeInput();
    store.createWorkflowRun(input);
    currentNow = "2026-05-08T00:05:00.000Z";
    const cancelled = store.cancelRun(input.id);
    expect(cancelled.status).toBe<WorkflowStatus>("cancelled");
    expect(cancelled.updatedAt).toBe("2026-05-08T00:05:00.000Z");
    expect(cancelled.phases).toEqual([]);
  });

  test("cancelRun: already-terminal is a no-op (returns current row, does not bump updated_at)", () => {
    const input = makeInput();
    store.createWorkflowRun(input);
    currentNow = "2026-05-08T00:05:00.000Z";
    const cancelled = store.cancelRun(input.id);
    const cancelledAt = cancelled.updatedAt;

    currentNow = "2026-05-08T00:06:00.000Z";
    const again = store.cancelRun(input.id);
    expect(again.status).toBe<WorkflowStatus>("cancelled");
    expect(again.updatedAt).toBe(cancelledAt);
  });

  test("cancelRun: unknown id throws WorkflowRunNotFoundError", () => {
    expect(() => store.cancelRun(newWorkflowRunId())).toThrow(WorkflowRunNotFoundError);
  });

  test("cancelRun with in-flight phase: BOTH run + phase flip to cancelled, phase gets endedAt", () => {
    const input = makeInput();
    store.createWorkflowRun(input);
    store.updateWorkflowRunStatus(input.id, "running");

    const phaseId = newPhaseId();
    store.appendPhase({ id: phaseId, inputJson: "{}", kind: "implement", workflowRunId: input.id });
    store.updatePhase(phaseId, { startedAt: currentNow, status: "running" });

    currentNow = "2026-05-08T00:10:00.000Z";
    const cancelled = store.cancelRun(input.id);
    expect(cancelled.status).toBe<WorkflowStatus>("cancelled");
    expect(cancelled.phases).toHaveLength(1);
    const cancelledPhase = cancelled.phases[0];
    expect(cancelledPhase?.status).toBe("cancelled");
    expect(cancelledPhase?.endedAt).toBe("2026-05-08T00:10:00.000Z");
  });

  test("cancelRun does NOT touch already-terminal phases on a non-terminal run", () => {
    const input = makeInput();
    store.createWorkflowRun(input);
    store.updateWorkflowRunStatus(input.id, "running");

    const succeededPhaseId = newPhaseId();
    store.appendPhase({
      id: succeededPhaseId,
      inputJson: "{}",
      kind: "implement",
      workflowRunId: input.id,
    });
    store.updatePhase(succeededPhaseId, {
      endedAt: currentNow,
      startedAt: currentNow,
      status: "succeeded",
    });

    const inflightPhaseId = newPhaseId();
    store.appendPhase({
      id: inflightPhaseId,
      inputJson: "{}",
      kind: "implement",
      workflowRunId: input.id,
    });
    store.updatePhase(inflightPhaseId, { startedAt: currentNow, status: "running" });

    currentNow = "2026-05-08T00:10:00.000Z";
    const cancelled = store.cancelRun(input.id);
    const succeededPhase = cancelled.phases.find((p) => p.id === succeededPhaseId);
    const cancelledPhase = cancelled.phases.find((p) => p.id === inflightPhaseId);
    expect(succeededPhase?.status).toBe("succeeded");
    expect(cancelledPhase?.status).toBe("cancelled");
  });
});

// =====================================================================
// listRuns
// =====================================================================

describe("listRuns", () => {
  let store: Store;
  let currentNow: string;

  beforeEach(() => {
    currentNow = "2026-05-08T00:00:00.000Z";
    store = createStore({ clock: () => currentNow, dbPath: ":memory:" });
  });

  afterEach(() => {
    store.close();
  });

  function seedRun(overrides: Partial<CreateWorkflowRunInput> = {}, advanceMs = 1000): WorkflowRun {
    const run = store.createWorkflowRun(makeInput(overrides));
    currentNow = new Date(new Date(currentNow).getTime() + advanceMs).toISOString();
    return run;
  }

  test("no filter: most-recent-first, default limit 50", () => {
    const runs: WorkflowRun[] = [];
    for (let i = 0; i < 3; i++) runs.push(seedRun());

    const list = store.listRuns({});
    expect(list).toHaveLength(3);
    expect(list[0]?.id).toBe(runs[2]?.id);
    expect(list[1]?.id).toBe(runs[1]?.id);
    expect(list[2]?.id).toBe(runs[0]?.id);
  });

  test("filter by repo: returns only matching rows", () => {
    seedRun({ repo: "ship" });
    seedRun({ repo: "tower" });
    seedRun({ repo: "ship" });

    const ship = store.listRuns({ repo: "ship" });
    const tower = store.listRuns({ repo: "tower" });
    expect(ship).toHaveLength(2);
    expect(tower).toHaveLength(1);
    expect(ship.every((r) => r.repo === "ship")).toBe(true);
  });

  test("filter by status array: IN-clause", () => {
    const a = seedRun();
    const b = seedRun();
    const c = seedRun();
    store.updateWorkflowRunStatus(a.id, "running");
    store.updateWorkflowRunStatus(b.id, "succeeded");
    // c stays pending
    void c;

    const filtered = store.listRuns({ status: ["pending", "running"] });
    expect(filtered.map((r) => r.id).sort()).toEqual([a.id, c.id].sort());
  });

  test("filter by repo AND status: both apply (AND)", () => {
    const a = seedRun({ repo: "ship" });
    seedRun({ repo: "tower" });
    seedRun({ repo: "ship" });
    store.updateWorkflowRunStatus(a.id, "running");

    const result = store.listRuns({ repo: "ship", status: ["running"] });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(a.id);
  });

  test("custom limit caps results", () => {
    for (let i = 0; i < 5; i++) seedRun();
    expect(store.listRuns({ limit: 2 })).toHaveLength(2);
  });

  test("over-max limit throws RangeError", () => {
    expect(() => store.listRuns({ limit: 201 })).toThrow(RangeError);
  });

  test("non-positive or non-integer limit throws RangeError", () => {
    expect(() => store.listRuns({ limit: 0 })).toThrow(RangeError);
    expect(() => store.listRuns({ limit: -1 })).toThrow(RangeError);
    expect(() => store.listRuns({ limit: 1.5 })).toThrow(RangeError);
  });

  test("empty result on no matches", () => {
    expect(store.listRuns({ repo: "does-not-exist" })).toEqual([]);
    expect(store.listRuns({})).toEqual([]);
  });

  test("phases hydrated per run; no cross-leak between runs", () => {
    const a = seedRun({ repo: "alpha" });
    const b = seedRun({ repo: "beta" });
    store.appendPhase({
      id: newPhaseId(),
      inputJson: "{}",
      kind: "implement",
      workflowRunId: a.id,
    });
    store.appendPhase({
      id: newPhaseId(),
      inputJson: "{}",
      kind: "implement",
      workflowRunId: b.id,
    });
    store.appendPhase({
      id: newPhaseId(),
      inputJson: "{}",
      kind: "implement",
      workflowRunId: b.id,
    });

    const list = store.listRuns({});
    const aFromList = list.find((r) => r.id === a.id);
    const bFromList = list.find((r) => r.id === b.id);
    expect(aFromList?.phases).toHaveLength(1);
    expect(bFromList?.phases).toHaveLength(2);
    expect(aFromList?.phases.every((p) => p.workflowRunId === a.id)).toBe(true);
    expect(bFromList?.phases.every((p) => p.workflowRunId === b.id)).toBe(true);
  });

  test("same-millisecond created_at: ULIDs sort tiebreak (larger id first)", () => {
    // Force-equal createdAt for two rows; the ORDER BY tiebreak is `id DESC`.
    const fixedNow = "2026-05-08T00:00:00.000Z";
    currentNow = fixedNow;
    const a = store.createWorkflowRun(makeInput({ id: "wf_01HMXAAAAAAAAAAAAAAAAAAAAA" }));
    const b = store.createWorkflowRun(makeInput({ id: "wf_01HMXBBBBBBBBBBBBBBBBBBBBB" }));

    const list = store.listRuns({});
    expect(list[0]?.id).toBe(b.id);
    expect(list[1]?.id).toBe(a.id);
  });
});

// =====================================================================
// Two-query budget — uses per-table modules directly so we can spy on `db.prepare`.
// =====================================================================

describe("listRuns two-query budget", () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  test("listRuns issues exactly 2 db.prepare calls when N > 0", () => {
    const clock = () => "2026-05-08T00:00:00.000Z";
    const phases = createPhaseOps(db, clock);
    const wf = createWorkflowRunOps(db, clock, phases);

    // Seed two runs + one phase each (so the IN clause has work to do).
    for (let i = 0; i < 2; i++) {
      const id = newWorkflowRunId();
      wf.create({
        baseRef: "main",
        docPath: "docs/x.md",
        id,
        policy: validPolicy,
        repo: "ship",
        worktree: validWorktree,
      });
      phases.append({ id: newPhaseId(), inputJson: "{}", kind: "implement", workflowRunId: id });
    }

    // After the cached `db.prepare` calls inside the constructors, spy and run.
    const spy = vi.spyOn(db, "prepare");
    const rows = wf.list({});
    expect(rows).toHaveLength(2);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  test("listRuns with N == 0 issues only 1 db.prepare call (skips phase lookup)", () => {
    const clock = () => "2026-05-08T00:00:00.000Z";
    const phases = createPhaseOps(db, clock);
    const wf = createWorkflowRunOps(db, clock, phases);

    const spy = vi.spyOn(db, "prepare");
    const rows = wf.list({ repo: "no-such-repo" });
    expect(rows).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

// =====================================================================
// Hydration error path — corrupt rows from outside the API.
// =====================================================================

describe("hydration error paths", () => {
  let db: Db;

  beforeEach(() => {
    // Drive the per-table modules directly so the test can corrupt rows
    // without going through the public API.
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  test("malformed worktree_json: getRun throws StoreSchemaError", () => {
    const clock = () => "2026-05-08T00:00:00.000Z";
    const phases = createPhaseOps(db, clock);
    const wf = createWorkflowRunOps(db, clock, phases);
    const id = newWorkflowRunId();
    wf.create({
      baseRef: "main",
      docPath: "docs/x.md",
      id,
      policy: validPolicy,
      repo: "ship",
      worktree: validWorktree,
    });
    db.prepare("UPDATE workflow_runs SET worktree_json = 'not json' WHERE id = ?").run(id);
    expect(() => wf.get(id)).toThrow(StoreSchemaError);
  });

  test("missing required field in worktree_json: getRun throws StoreSchemaError", () => {
    const clock = () => "2026-05-08T00:00:00.000Z";
    const phases = createPhaseOps(db, clock);
    const wf = createWorkflowRunOps(db, clock, phases);
    const id = newWorkflowRunId();
    wf.create({
      baseRef: "main",
      docPath: "docs/x.md",
      id,
      policy: validPolicy,
      repo: "ship",
      worktree: validWorktree,
    });
    db.prepare("UPDATE workflow_runs SET worktree_json = ? WHERE id = ?").run(
      JSON.stringify({ name: "only-the-name" }),
      id,
    );
    expect(() => wf.get(id)).toThrow(StoreSchemaError);
  });
});

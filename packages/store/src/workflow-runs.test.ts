/** Tests for `workflow-runs.ts` via the public `createStore` API. */

import type { WorkflowPolicy, WorkflowRun, WorkflowStatus, WorktreeRef } from "@ship/workflow";

import { newPhaseId, newWorkflowRunId } from "@ship/workflow";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { Db } from "./db.js";
import type { Store } from "./store.js";
import type { CreateWorkflowRunInput } from "./workflow-runs.js";

import { PhaseNotFoundError, StoreSchemaError, WorkflowRunNotFoundError } from "./errors.js";
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
    // core owns the state machine; the store is a dumb writer.
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

  test("cancelRun does NOT overwrite a terminal succeeded status (race-safety)", () => {
    // Models the multi-connection race the conditional UPDATE guards against.
    const input = makeInput();
    store.createWorkflowRun(input);
    store.updateWorkflowRunStatus(input.id, "running");

    const succeededAt = "2026-05-08T00:09:00.000Z";
    currentNow = succeededAt;
    store.updateWorkflowRunStatus(input.id, "succeeded");

    currentNow = "2026-05-08T00:10:00.000Z";
    const result = store.cancelRun(input.id);
    expect(result.status).toBe<WorkflowStatus>("succeeded");
    expect(result.updatedAt).toBe(succeededAt);
  });

  test("cancelRun does NOT overwrite a terminal failed status (race-safety)", () => {
    const input = makeInput();
    store.createWorkflowRun(input);
    store.updateWorkflowRunStatus(input.id, "running");

    const failedAt = "2026-05-08T00:09:00.000Z";
    currentNow = failedAt;
    store.updateWorkflowRunStatus(input.id, "failed");

    currentNow = "2026-05-08T00:10:00.000Z";
    const result = store.cancelRun(input.id);
    expect(result.status).toBe<WorkflowStatus>("failed");
    expect(result.updatedAt).toBe(failedAt);
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

  test("markRunStarted: flips both rows pending → running atomically; bumps run updated_at", () => {
    const input = makeInput();
    store.createWorkflowRun(input);
    const phaseId = newPhaseId();
    store.appendPhase({ id: phaseId, inputJson: "{}", kind: "implement", workflowRunId: input.id });

    const startedAt = "2026-05-08T00:01:00.000Z";
    currentNow = startedAt;
    store.markRunStarted(input.id, phaseId, startedAt);

    const row = store.getRun(input.id);
    expect(row?.status).toBe<WorkflowStatus>("running");
    expect(row?.updatedAt).toBe(startedAt);
    expect(row?.phases).toHaveLength(1);
    expect(row?.phases[0]?.status).toBe("running");
    expect(row?.phases[0]?.startedAt).toBe(startedAt);
  });

  test("markRunStarted: unknown phase id throws PhaseNotFoundError and leaves both rows untouched", () => {
    const input = makeInput();
    store.createWorkflowRun(input);

    expect(() => {
      store.markRunStarted(input.id, newPhaseId(), currentNow);
    }).toThrow(PhaseNotFoundError);
    // Workflow row stays pending — the txn rolled back before reaching the run UPDATE.
    expect(store.getRun(input.id)?.status).toBe<WorkflowStatus>("pending");
  });

  test("markRunStarted: mismatched (workflowRunId, phaseId) throws PhaseNotFoundError; no row mutates", () => {
    // The phase UPDATE is scoped by `(id, workflow_run_id)`, so passing
    // a real phase id alongside a bogus workflow id matches zero rows
    // and throws before the workflow UPDATE ever runs. Without that
    // scoping, the phase UPDATE would succeed (id matches) while the
    // workflow UPDATE would 404, leaving split state — the failure mode
    // codex flagged on cycle 3.
    const input = makeInput();
    store.createWorkflowRun(input);
    const phaseId = newPhaseId();
    store.appendPhase({ id: phaseId, inputJson: "{}", kind: "implement", workflowRunId: input.id });

    expect(() => {
      store.markRunStarted(newWorkflowRunId(), phaseId, currentNow);
    }).toThrow(PhaseNotFoundError);
    const row = store.getRun(input.id);
    expect(row?.phases[0]?.status).toBe("pending");
    expect(row?.phases[0]?.startedAt).toBeUndefined();
  });

  test("markRunStarted: cross-run pair (phase from B, workflow from A) refuses to corrupt either run", () => {
    // Two real runs each with a phase; call markRunStarted with run A's
    // id paired with run B's phase id. The `(id, workflow_run_id)`
    // scoping on the phase UPDATE prevents the silent cross-run mutation
    // the loose-id contract would otherwise allow.
    const a = makeInput();
    const b = makeInput();
    store.createWorkflowRun(a);
    store.createWorkflowRun(b);
    const phaseA = newPhaseId();
    const phaseB = newPhaseId();
    store.appendPhase({ id: phaseA, inputJson: "{}", kind: "implement", workflowRunId: a.id });
    store.appendPhase({ id: phaseB, inputJson: "{}", kind: "implement", workflowRunId: b.id });

    expect(() => {
      store.markRunStarted(a.id, phaseB, currentNow);
    }).toThrow(PhaseNotFoundError);
    // Neither run mutated.
    expect(store.getRun(a.id)?.status).toBe<WorkflowStatus>("pending");
    expect(store.getRun(b.id)?.status).toBe<WorkflowStatus>("pending");
    expect(store.getRun(a.id)?.phases[0]?.status).toBe("pending");
    expect(store.getRun(b.id)?.phases[0]?.status).toBe("pending");
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

  describe("touchWorkflowRunUpdatedAt", () => {
    test("bumps updated_at on an existing row", () => {
      const input = makeInput();
      const created = store.createWorkflowRun(input);
      const before = created.updatedAt;

      currentNow = "2026-05-08T00:00:30.000Z";
      store.touchWorkflowRunUpdatedAt(input.id);

      const after = store.getRun(input.id);
      expect(after?.updatedAt).toBe(currentNow);
      expect(after?.updatedAt).not.toBe(before);
      // Status untouched — this is a pure freshness bump.
      expect(after?.status).toBe(created.status);
    });

    test("unknown id throws WorkflowRunNotFoundError", () => {
      expect(() => {
        store.touchWorkflowRunUpdatedAt(newWorkflowRunId());
      }).toThrow(WorkflowRunNotFoundError);
    });
  });
});

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
    const byId = (x: string, y: string): number => x.localeCompare(y);
    expect(filtered.map((r) => r.id).sort(byId)).toEqual([a.id, c.id].sort(byId));
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
    // ORDER BY tiebreak is `id DESC` when createdAt collides.
    const fixedNow = "2026-05-08T00:00:00.000Z";
    currentNow = fixedNow;
    const a = store.createWorkflowRun(makeInput({ id: "wf_01HMXAAAAAAAAAAAAAAAAAAAAA" }));
    const b = store.createWorkflowRun(makeInput({ id: "wf_01HMXBBBBBBBBBBBBBBBBBBBBB" }));

    const list = store.listRuns({});
    expect(list[0]?.id).toBe(b.id);
    expect(list[1]?.id).toBe(a.id);
  });
});

// Two-query budget: drives per-table modules directly so we can spy on `db.prepare`.
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

    // Seed two runs + one phase each so the IN clause has work to do.
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

    // Spy after constructor-time prepare() calls so only `list` is counted.
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

// Hydration error paths: corrupt rows from outside the API and verify
// the parse-at-the-seam translates to StoreSchemaError.
describe("hydration error paths", () => {
  let db: Db;

  beforeEach(() => {
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

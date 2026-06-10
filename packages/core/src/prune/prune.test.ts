/** L1/L2 tests for terminal-run prune selection and execution. */

import type { WorkflowRunPruneRow } from "@ship/store";

import { createStore } from "@ship/store";
import { newWorkflowRunId } from "@ship/workflow";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  computePruneCutoffMs,
  executePruneRuns,
  formatPruneAge,
  parsePruneDuration,
  type PruneFs,
  selectPruneTargets,
} from "./prune.js";

describe("parsePruneDuration", () => {
  test("accepts day/hour/week/minute units", () => {
    expect(parsePruneDuration("30d")).toBe(30 * 24 * 60 * 60 * 1000);
    expect(parsePruneDuration("12h")).toBe(12 * 60 * 60 * 1000);
    expect(parsePruneDuration("2w")).toBe(2 * 7 * 24 * 60 * 60 * 1000);
    expect(parsePruneDuration("45m")).toBe(45 * 60 * 1000);
  });

  test("rejects invalid values", () => {
    expect(() => parsePruneDuration("30")).toThrow(/invalid --before duration/);
    expect(() => parsePruneDuration("0d")).toThrow(/invalid --before duration/);
    expect(() => parsePruneDuration("abc")).toThrow(/invalid --before duration/);
  });
});

describe("selectPruneTargets", () => {
  const nowMs = Date.parse("2026-06-10T12:00:00.000Z");
  const cutoffMs = computePruneCutoffMs("30d", nowMs);

  test("selects terminal rows older than cutoff and skips in-flight rows", () => {
    const rows: WorkflowRunPruneRow[] = [
      { id: "wf_old_ok", status: "succeeded", updatedAt: "2026-04-01T00:00:00.000Z" },
      { id: "wf_new_ok", status: "failed", updatedAt: "2026-06-01T00:00:00.000Z" },
      { id: "wf_running", status: "running", updatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "wf_pending", status: "pending", updatedAt: "2026-01-01T00:00:00.000Z" },
    ];
    const targets = selectPruneTargets(rows, ["wf_old_ok", "wf_running"], cutoffMs, nowMs);
    expect(targets.map((t) => t.runId)).toEqual(["wf_old_ok"]);
    expect(targets[0]?.deleteStoreRow).toBe(true);
    expect(targets[0]?.deleteRunDir).toBe(true);
  });

  test("never selects a row with a malformed updatedAt timestamp", () => {
    const rows: WorkflowRunPruneRow[] = [
      { id: "wf_bad_ts", status: "succeeded", updatedAt: "not-a-timestamp" },
      { id: "wf_old_ok", status: "succeeded", updatedAt: "2026-04-01T00:00:00.000Z" },
    ];
    const targets = selectPruneTargets(rows, [], cutoffMs, nowMs);
    expect(targets.map((t) => t.runId)).toEqual(["wf_old_ok"]);
  });

  test("includes orphan run dirs with no store row", () => {
    const rows: WorkflowRunPruneRow[] = [];
    const targets = selectPruneTargets(rows, ["wf_orphan"], cutoffMs, nowMs);
    expect(targets).toEqual([
      {
        ageMs: 0,
        deleteRunDir: true,
        deleteStoreRow: false,
        runId: "wf_orphan",
        status: "orphan",
      },
    ]);
  });

  test("prunes store row when run dir is already gone", () => {
    const rows: WorkflowRunPruneRow[] = [
      { id: "wf_row_only", status: "cancelled", updatedAt: "2026-01-01T00:00:00.000Z" },
    ];
    const targets = selectPruneTargets(rows, [], cutoffMs, nowMs);
    expect(targets[0]?.deleteStoreRow).toBe(true);
    expect(targets[0]?.deleteRunDir).toBe(false);
  });
});

describe("executePruneRuns", () => {
  let store: ReturnType<typeof createStore>;
  let runsDir: string;
  let pruneFs: PruneFs;
  const nowMs = Date.parse("2026-06-10T12:00:00.000Z");

  beforeEach(() => {
    store = createStore({ clock: () => "2026-06-10T12:00:00.000Z", dbPath: ":memory:" });
    runsDir = mkdtempSync(join(tmpdir(), "ship-prune-"));
    pruneFs = {
      listRunDirNames: async (dir) => {
        const { readdir } = await import("node:fs/promises");
        const entries = await readdir(dir, { withFileTypes: true });
        return entries.filter((e) => e.isDirectory()).map((e) => e.name);
      },
      removeRunDir: (path) => {
        rmSync(path, { force: true, recursive: true });
        return Promise.resolve();
      },
    };
  });

  afterEach(() => {
    store.close();
    rmSync(runsDir, { force: true, recursive: true });
  });

  test("--dry-run is side-effect free", async () => {
    store.close();
    store = createStore({ clock: () => "2026-01-01T00:00:00.000Z", dbPath: ":memory:" });
    const oldId = newWorkflowRunId();
    store.createWorkflowRun({
      baseRef: "main",
      docPath: "docs.md",
      id: oldId,
      policy: {
        agentTimeoutMs: 1,
        baseRef: "main",
        maxRunDurationMs: 1,
      },
      repo: "ship",
      worktree: {
        baseRef: "main",
        branch: "feat",
        name: "feat",
        path: "/wt/feat",
        repo: "ship",
      },
    });
    store.updateWorkflowRunStatus(oldId, "succeeded");
    await mkdir(join(runsDir, oldId), { recursive: true });
    await writeFile(join(runsDir, oldId, "events.ndjson"), "[]");

    const out = await executePruneRuns({
      before: "30d",
      dryRun: true,
      nowMs,
      pruneFs,
      runsDir,
      store,
    });

    expect(out.targets.some((t) => t.runId === oldId)).toBe(true);
    expect(store.getRun(oldId)).not.toBeNull();
    const dirsAfter = await pruneFs.listRunDirNames(runsDir);
    expect(dirsAfter).toContain(oldId);
  });

  test("orphan recheck: a run created during the listing gap is not deleted", async () => {
    const racingId = newWorkflowRunId();
    await mkdir(join(runsDir, racingId), { recursive: true });

    // Simulate the race: the store row appears AFTER the prune snapshot was
    // taken but BEFORE deletion — injected via the dir-listing hook, which
    // executePruneRuns awaits after reading store rows.
    const racingPruneFs: PruneFs = {
      listRunDirNames: async (dir) => {
        store.createWorkflowRun({
          baseRef: "main",
          docPath: "docs.md",
          id: racingId,
          policy: { agentTimeoutMs: 1, baseRef: "main", maxRunDurationMs: 1 },
          repo: "ship",
          worktree: {
            baseRef: "main",
            branch: "feat",
            name: "feat",
            path: "/wt/feat",
            repo: "ship",
          },
        });
        return pruneFs.listRunDirNames(dir);
      },
      removeRunDir: pruneFs.removeRunDir,
    };

    const out = await executePruneRuns({
      before: "30d",
      nowMs,
      pruneFs: racingPruneFs,
      runsDir,
      store,
    });

    expect(out.failures).toContain(racingId);
    expect(store.getRun(racingId)).not.toBeNull();
    const dirsAfter = await pruneFs.listRunDirNames(runsDir);
    expect(dirsAfter).toContain(racingId);
  });

  test("one failed deletion does not abort the rest of the batch", async () => {
    store.close();
    store = createStore({ clock: () => "2026-01-01T00:00:00.000Z", dbPath: ":memory:" });
    const ids = [newWorkflowRunId(), newWorkflowRunId()].sort((a, b) => a.localeCompare(b));
    for (const id of ids) {
      store.createWorkflowRun({
        baseRef: "main",
        docPath: "docs.md",
        id,
        policy: { agentTimeoutMs: 1, baseRef: "main", maxRunDurationMs: 1 },
        repo: "ship",
        worktree: { baseRef: "main", branch: "feat", name: "feat", path: "/wt/feat", repo: "ship" },
      });
      store.updateWorkflowRunStatus(id, "succeeded");
      await mkdir(join(runsDir, id), { recursive: true });
    }

    const failFirst = ids[0] ?? "";
    const flakyPruneFs: PruneFs = {
      listRunDirNames: pruneFs.listRunDirNames,
      removeRunDir: (path) => {
        if (path.endsWith(failFirst)) return Promise.reject(new Error("EBUSY"));
        return pruneFs.removeRunDir(path);
      },
    };

    const out = await executePruneRuns({
      before: "30d",
      nowMs,
      pruneFs: flakyPruneFs,
      runsDir,
      store,
    });

    expect(out.failures).toEqual([failFirst]);
    expect(out.deletedRunDirs).toBe(1);
    const dirsAfter = await pruneFs.listRunDirNames(runsDir);
    expect(dirsAfter).toContain(failFirst);
    expect(dirsAfter).not.toContain(ids[1]);
  });

  test("deletes store row before run dir and cleans orphans", async () => {
    store.close();
    store = createStore({ clock: () => "2026-01-01T00:00:00.000Z", dbPath: ":memory:" });
    const oldId = newWorkflowRunId();
    store.createWorkflowRun({
      baseRef: "main",
      docPath: "docs.md",
      id: oldId,
      policy: {
        agentTimeoutMs: 1,
        baseRef: "main",
        maxRunDurationMs: 1,
      },
      repo: "ship",
      worktree: {
        baseRef: "main",
        branch: "feat",
        name: "feat",
        path: "/wt/feat",
        repo: "ship",
      },
    });
    store.updateWorkflowRunStatus(oldId, "failed");

    const runningId = newWorkflowRunId();
    store.createWorkflowRun({
      baseRef: "main",
      docPath: "docs.md",
      id: runningId,
      policy: {
        agentTimeoutMs: 1,
        baseRef: "main",
        maxRunDurationMs: 1,
      },
      repo: "ship",
      worktree: {
        baseRef: "main",
        branch: "feat",
        name: "feat",
        path: "/wt/feat",
        repo: "ship",
      },
    });
    store.updateWorkflowRunStatus(runningId, "running");

    await mkdir(join(runsDir, oldId), { recursive: true });
    await mkdir(join(runsDir, runningId), { recursive: true });
    await mkdir(join(runsDir, "wf_orphan_only"), { recursive: true });

    const out = await executePruneRuns({
      before: "30d",
      nowMs,
      pruneFs,
      runsDir,
      store,
    });

    expect(out.deletedStoreRows).toBe(1);
    expect(out.deletedRunDirs).toBe(2);
    expect(store.getRun(oldId)).toBeNull();
    expect(store.getRun(runningId)).not.toBeNull();
    expect(await pruneFs.listRunDirNames(runsDir)).toEqual([runningId]);
  });
});

describe("formatPruneAge", () => {
  test("formats common buckets", () => {
    expect(formatPruneAge(3 * 24 * 60 * 60 * 1000)).toBe("3d");
    expect(formatPruneAge(5 * 60 * 60 * 1000)).toBe("5h");
    expect(formatPruneAge(90 * 1000)).toBe("1m");
  });
});

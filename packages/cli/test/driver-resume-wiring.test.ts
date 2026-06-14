/**
 * Wiring test for the driver's opt-in orphan resume (cli-driver-self-resume).
 *
 * `createCliDriverService` builds a resume-enabled `ShipService`; the plain
 * `createCliService` stays resume-off. We pin that difference through the
 * production default-wiring path using a TERMINAL-PARENT orphan, which the
 * resume sweep reconciles regardless of staleness — so the assertion needs no
 * clock control (the staleness-gated running-orphan re-attach is covered by the
 * `@ship/core` resume suite + the live validation gate).
 */

import type { Store } from "@ship/store";

import { closeDefaultSharedStore, getDefaultSharedStore } from "@ship/core";
import { FakeCursorRunner } from "@ship/cursor-runner/test/fake";
import { CLOUD_WORKTREE_SENTINEL } from "@ship/workflow";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createCliDriverService, createCliService } from "../src/service.js";

interface Harness {
  readonly dbPath: string;
  readonly runsDir: string;
  readonly cloudCursor: FakeCursorRunner;
  readonly store: Store;
  readonly opts: {
    readonly dbPath: string;
    readonly runsDir: string;
    readonly cursor: FakeCursorRunner;
    readonly cloudCursor: FakeCursorRunner;
  };
}

let tmp: string;
let h: Harness;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "driver-resume-"));
  const dbPath = join(tmp, "state.db");
  const runsDir = join(tmp, "runs");
  mkdirSync(runsDir, { recursive: true });
  const cloudCursor = new FakeCursorRunner();
  const store = getDefaultSharedStore({ dbPath });
  h = {
    dbPath,
    runsDir,
    cloudCursor,
    store,
    opts: { dbPath, runsDir, cursor: new FakeCursorRunner(), cloudCursor },
  };
});

afterEach(() => {
  closeDefaultSharedStore(h.dbPath);
  rmSync(tmp, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
});

/**
 * Seeds a cloud cursor row whose parent workflow has already gone terminal
 * (cancelled) — the orphan a crashed dispatch leaves behind. Staleness-exempt:
 * the resume sweep reconciles it whenever it runs, so a resume-on ship clears
 * it and a resume-off ship leaves it.
 */
function seedTerminalParentCloudOrphan(): string {
  const workflowRunId = "wf_00000000000000000000000001";
  const phaseId = "ph_00000000000000000000000001";
  const cursorRunId = "cr_00000000000000000000000001";
  h.store.createWorkflowRun({
    baseRef: "main",
    docPath: "docs.md",
    id: workflowRunId,
    policy: { agentTimeoutMs: 1, baseRef: "main", maxRunDurationMs: 1 },
    repo: "ship",
    worktree: {
      baseRef: "main",
      branch: CLOUD_WORKTREE_SENTINEL,
      name: CLOUD_WORKTREE_SENTINEL,
      path: CLOUD_WORKTREE_SENTINEL,
      repo: "ship",
    },
  });
  h.store.appendPhase({
    id: phaseId,
    inputJson: JSON.stringify({
      cloud: { repos: [{ url: "https://github.com/owner/repo" }] },
      docPath: "docs.md",
    }),
    kind: "implement",
    workflowRunId,
  });
  h.store.markRunStarted(workflowRunId, phaseId, "2026-06-13T00:00:00.000Z");
  h.store.updatePhase(phaseId, { cursorRunId, status: "running" });
  h.store.recordCursorRun({
    agentId: "bc-resume-0001",
    artifactsDir: join(h.runsDir, workflowRunId),
    id: cursorRunId,
    model: { id: "composer-2.5" },
    runId: "run-resume-0001",
    runtime: "cloud",
    workflowRunId,
  });
  mkdirSync(join(h.runsDir, workflowRunId), { recursive: true });
  // Cancel updates the workflow + phase rows but leaves cursor_runs `running` —
  // the terminal-parent orphan the resume sweep is meant to reconcile.
  h.store.cancelRun(workflowRunId);
  return workflowRunId;
}

describe("driver opt-in orphan resume wiring", () => {
  test("constructing the driver factory reconciles a terminal-parent orphan", async () => {
    seedTerminalParentCloudOrphan();
    expect(h.store.listResumableCloudCursorRuns()).toHaveLength(1);

    // Bind the assertion to the factory under change: createCliDriverService
    // must build a resume-enabled ship, so constructing it kicks the boot
    // sweep that reconciles the orphan. The sweep is backgrounded inside the
    // encapsulated ship (no drain handle on DriverService), so await its
    // store side-effect. If the driver ever stops passing resumeOrphans, the
    // orphan stays resumable and this times out — exactly the regression to catch.
    createCliDriverService(h.opts)();
    await vi.waitFor(() => {
      expect(h.store.listResumableCloudCursorRuns()).toHaveLength(0);
    });
  });

  test("the plain command service leaves the orphan untouched", async () => {
    seedTerminalParentCloudOrphan();
    expect(h.store.listResumableCloudCursorRuns()).toHaveLength(1);

    // The resume-off service backing list/status/get/ship/cancel. Drainable,
    // so the no-op is deterministic — the orphan stays resumable.
    const ship = createCliService(h.opts)();
    await ship.resumeReady();
    await ship.drainBackground();

    expect(h.store.listResumableCloudCursorRuns()).toHaveLength(1);
  });
});

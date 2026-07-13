/**
 * Unit tests for `ShipService.refreshOrphanedRuns` — the non-streaming,
 * one-shot orphan refresh the driver tick uses (driver-hardening spec
 * `driver-orphan-refresh-non-streaming`). Distinct from the streaming
 * `resumeOrphanedRuns`: a terminal orphan is harvested in a single
 * `refreshRun` read, a still-running orphan is left untouched, and nothing
 * (stream / pump / cap timer / abort-cancel) outlives the read.
 */

import type { AgentRunResult } from "@ship/agent-runner";
import type { Store } from "@ship/store";

import { FakeCursorRunner } from "@ship/cursor-runner/test/fake";
import { createStore } from "@ship/store";
import { CLOUD_WORKTREE_SENTINEL } from "@ship/workflow";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { ORPHAN_RESUME_STALENESS_MS } from "./cursor-runs/orphan-resume.js";
import { createMemoryShipFs, type MemoryShipFs } from "./fs/memory.js";
import { createShipService, type ShipService } from "./service.js";

const RUNS_DIR = "/state/runs";
const WORKFLOW_RUN_ID = "wf_00000000000000000000000042";
const PHASE_ID = "ph_00000000000000000000000042";
const CURSOR_RUN_ID = "cr_00000000000000000000000042";
const AGENT_ID = "bc-refresh-0001";
const SDK_RUN_ID = "run-refresh-0001";

const REPO_URL = "https://github.com/owner/repo";
const CLOUD_SPEC = { repos: [{ url: REPO_URL }] };

// The orphan row is stamped at t0; the service clock runs well past the
// staleness threshold so the row is eligible for refresh (a fresh row belongs
// to a live sibling process and is skipped).
const ROW_STAMP = "2026-07-12T00:00:00.000Z";
const SERVICE_NOW = new Date(
  new Date(ROW_STAMP).getTime() + ORPHAN_RESUME_STALENESS_MS + 60_000,
).toISOString();

function deterministicClock(start: string, stepMs = 1000): () => string {
  let t = new Date(start).getTime();
  return () => {
    const out = new Date(t).toISOString();
    t += stepMs;
    return out;
  };
}

interface OrphanHarness {
  service: ShipService;
  store: Store;
  fs: MemoryShipFs;
  cloudCursor: FakeCursorRunner;
}

// Seeds a cloud orphan: workflow row `running`, implement phase linked to a
// `running` cloud cursor row with a persisted SDK runId — exactly the shape
// `listResumableCloudCursorRuns` returns after a process kill.
async function seedOrphan(opts?: { rowStamp?: string }): Promise<OrphanHarness> {
  const rowStamp = opts?.rowStamp ?? ROW_STAMP;
  const fs = createMemoryShipFs();
  await fs.mkdir(`${RUNS_DIR}/${WORKFLOW_RUN_ID}`, { recursive: true });
  const store = createStore({ clock: deterministicClock(rowStamp, 0), dbPath: ":memory:" });
  const cloudCursor = new FakeCursorRunner();

  store.createWorkflowRun({
    baseRef: "main",
    docPath: "docs/task.md",
    id: WORKFLOW_RUN_ID,
    policy: { agentTimeoutMs: 1, baseRef: "main", maxRunDurationMs: 60_000 },
    repo: "ship",
    worktree: {
      baseRef: "main",
      branch: CLOUD_WORKTREE_SENTINEL,
      name: CLOUD_WORKTREE_SENTINEL,
      path: CLOUD_WORKTREE_SENTINEL,
      repo: "ship",
    },
  });
  store.appendPhase({
    id: PHASE_ID,
    inputJson: JSON.stringify({ cloud: CLOUD_SPEC, docPath: "docs/task.md" }),
    kind: "implement",
    workflowRunId: WORKFLOW_RUN_ID,
  });
  store.markRunStarted(WORKFLOW_RUN_ID, PHASE_ID, rowStamp);
  store.updatePhase(PHASE_ID, { cursorRunId: CURSOR_RUN_ID, status: "running" });
  store.recordCursorRun({
    agentId: AGENT_ID,
    artifactsDir: `${RUNS_DIR}/${WORKFLOW_RUN_ID}`,
    id: CURSOR_RUN_ID,
    model: { id: "composer-2.5" },
    runId: SDK_RUN_ID,
    runtime: "cloud",
    workflowRunId: WORKFLOW_RUN_ID,
  });

  const service = createShipService({
    clock: deterministicClock(SERVICE_NOW, 1000),
    config: {
      cloudCursor,
      cursor: new FakeCursorRunner(),
      defaultModel: { id: "composer-2.5" },
      runsDir: RUNS_DIR,
    },
    fs,
    store,
  });

  return { cloudCursor, fs, service, store };
}

const TERMINAL_SUCCESS: AgentRunResult = {
  branches: [{ branch: "feat/x", prUrl: `${REPO_URL}/pull/7`, repoUrl: REPO_URL }],
  durationMs: 5000,
  status: "succeeded",
  summary: "done after refresh",
};

describe("ShipService.refreshOrphanedRuns — terminal harvest", () => {
  let h: OrphanHarness;
  beforeEach(async () => {
    h = await seedOrphan();
  });

  test("a terminal orphan is finalized from a single refreshRun read (no attach, no stream)", async () => {
    h.cloudCursor.enqueueRefresh(TERMINAL_SUCCESS);

    await h.service.refreshOrphanedRuns();

    const row = await h.service.getRun(WORKFLOW_RUN_ID);
    expect(row?.status).toBe("succeeded");
    // Exactly one non-streaming read; the streaming attach path is never taken.
    expect(h.cloudCursor.refreshCalls).toHaveLength(1);
    expect(h.cloudCursor.refreshCalls[0]?.input.runId).toBe(SDK_RUN_ID);
    expect(h.cloudCursor.attachCalls).toHaveLength(0);
  });

  test("harvest persists result.json and the terminal cursor-run row", async () => {
    h.cloudCursor.enqueueRefresh(TERMINAL_SUCCESS);

    await h.service.refreshOrphanedRuns();

    const resultJson = await h.fs.readFile(`${RUNS_DIR}/${WORKFLOW_RUN_ID}/result.json`, "utf-8");
    expect(JSON.parse(resultJson)).toMatchObject({
      status: "succeeded",
      summary: "done after refresh",
    });
    const cursorRun = h.store.getCursorRun(CURSOR_RUN_ID);
    expect(cursorRun?.status).toBe("succeeded");
    expect(cursorRun?.durationMs).toBe(5000);
    h.store.close();
  });

  test("a terminal-failed orphan is harvested as failed with a classified category", async () => {
    h.cloudCursor.enqueueRefresh({
      branches: [],
      durationMs: 1000,
      errorMessage: "SDK status ERROR",
      sdkTerminalStatus: "error",
      status: "failed",
    });

    await h.service.refreshOrphanedRuns();

    const row = await h.service.getRun(WORKFLOW_RUN_ID);
    expect(row?.status).toBe("failed");
    expect(row?.failureCategory).toBeDefined();
    h.store.close();
  });
});

describe("ShipService.refreshOrphanedRuns — still-running is untouched", () => {
  test("a still-running orphan is left running: not cancelled, not streamed", async () => {
    const h = await seedOrphan();
    h.cloudCursor.enqueueRefresh({ stillRunning: true });

    await h.service.refreshOrphanedRuns();

    const row = await h.service.getRun(WORKFLOW_RUN_ID);
    expect(row?.status).toBe("running");
    // The cursor row stays running too — no terminal write happened.
    expect(h.store.getCursorRun(CURSOR_RUN_ID)?.status).toBe("running");
    // One read, and crucially no attach (which would stream + cancel-on-abort).
    expect(h.cloudCursor.refreshCalls).toHaveLength(1);
    expect(h.cloudCursor.attachCalls).toHaveLength(0);
    h.store.close();
  });

  test("a later refresh harvests the orphan once it has gone terminal", async () => {
    const h = await seedOrphan();
    h.cloudCursor.enqueueRefresh({ stillRunning: true });
    await h.service.refreshOrphanedRuns();
    expect((await h.service.getRun(WORKFLOW_RUN_ID))?.status).toBe("running");

    // Next tick: the run has finished cloud-side; a single fetch harvests it.
    h.cloudCursor.enqueueRefresh(TERMINAL_SUCCESS);
    await h.service.refreshOrphanedRuns();

    expect((await h.service.getRun(WORKFLOW_RUN_ID))?.status).toBe("succeeded");
    expect(h.cloudCursor.refreshCalls).toHaveLength(2);
    expect(h.cloudCursor.attachCalls).toHaveLength(0);
    h.store.close();
  });

  test("a transient refresh read error leaves the row running for a later tick", async () => {
    const h = await seedOrphan();
    // A plain thrown error (not AgentNotFound) is transient — row stays running.
    h.cloudCursor.enqueueRefresh({ error: new Error("network blip") });

    await h.service.refreshOrphanedRuns();

    expect((await h.service.getRun(WORKFLOW_RUN_ID))?.status).toBe("running");
    expect(h.store.getCursorRun(CURSOR_RUN_ID)?.status).toBe("running");
    h.store.close();
  });
});

describe("ShipService.refreshOrphanedRuns — freshness + terminal-parent guards", () => {
  test("a fresh orphan (recent updated_at) is skipped — belongs to a live sibling", async () => {
    // Row stamped at the service's own 'now' → not stale → not refreshed.
    const h = await seedOrphan({ rowStamp: SERVICE_NOW });
    h.cloudCursor.enqueueRefresh(TERMINAL_SUCCESS);

    await h.service.refreshOrphanedRuns();

    expect(h.cloudCursor.refreshCalls).toHaveLength(0);
    expect((await h.service.getRun(WORKFLOW_RUN_ID))?.status).toBe("running");
    h.store.close();
  });

  test("an AgentNotFound refresh finalizes the orphan as failed (agent gone)", async () => {
    const h = await seedOrphan();
    h.cloudCursor.enqueueRefresh({ notFound: true });

    await h.service.refreshOrphanedRuns();

    expect((await h.service.getRun(WORKFLOW_RUN_ID))?.status).toBe("failed");
    h.store.close();
  });

  test("no-op when no cloud runner is configured", async () => {
    const h = await seedOrphan();
    const fs = h.fs;
    const noCloud = createShipService({
      clock: deterministicClock(SERVICE_NOW, 1000),
      config: {
        cursor: new FakeCursorRunner(),
        defaultModel: { id: "composer-2.5" },
        runsDir: RUNS_DIR,
      },
      fs,
      store: h.store,
    });

    await expect(noCloud.refreshOrphanedRuns()).resolves.toBeUndefined();
    expect((await noCloud.getRun(WORKFLOW_RUN_ID))?.status).toBe("running");
    h.store.close();
  });
});

describe("ShipService.refreshOrphanedRuns — no lingering handles", () => {
  // The acceptance-critical property: harvesting a terminal orphan arms neither
  // a heartbeat pump (`setInterval`) nor a duration-cap timer (`setTimeout`),
  // so a `ship driver run --max-wait 0` returns control to the shell promptly
  // rather than being held open by a ref'd timer or SDK socket.
  test("harvesting a terminal orphan arms no setInterval / setTimeout", async () => {
    const h = await seedOrphan();
    h.cloudCursor.enqueueRefresh(TERMINAL_SUCCESS);

    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      await h.service.refreshOrphanedRuns();
    } finally {
      intervalSpy.mockRestore();
      timeoutSpy.mockRestore();
    }

    expect((await h.service.getRun(WORKFLOW_RUN_ID))?.status).toBe("succeeded");
    // Streaming resume arms both (event-pump interval + cap timer); the refresh
    // must arm neither.
    expect(intervalSpy).not.toHaveBeenCalled();
    expect(timeoutSpy).not.toHaveBeenCalled();
    h.store.close();
  });

  test("a still-running refresh also arms no timers", async () => {
    const h = await seedOrphan();
    h.cloudCursor.enqueueRefresh({ stillRunning: true });

    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      await h.service.refreshOrphanedRuns();
    } finally {
      intervalSpy.mockRestore();
      timeoutSpy.mockRestore();
    }

    expect(intervalSpy).not.toHaveBeenCalled();
    expect(timeoutSpy).not.toHaveBeenCalled();
    h.store.close();
  });
});

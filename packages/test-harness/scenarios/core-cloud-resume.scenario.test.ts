/**
 * L2 scenario: simulated Ship-process restart resumes an orphaned cloud run.
 */

import { FakeCursorRunner } from "@ship/cursor-runner/test/fake";
import { createStore } from "@ship/store";
import { CLOUD_WORKTREE_SENTINEL } from "@ship/workflow";
import { expect, test } from "vitest";

import { createMemoryShipFs } from "../../core/src/fs/memory.js";
import { createShipService } from "../../core/src/service.js";

const RUNS_DIR = "/state/runs";
const WORKFLOW_RUN_ID = "wf_00000000000000000000000010";
const PHASE_ID = "ph_00000000000000000000000010";
const CURSOR_RUN_ID = "cr_00000000000000000000000010";

const CLOUD_SPEC = {
  repos: [{ url: "https://github.com/owner/repo" }],
};

function deterministicClock(start: string, stepMs = 1000): () => string {
  let t = new Date(start).getTime();
  return () => {
    const out = new Date(t).toISOString();
    t += stepMs;
    return out;
  };
}

async function waitForTerminal(
  service: ReturnType<typeof createShipService>,
  id: string,
): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const row = await service.getRun(id);
    if (row?.status === "succeeded" || row?.status === "failed" || row?.status === "cancelled") {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error(`timed out waiting for ${id} to reach terminal`);
}

test("kill-mid-run restart: resumeOrphanedRuns attaches and completes the same workflowRunId", async () => {
  const fs = createMemoryShipFs();
  await fs.mkdir(RUNS_DIR, { recursive: true });
  const store = createStore({
    clock: deterministicClock("2026-05-23T00:00:00.000Z"),
    dbPath: ":memory:",
  });
  const cloudCursor = new FakeCursorRunner();

  store.createWorkflowRun({
    baseRef: "main",
    docPath: "docs/task.md",
    id: WORKFLOW_RUN_ID,
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
  store.appendPhase({
    id: PHASE_ID,
    inputJson: JSON.stringify({ cloud: CLOUD_SPEC, docPath: "docs/task.md" }),
    kind: "implement",
    workflowRunId: WORKFLOW_RUN_ID,
  });
  store.markRunStarted(WORKFLOW_RUN_ID, PHASE_ID, "2026-05-23T00:00:00.000Z");
  store.updatePhase(PHASE_ID, { cursorRunId: CURSOR_RUN_ID, status: "running" });
  store.recordCursorRun({
    agentId: "bc-l2-resume-0001",
    artifactsDir: `${RUNS_DIR}/${WORKFLOW_RUN_ID}`,
    id: CURSOR_RUN_ID,
    model: { id: "composer-2.5" },
    runId: "run-l2-resume-0001",
    runtime: "cloud",
    workflowRunId: WORKFLOW_RUN_ID,
  });
  await fs.mkdir(`${RUNS_DIR}/${WORKFLOW_RUN_ID}`, { recursive: true });
  await fs.writeFile(
    `${RUNS_DIR}/${WORKFLOW_RUN_ID}/events.ndjson`,
    '{"type":"assistant","run_id":"run-l2-resume-0001"}\n',
  );

  cloudCursor.enqueueAttach({
    events: [],
    result: {
      branches: [],
      durationMs: 5000,
      status: "succeeded",
      summary: "finished after resume",
    },
  });

  const restarted = createShipService({
    clock: deterministicClock("2026-05-23T01:00:00.000Z", 1000),
    config: {
      cloudCursor,
      cursor: new FakeCursorRunner(),
      defaultModel: { id: "composer-2.5" },
      runsDir: RUNS_DIR,
    },
    fs,
    resumeOrphans: true,
    store,
  });

  await restarted.drainBackground();
  await restarted.resumeReady();
  await waitForTerminal(restarted, WORKFLOW_RUN_ID);

  const row = await restarted.getRun(WORKFLOW_RUN_ID);
  expect(row?.status).toBe("succeeded");
  expect(cloudCursor.attachCalls).toHaveLength(1);
  expect(cloudCursor.attachCalls[0]?.input.runId).toBe("run-l2-resume-0001");

  const resultJson = await fs.readFile(`${RUNS_DIR}/${WORKFLOW_RUN_ID}/result.json`, "utf-8");
  expect(JSON.parse(resultJson)).toMatchObject({
    status: "succeeded",
    summary: "finished after resume",
  });

  store.close();
});

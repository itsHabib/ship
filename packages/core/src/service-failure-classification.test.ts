/**
 * Failure classification wiring — finalizeSuccess / finalizeFailure persist
 * `failureCategory` and category-prefixed `errorMessage`.
 */

import { FakeCursorRunner } from "@ship/cursor-runner/test/fake";
import { createStore, StoreContentionError } from "@ship/store";
import { DEFAULT_WORKFLOW_POLICY } from "@ship/workflow";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createMemoryShipFs } from "./fs/memory.js";
import { createShipService, type ShipService } from "./service.js";

const RUNS_DIR = "/state/runs";
const WORKDIR = "/work/wt/feat";

interface Harness {
  service: ShipService;
  cursor: FakeCursorRunner;
  store: ReturnType<typeof createStore>;
}

async function createHarness(): Promise<Harness> {
  const fs = createMemoryShipFs();
  await fs.mkdir(WORKDIR, { recursive: true });
  await fs.writeFile(`${WORKDIR}/docs.md`, "# task\n");
  const store = createStore({ dbPath: ":memory:" });
  const cursor = new FakeCursorRunner();
  const service = createShipService({
    clock: () => "2026-06-08T00:00:00.000Z",
    config: {
      cursor,
      defaultModel: { id: "composer-2.5" },
      runsDir: RUNS_DIR,
    },
    fs,
    ids: {
      cursorRun: () => "cr_test_001",
      phase: () => "ph_test_001",
      workflowRun: () => "wf_test_001",
    },
    store,
  });
  return { cursor, service, store };
}

describe("ShipService failure classification wiring", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(() => {
    h.store.close();
  });

  test("finalizeSuccess (failed CursorRunResult) persists logic category from tool_call events", async () => {
    const toolErr = {
      type: "tool_call",
      status: "error",
      result: "make check failed",
    };
    h.cursor.enqueue({
      events: [toolErr] as never[],
      result: {
        branches: [],
        durationMs: 1000,
        errorMessage:
          "SDK status ERROR after 0m (cap 30m); last tool_call errored: make check failed",
        sdkTerminalStatus: "ERROR",
        status: "failed",
      },
    });

    const out = await h.service.ship({
      docPath: "docs.md",
      repo: "ship",
      workdir: WORKDIR,
    });
    expect(out.status).toBe("failed");
    const row = h.store.getRun(out.workflowRunId);
    expect(row?.phases[0]?.failureCategory).toBe("logic");
    expect(row?.phases[0]?.errorMessage).toBe("logic; make check failed");
  });

  test("finalizeFailure (thrown SDK error) persists sdk-throw category", async () => {
    const out = await h.service.ship({
      docPath: "docs.md",
      repo: "ship",
      workdir: WORKDIR,
    });
    expect(out.status).toBe("failed");
    const row = h.store.getRun(out.workflowRunId);
    expect(row?.phases[0]?.failureCategory).toBe("sdk-throw");
    expect(row?.phases[0]?.errorMessage).toMatch(/^sdk-throw; /);
    expect(row?.phases[0]?.errorMessage).toMatch(/no script enqueued/i);
  });

  test("finalizeFailure with StoreContentionError persists contention category", async () => {
    h.cursor.enqueue({
      events: [],
      result: {
        branches: [],
        durationMs: 1,
        errorMessage: "model rejected",
        status: "failed",
      },
    });
    const origUpdateWorkflow = h.store.updateWorkflowRunStatus.bind(h.store);
    let calls = 0;
    h.store.updateWorkflowRunStatus = (id, status) => {
      calls += 1;
      if (calls === 1) {
        throw new StoreContentionError(new Error("SQLITE_BUSY: database is locked"));
      }
      return origUpdateWorkflow(id, status);
    };

    const out = await h.service.ship({
      docPath: "docs.md",
      repo: "ship",
      workdir: WORKDIR,
    });
    expect(out.status).toBe("failed");
    const row = h.store.getRun(out.workflowRunId);
    expect(row?.phases[0]?.failureCategory).toBe("contention");
    expect(row?.phases[0]?.errorMessage).toMatch(/^contention; /);
  });

  test("cloud EXPIRED via finalizeSuccess lands timeout-near-cap when wired through core", async () => {
    const capMs = DEFAULT_WORKFLOW_POLICY.maxRunDurationMs;
    h.cursor.enqueue({
      events: [{ type: "status", status: "EXPIRED" }] as never[],
      result: {
        branches: [],
        durationMs: capMs,
        sdkTerminalStatus: "EXPIRED",
        status: "failed",
      },
    });

    const out = await h.service.ship({
      docPath: "docs.md",
      repo: "ship",
      workdir: WORKDIR,
    });
    expect(out.status).toBe("failed");
    const row = h.store.getRun(out.workflowRunId);
    expect(row?.phases[0]?.failureCategory).toBe("timeout-near-cap");
    expect(row?.phases[0]?.errorMessage).toMatch(/^timeout-near-cap; /);
  });
});

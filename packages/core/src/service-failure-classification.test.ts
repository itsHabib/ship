/**
 * Failure classification wiring — finalizeSuccess / finalizeFailure persist
 * `failureCategory` and category-prefixed `errorMessage`.
 */

import type { Logger } from "@ship/logger";

import { FakeCursorRunner } from "@ship/cursor-runner/test/fake";
import { createStore, StoreContentionError } from "@ship/store";
import { DEFAULT_WORKFLOW_POLICY } from "@ship/workflow";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createMemoryShipFs, type MemoryShipFs } from "./fs/memory.js";
import { createShipService, type ShipService } from "./service.js";

const RUNS_DIR = "/state/runs";
const WORKDIR = "/work/wt/feat";

interface Harness {
  service: ShipService;
  cursor: FakeCursorRunner;
  fs: MemoryShipFs;
  store: ReturnType<typeof createStore>;
}

async function readResultJson(fs: MemoryShipFs, path: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(path, "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

async function createHarness(opts?: { readonly logger?: Logger }): Promise<Harness> {
  const fs = createMemoryShipFs();
  await fs.mkdir(WORKDIR, { recursive: true });
  await fs.writeFile(`${WORKDIR}/docs.md`, "# task\n");
  const store = createStore({ dbPath: ":memory:" });
  const cursor = new FakeCursorRunner();
  const service = createShipService({
    clock: () => "2026-06-08T00:00:00.000Z",
    // logger is a top-level ShipServiceDeps dep, NOT a config field — putting it
    // in config is silently dropped (a conditional spread defeats TS excess-
    // property checks) and would make the injection a no-op.
    ...(opts?.logger !== undefined && { logger: opts.logger }),
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
  return { cursor, fs, service, store };
}

describe("ShipService failure classification wiring", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(() => {
    h.store.close();
  });

  test("finalizeSuccess (failed AgentRunResult) persists logic category from tool_call events", async () => {
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

    const resultJson = await readResultJson(h.fs, out.artifacts.resultPath);
    expect(resultJson["failureCategory"]).toBe("logic");
    expect(resultJson["failureDetail"]).toBe("make check failed");
    expect(resultJson).not.toHaveProperty("classificationEvents");
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

  test("artifact write failure on a succeeded run classifies as unknown, not sdk-throw", async () => {
    h.cursor.enqueue({
      events: [],
      result: {
        branches: [],
        durationMs: 1000,
        status: "succeeded",
        summary: "done",
      },
    });
    const origWrite = h.fs.writeFile.bind(h.fs);
    h.fs.writeFile = (path, data) => {
      if (path.endsWith("result.json")) return Promise.reject(new Error("disk full"));
      return origWrite(path, data);
    };

    const out = await h.service.ship({
      docPath: "docs.md",
      repo: "ship",
      workdir: WORKDIR,
    });
    expect(out.status).toBe("failed");
    const row = h.store.getRun(out.workflowRunId);
    // ArtifactWriteFailedError is ship-internal, not an SDK reject → unknown.
    expect(row?.phases[0]?.failureCategory).toBe("unknown");
    expect(row?.phases[0]?.errorMessage).toMatch(/^unknown; /);
  });

  test("cancel landing during artifact write keeps the run cancelled without failure text", async () => {
    // Failed result so classifyFinalizedResult rewrites errorMessage/category.
    h.cursor.enqueue({
      events: [{ type: "tool_call", status: "error", result: "boom" }] as never[],
      result: {
        branches: [],
        durationMs: 1000,
        sdkTerminalStatus: "ERROR",
        status: "failed",
      },
    });
    // Flip the run to cancelled during the result.json write — simulates a
    // concurrent cancelRun() landing in the async gap before persist.
    const origWrite = h.fs.writeFile.bind(h.fs);
    h.fs.writeFile = (path, data) => {
      if (path.endsWith("result.json")) {
        h.store.updateWorkflowRunStatus("wf_test_001", "cancelled");
      }
      return origWrite(path, data);
    };

    const out = await h.service.ship({
      docPath: "docs.md",
      repo: "ship",
      workdir: WORKDIR,
    });
    expect(out.status).toBe("cancelled");
    const row = h.store.getRun(out.workflowRunId);
    expect(row?.status).toBe("cancelled");
    expect(row?.phases[0]?.status).toBe("cancelled");
    expect(row?.phases[0]?.errorMessage).toBeUndefined();
    expect(row?.phases[0]?.failureCategory).toBeUndefined();
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

  test("a custom logger whose child() throws does not strand the run", async () => {
    const noop = (): void => undefined;
    const throwingChildLogger = {
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
      child: () => {
        throw new Error("child boom");
      },
    } as unknown as Logger;
    const h2 = await createHarness({ logger: throwingChildLogger });
    try {
      h2.cursor.enqueue({
        events: [],
        result: { branches: [], durationMs: 10, status: "succeeded", summary: "ok" },
      });
      // runScopedLogger swallows the throwing child() and falls back to the root
      // logger, so the run still reaches a terminal state instead of stranding.
      const out = await h2.service.ship({ docPath: "docs.md", repo: "ship", workdir: WORKDIR });
      expect(out.status).toBe("succeeded");
      expect(h2.store.getRun(out.workflowRunId)?.status).toBe("succeeded");
    } finally {
      h2.store.close();
    }
  });
});

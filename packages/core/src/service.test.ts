/**
 * Unit tests for `ShipService` — workdir/doc validation, the five
 * methods, the state machine. Backed by a real `@ship/store`
 * (:memory:), the in-memory `ShipFs`, and `FakeCursorRunner`.
 */

import type { ShipInput } from "@ship/mcp";
import type { Store } from "@ship/store";
import type { WorkflowRun } from "@ship/workflow";

import { FakeCursorRunner } from "@ship/cursor-runner/test/fake";
import { createStore } from "@ship/store";
import { isTerminal } from "@ship/workflow";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { CloudRunnerNotConfiguredError, DocNotFoundError, WorkdirNotFoundError } from "./errors.js";
import { createMemoryShipFs, type MemoryShipFs } from "./fs/memory.js";
import { createShipService, type ShipService, type ShipServiceConfig } from "./service.js";

const RUNS_DIR = "/state/runs";
const WORKDIR = "/work/wt/feat";

// Polls `service.getRun` for the given id until the row reaches a
// terminal status. Used by the V2 `startShip` tests — the kickoff
// returns immediately, so terminal assertions wait here. Also called
// from each test's drain step so the store isn't closed mid-write.
async function waitForRunTerminal(service: ShipService, id: string): Promise<WorkflowRun> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const row = await service.getRun(id);
    if (row !== null && isTerminal(row.status)) {
      return row;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error(`waitForRunTerminal: timed out waiting for ${id} to reach terminal`);
}

function deterministicClock(start: string, stepMs = 1): () => string {
  let t = new Date(start).getTime();
  return () => {
    const out = new Date(t).toISOString();
    t += stepMs;
    return out;
  };
}

function deterministicIds(): {
  workflowRun: () => string;
  phase: () => string;
  cursorRun: () => string;
} {
  let wf = 0;
  let ph = 0;
  let cr = 0;
  const pad = (n: number): string => n.toString().padStart(26, "0");
  return {
    workflowRun: () => `wf_${pad(++wf)}`,
    phase: () => `ph_${pad(++ph)}`,
    cursorRun: () => `cr_${pad(++cr)}`,
  };
}

interface Harness {
  service: ShipService;
  fs: MemoryShipFs;
  store: Store;
  /** Fake local runner — historical name `cursor` for existing tests. */
  cursor: FakeCursorRunner;
  cloudCursor: FakeCursorRunner;
  config: ShipServiceConfig;
}

async function createHarness(opts?: {
  defaultModelId?: string;
  defaultModelParams?: { id: string; value: string }[];
  omitCloudCursor?: boolean;
}): Promise<Harness> {
  const fs = createMemoryShipFs();
  await fs.mkdir(RUNS_DIR, { recursive: true });
  await fs.mkdir(WORKDIR, { recursive: true });
  await fs.writeFile(`${WORKDIR}/docs.md`, "# Task\n\nDo the thing.");

  const store = createStore({
    dbPath: ":memory:",
    clock: deterministicClock("2026-05-09T00:00:00.000Z"),
  });
  const cursor = new FakeCursorRunner();
  const cloudCursor = new FakeCursorRunner();
  const config: ShipServiceConfig = {
    runsDir: RUNS_DIR,
    defaultModel: {
      id: opts?.defaultModelId ?? "composer-2.5",
      params: opts?.defaultModelParams ?? [{ id: "fast", value: "true" }],
    },
    cursor,
    ...(opts?.omitCloudCursor ? {} : { cloudCursor }),
  };

  const service = createShipService({
    store,
    fs,
    clock: deterministicClock("2026-05-09T00:00:00.000Z", 1000),
    config,
    ids: deterministicIds(),
  });

  return { service, fs, store, cursor, cloudCursor, config };
}

describe("createShipService — dep injection defaults", () => {
  test("omitted `ids` falls back to real ULID factories; produces a wf_<26> id", async () => {
    const fs = createMemoryShipFs();
    await fs.mkdir("/state/runs", { recursive: true });
    await fs.mkdir(WORKDIR, { recursive: true });
    await fs.writeFile(`${WORKDIR}/docs.md`, "x");
    const store = createStore({
      dbPath: ":memory:",
      clock: deterministicClock("2026-05-09T00:00:00.000Z"),
    });
    const cursor = new FakeCursorRunner();
    cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    const service = createShipService({
      store,
      fs,
      clock: deterministicClock("2026-05-09T00:00:00.000Z", 1000),
      config: {
        runsDir: RUNS_DIR,
        defaultModel: {
          id: "composer-2.5",
          params: [{ id: "fast", value: "true" }],
        },
        mcpServers: { foo: { type: "stdio" as const, command: "/bin/foo" } },
        cursor,
        cloudCursor: new FakeCursorRunner(),
      },
      // `ids` deliberately omitted to hit the `deps.ids ?? {...}` fallback.
    });

    const out = await service.ship({ workdir: WORKDIR, repo: "ship", docPath: "docs.md" });
    expect(out.workflowRunId).toMatch(/^wf_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    // Configured `mcpServers` reaches the runner — exercises the conditional spread.
    expect(cursor.calls[0]?.input.mcpServers).toEqual({
      foo: { type: "stdio", command: "/bin/foo" },
    });
    store.close();
  });
});

describe("ShipService.ship — happy path", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(() => {
    h.store.close();
  });

  test("succeeded run links the phase row to the recorded cursorRunId", async () => {
    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });

    const out = await h.service.ship({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
    });
    const row = h.store.getRun(out.workflowRunId);
    expect(row?.phases[0]?.cursorRunId).toBeDefined();
    expect(row?.phases[0]?.cursorRunId).toBe(out.cursorRun.id);
  });

  test("succeeded run: state transitions, artifacts persisted, ShipOutput populated", async () => {
    h.cursor.enqueue({
      events: [],
      result: {
        status: "succeeded",
        summary: "implementation done",
        durationMs: 12_000,
        branches: [],
      },
    });

    const out = await h.service.ship({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
    });

    expect(out.status).toBe("succeeded");
    expect(out.workflowRunId).toMatch(/^wf_/);
    expect(out.summary).toBe("implementation done");
    expect(out.artifacts.promptPath.endsWith("prompt.md")).toBe(true);
    expect(out.artifacts.eventsPath.endsWith("events.ndjson")).toBe(true);
    expect(out.artifacts.resultPath.endsWith("result.json")).toBe(true);

    // Artifacts on disk
    const promptContent = await h.fs.readFile(out.artifacts.promptPath, "utf-8");
    expect(promptContent).toContain("Repo: ship");
    expect(promptContent).toContain("Worktree path: /work/wt/feat");
    expect(promptContent).toContain("Do the thing.");

    const resultContent = await h.fs.readFile(out.artifacts.resultPath, "utf-8");
    expect(JSON.parse(resultContent)).toMatchObject({ status: "succeeded" });

    // Workflow row terminal
    const row = h.store.getRun(out.workflowRunId);
    expect(row?.status).toBe("succeeded");
    expect(row?.phases).toHaveLength(1);
    expect(row?.phases[0]?.status).toBe("succeeded");
  });

  test("ShipOutput.summary omitted when result.summary missing", async () => {
    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });

    const out = await h.service.ship({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
    });
    expect(out.summary).toBeUndefined();
  });

  test("uses config.defaultModel verbatim when caller omits overrides", async () => {
    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });

    await h.service.ship({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
    });

    expect(h.cursor.calls[0]?.input.model).toEqual({
      id: "composer-2.5",
      params: [{ id: "fast", value: "true" }],
    });
  });

  test("uses input.model when provided; drops wiring params on a fresh model id", async () => {
    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });

    await h.service.ship({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
      model: "composer-2-thinking",
    });

    // input.model overrides the wiring's id; the wiring's `params`
    // are NOT grafted onto the override because the override model
    // id might not accept the same parameter grid.
    expect(h.cursor.calls[0]?.input.model).toEqual({ id: "composer-2-thinking" });
  });

  test("input.modelParams without input.model uses wiring id + replaces params wholly", async () => {
    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });

    await h.service.ship({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
      modelParams: [{ id: "fast", value: false }],
    });

    expect(h.cursor.calls[0]?.input.model).toEqual({
      id: "composer-2.5",
      params: [{ id: "fast", value: false }],
    });
  });

  test("input.modelParams alone does not inherit other wiring-default params", async () => {
    const localHarness = await createHarness({
      defaultModelParams: [
        { id: "other", value: "wiring-extra" },
        { id: "fast", value: "true" },
      ],
    });
    localHarness.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });

    await localHarness.service.ship({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
      modelParams: [{ id: "fast", value: "false" }],
    });

    expect(localHarness.cursor.calls[0]?.input.model).toEqual({
      id: "composer-2.5",
      params: [{ id: "fast", value: "false" }],
    });
    localHarness.store.close();
  });

  test("input.model + input.modelParams carry both through", async () => {
    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });

    await h.service.ship({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
      model: "composer-2-thinking",
      modelParams: [{ id: "fast", value: false }],
    });

    expect(h.cursor.calls[0]?.input.model).toEqual({
      id: "composer-2-thinking",
      params: [{ id: "fast", value: false }],
    });
  });
});

describe("ShipService.ship — failure mapping", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(() => {
    h.store.close();
  });

  test("cursor result.status: failed → workflow row failed; errorMessage carried", async () => {
    h.cursor.enqueue({
      events: [],
      result: {
        status: "failed",
        durationMs: 1_000,
        errorMessage: "model rejected the task",
        branches: [],
      },
    });

    const out = await h.service.ship({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
    });

    expect(out.status).toBe("failed");
    const row = h.store.getRun(out.workflowRunId);
    expect(row?.status).toBe("failed");
    expect(row?.phases[0]?.errorMessage).toBe("model rejected the task");
  });

  test("cursor.run() rejects (pre-run) → ShipOutput resolves with failed", async () => {
    // No script enqueued — FakeCursorRunner rejects with a clear error.
    const out = await h.service.ship({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
    });
    expect(out.status).toBe("failed");
    expect(out.cursorRun.status).toBe("failed");
    expect(out.cursorRun.id).toMatch(/^cr_/);
    const row = h.store.getRun(out.workflowRunId);
    expect(row?.phases[0]?.errorMessage).toMatch(/no script enqueued/i);
  });

  test("fs.writeFile fails persisting prompt.md (pre-runner, post-row) → ShipOutput failed", async () => {
    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });

    // Wrap writeFile so the prompt.md write rejects, exercising the
    // post-row pre-runner failure path. The row has been created at
    // this point, so the failure must resolve `failed`, not throw.
    const origWriteFile = h.fs.writeFile.bind(h.fs);
    h.fs.writeFile = (path: string, data: string): Promise<void> => {
      if (path.endsWith("prompt.md")) {
        return Promise.reject(new Error("ENOSPC: disk full"));
      }
      return origWriteFile(path, data);
    };

    const out = await h.service.ship({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
    });

    expect(out.status).toBe("failed");
    const row = h.store.getRun(out.workflowRunId);
    expect(row?.status).toBe("failed");
    expect(row?.phases[0]?.errorMessage).toMatch(/ENOSPC|disk full/);
  });

  test("store.updateCursorRunStatus throwing surfaces as a failed ShipOutput; cursorRun gets the terminal-status fallback", async () => {
    // Exercises the swallow-and-fall-through path: updateCursorRunStatus
    // throws inside `finalizeSuccess` (bubbles to outer catch), then
    // throws again inside `finalizeFailure` (swallowed). The cursor-run
    // row is left at `running`, so `assertTerminalCursorRunRef` applies
    // the fallback terminal status when building ShipOutput.
    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    h.store.updateCursorRunStatus = () => {
      throw new Error("simulated cursor-run update failure");
    };

    const out = await h.service.ship({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
    });

    expect(out.status).toBe("failed");
    expect(out.cursorRun.status).toBe("failed");
  });

  test("fs.writeFile fails persisting result.json → ShipOutput failed; phase carries cause", async () => {
    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [], summary: "ok" },
    });

    // Wrap fs to make writes to result.json fail.
    const origWriteFile = h.fs.writeFile.bind(h.fs);
    let originalCalls = 0;
    h.fs.writeFile = (path: string, data: string): Promise<void> => {
      originalCalls += 1;
      if (path.endsWith("result.json") && originalCalls < 6) {
        // First write of result.json fails; the failure-path retry succeeds.
        return Promise.reject(new Error("ENOSPC: disk full"));
      }
      return origWriteFile(path, data);
    };

    const out = await h.service.ship({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
    });

    expect(out.status).toBe("failed");
    const row = h.store.getRun(out.workflowRunId);
    expect(row?.phases[0]?.errorMessage).toMatch(/persist run artifacts|ENOSPC/);
  });
});

describe("ShipService.ship — input validation", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(() => {
    h.store.close();
  });

  test("workdir doesn't exist → WorkdirNotFoundError; no row created", async () => {
    await expect(
      h.service.ship({ workdir: "/nope", repo: "ship", docPath: "docs.md" }),
    ).rejects.toBeInstanceOf(WorkdirNotFoundError);
    expect(h.store.listRuns({ limit: 10 })).toHaveLength(0);
  });

  test("docPath doesn't exist → DocNotFoundError; no row created", async () => {
    await expect(
      h.service.ship({ workdir: WORKDIR, repo: "ship", docPath: "missing.md" }),
    ).rejects.toBeInstanceOf(DocNotFoundError);
    expect(h.store.listRuns({ limit: 10 })).toHaveLength(0);
  });
});

describe("ShipService.cancelRun", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(() => {
    h.store.close();
  });

  test("cancel a run that doesn't exist → throws (store invariant)", async () => {
    await expect(h.service.cancelRun("wf_does-not-exist")).rejects.toBeDefined();
  });

  test("cancel arriving during prepareArtifacts (post-row, pre-runner) skips the runner and resolves cancelled", async () => {
    // Stall fs.mkdir so cancelRun() fires after the row is created
    // but before the "running" transition. The service should detect
    // the cancelled row, skip the runner entirely, and resolve with
    // status: "cancelled". The cursor runner must NOT be invoked.
    let resolveMkdir: (() => void) | undefined;
    const mkdirGate = new Promise<void>((resolve) => {
      resolveMkdir = resolve;
    });
    const origMkdir = h.fs.mkdir.bind(h.fs);
    h.fs.mkdir = async (p, opts) => {
      await mkdirGate;
      return origMkdir(p, opts);
    };

    const shipPromise = h.service.ship({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
    });

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 30);
    });

    const runs = h.store.listRuns({ limit: 10 });
    const id = runs[0]?.id;
    expect(id).toBeDefined();
    if (id === undefined) return;

    await h.service.cancelRun(id);
    resolveMkdir?.();

    const out = await shipPromise;
    expect(out.status).toBe("cancelled");
    expect(h.cursor.calls).toHaveLength(0);

    const row = h.store.getRun(out.workflowRunId);
    expect(row?.status).toBe("cancelled");
  });

  test("cancel arriving during runner startup is honored: controller is registered before cursor.run()", async () => {
    // Stall `cursor.run()` so a cancelRun() called during startup
    // sees an active-run entry and can abort. Without the
    // before-cursor-run registration, the abort would no-op, the
    // runner would complete naturally, and the cancelled state would
    // be overwritten by `finalizeSuccess`.
    let resolveStartup: (() => void) | undefined;
    const startupGate = new Promise<void>((resolve) => {
      resolveStartup = resolve;
    });

    const realRun = h.cursor.run.bind(h.cursor);
    h.cursor.run = async (input) => {
      await startupGate;
      return realRun(input);
    };

    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
      cancelBehavior: "complete",
    });

    const shipPromise = h.service.ship({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
    });

    // Wait long enough for the active-run entry to be registered
    // (synchronously, before `cursor.run()` is awaited).
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 30);
    });

    const runs = h.store.listRuns({ limit: 10 });
    const id = runs[0]?.id;
    expect(id).toBeDefined();
    if (id === undefined) return;

    const cancelOut = await h.service.cancelRun(id);
    expect(cancelOut.status).toBe("cancelled");

    resolveStartup?.();
    const out = await shipPromise;
    expect(out.status).toBe("cancelled");

    // Workflow row preserves cancelled even though the runner's
    // `cancelBehavior: "complete"` would otherwise produce a
    // `succeeded` result that finalizeSuccess might overwrite with.
    const row = h.store.getRun(out.workflowRunId);
    expect(row?.status).toBe("cancelled");
  });

  test("cancel an in-flight run → ShipOutput status cancelled", async () => {
    // Script with delayed events so the run is still in-flight when
    // cancelRun fires. Without events to space, instant emission
    // resolves the result before cancel can interleave.
    const evt = {
      type: "assistant" as const,
      agent_id: "x",
      run_id: "y",
      message: { role: "assistant" as const, content: [] },
    };
    h.cursor.enqueue({
      events: [evt, evt, evt, evt] as never,
      result: { status: "succeeded", durationMs: 0, branches: [] },
      cancelBehavior: "complete",
      delayMsBetweenEvents: 100,
    });

    const shipPromise = h.service.ship({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
    });

    // Wait long enough for the run to register in activeRuns.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 30);
    });

    const runs = h.store.listRuns({ limit: 10 });
    expect(runs.length).toBeGreaterThan(0);
    const id = runs[0]?.id;
    expect(id).toBeDefined();
    if (id === undefined) return;

    const cancelOut = await h.service.cancelRun(id);
    expect(cancelOut.status).toBe("cancelled");

    const out = await shipPromise;
    expect(out.status).toBe("cancelled");
  });
});

describe("ShipService.startShip — async kickoff", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    // Cancel any in-flight runs first so the background continuation
    // resolves promptly via the abort signal instead of running to
    // natural completion. Then `drainBackground` waits on the actual
    // setImmediate-wrapped Promise to settle — deterministic where
    // the previous polling-on-row-status drain had a microtask race
    // between `updateWorkflowRunStatus` and the continuation Promise
    // resolving. The drain + close live in `finally` so a busted
    // `listRuns` (e.g. store wedged from a prior test) doesn't skip
    // them and leak a half-closed handle.
    try {
      for (const r of h.store.listRuns({ limit: 100 })) {
        if (isTerminal(r.status)) continue;
        try {
          await h.service.cancelRun(r.id);
        } catch {
          // ignore: run may have already finished between filter + cancel
        }
      }
    } finally {
      await h.service.drainBackground();
      h.store.close();
    }
  });

  test("returns immediately with { workflowRunId, status: 'running' }", async () => {
    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });

    const before = performance.now();
    const start = await h.service.startShip({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
    });
    const elapsed = performance.now() - before;

    expect(start.status).toBe("running");
    expect(start.workflowRunId).toMatch(/^wf_\d{26}$/);
    // The kickoff is a few SQLite writes — far below the V2 budget of < 1s.
    expect(elapsed).toBeLessThan(500);

    await waitForRunTerminal(h.service, start.workflowRunId);
  });

  test("row is in `running` immediately after return; background continuation drives it to terminal", async () => {
    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", summary: "ok", durationMs: 0, branches: [] },
    });

    const start = await h.service.startShip({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
    });

    // Sync-after-return read: `markRunStarted` happened on the same
    // call stack as the kickoff response, so the row is `running` and
    // the phase is `running` with `startedAt` set.
    const initial = await h.service.getRun(start.workflowRunId);
    expect(initial?.status).toBe("running");
    expect(initial?.phases[0]?.status).toBe("running");
    expect(initial?.phases[0]?.startedAt).toBeDefined();

    const terminal = await waitForRunTerminal(h.service, start.workflowRunId);
    expect(terminal.status).toBe("succeeded");
    expect(terminal.phases[0]?.status).toBe("succeeded");
  });

  test("failure in the background continuation is captured by finalizeFailure (terminal `failed`)", async () => {
    // No script enqueued — FakeCursorRunner rejects with a clear error
    // that bubbles up to `runToTerminal`'s catch.
    const start = await h.service.startShip({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
    });
    expect(start.status).toBe("running");

    const terminal = await waitForRunTerminal(h.service, start.workflowRunId);
    expect(terminal.status).toBe("failed");
    expect(terminal.phases[0]?.errorMessage).toMatch(/no script enqueued/i);
  });

  test("activeRuns is populated before return — cancel immediately after startShip resolves still aborts", async () => {
    // Use a delayed event stream so the background continuation is
    // mid-flight when cancel arrives; without spacing, the run
    // resolves before cancel can interleave.
    const evt = {
      type: "assistant" as const,
      agent_id: "x",
      run_id: "y",
      message: { role: "assistant" as const, content: [] },
    };
    h.cursor.enqueue({
      events: [evt, evt] as never,
      result: { status: "succeeded", durationMs: 0, branches: [] },
      cancelBehavior: "complete",
      delayMsBetweenEvents: 100,
    });

    const start = await h.service.startShip({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
    });

    // Cancel on the same microtask as the kickoff return — activeRuns
    // is populated synchronously, so this triggers the abort signal
    // path even before the `setImmediate` continuation fires.
    const cancelOut = await h.service.cancelRun(start.workflowRunId);
    expect(cancelOut.status).toBe("cancelled");

    const terminal = await waitForRunTerminal(h.service, start.workflowRunId);
    expect(terminal.status).toBe("cancelled");
  });

  test("cancel arriving ~50ms after startShip resolves reaches the SDK run", async () => {
    const evt = {
      type: "assistant" as const,
      agent_id: "x",
      run_id: "y",
      message: { role: "assistant" as const, content: [] },
    };
    h.cursor.enqueue({
      events: [evt, evt, evt] as never,
      result: { status: "succeeded", durationMs: 0, branches: [] },
      cancelBehavior: "complete",
      delayMsBetweenEvents: 100,
    });

    const start = await h.service.startShip({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
    });

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });

    const cancelOut = await h.service.cancelRun(start.workflowRunId);
    expect(cancelOut.status).toBe("cancelled");

    const terminal = await waitForRunTerminal(h.service, start.workflowRunId);
    expect(terminal.status).toBe("cancelled");
  });

  test("cancel arriving mid-run during the cursor.run event stream is honored", async () => {
    const evt = {
      type: "assistant" as const,
      agent_id: "x",
      run_id: "y",
      message: { role: "assistant" as const, content: [] },
    };
    h.cursor.enqueue({
      events: [evt, evt, evt, evt, evt] as never,
      result: { status: "succeeded", durationMs: 0, branches: [] },
      cancelBehavior: "complete",
      delayMsBetweenEvents: 100,
    });

    const start = await h.service.startShip({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
    });

    // Wait long enough for the run to be deep into the event stream.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 150);
    });

    const cancelOut = await h.service.cancelRun(start.workflowRunId);
    expect(cancelOut.status).toBe("cancelled");

    const terminal = await waitForRunTerminal(h.service, start.workflowRunId);
    expect(terminal.status).toBe("cancelled");
  });

  test("workdir doesn't exist → startShip rejects pre-row (no row created)", async () => {
    await expect(
      h.service.startShip({ workdir: "/nope", repo: "ship", docPath: "docs.md" }),
    ).rejects.toBeInstanceOf(WorkdirNotFoundError);
    expect(h.store.listRuns({ limit: 10 })).toHaveLength(0);
  });

  test("drainBackground awaits the background continuation deterministically", async () => {
    // Delayed-event script keeps the continuation in-flight long
    // enough that the row is observably `running` between the
    // startShip return and the drainBackground await. Without drain,
    // the row would stay running for the lifetime of the delays.
    const evt = {
      type: "assistant" as const,
      agent_id: "x",
      run_id: "y",
      message: { role: "assistant" as const, content: [] },
    };
    h.cursor.enqueue({
      events: [evt, evt, evt] as never,
      result: { status: "succeeded", durationMs: 0, branches: [] },
      delayMsBetweenEvents: 50,
    });

    const start = await h.service.startShip({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
    });

    // Synchronous read right after kickoff: row is still `running`
    // because the cursor stream has barely begun emitting events.
    expect((await h.service.getRun(start.workflowRunId))?.status).toBe("running");

    await h.service.drainBackground();

    // Post-drain: the setImmediate-wrapped continuation has fully
    // settled, including the finalizeSuccess row update.
    const row = await h.service.getRun(start.workflowRunId);
    expect(row?.status).toBe("succeeded");
    expect(isTerminal(row?.status ?? "pending")).toBe(true);
  });

  test("drainBackground resolves immediately when nothing is in flight", async () => {
    // No startShip called. Sanity that the no-op path doesn't hang or
    // throw on a fresh service.
    await h.service.drainBackground();
  });
});

describe("ShipService.drainBackground — regression for stderr leak", () => {
  // No shared beforeEach harness — each test creates its own so the
  // store can be closed inside the test body and the global stderr
  // capture is scoped to exactly that window.

  test("drain → store.close → setImmediate flush does not write the safety-net log", async () => {
    const local = await createHarness();
    const evt = {
      type: "assistant" as const,
      agent_id: "x",
      run_id: "y",
      message: { role: "assistant" as const, content: [] },
    };
    local.cursor.enqueue({
      events: [evt, evt] as never,
      result: { status: "succeeded", durationMs: 0, branches: [] },
      delayMsBetweenEvents: 50,
    });

    const originalWrite = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
      return true;
    }) as typeof process.stderr.write;

    try {
      const start = await local.service.startShip({
        workdir: WORKDIR,
        repo: "ship",
        docPath: "docs.md",
      });
      expect(start.status).toBe("running");

      await local.service.drainBackground();
      local.store.close();

      // Two setImmediate yields — a broken drainBackground would let
      // a still-queued continuation run on one of these, hit the
      // closed handle, and write the safety-net log. With a working
      // drainBackground the continuation has already settled, so
      // these yields are no-ops.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(captured.join("")).not.toContain("background continuation rejected after finalize");
    } finally {
      process.stderr.write = originalWrite;
    }
  });
});

const CLOUD_SPEC: NonNullable<ShipInput["cloud"]> = {
  repos: [{ url: "https://github.com/owner/repo" }],
};

describe("ShipService.ship — runtime routing", () => {
  test("runtime: cloud uses cloudCursor.run; local runner not called", async () => {
    const h = await createHarness();
    h.cloudCursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    const out = await h.service.ship({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
      runtime: "cloud",
      cloud: CLOUD_SPEC,
    });
    expect(h.cloudCursor.calls).toHaveLength(1);
    expect(h.cursor.calls).toHaveLength(0);
    expect(out.cursorRun.runtime).toBe("cloud");
    expect(h.store.getCursorRun(out.cursorRun.id)?.runtime).toBe("cloud");
    h.store.close();
  });

  test('runtime: "local" uses cursor.run; cloud runner not called', async () => {
    const h = await createHarness();
    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    const out = await h.service.ship({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
      runtime: "local",
    });
    expect(h.cursor.calls).toHaveLength(1);
    expect(h.cloudCursor.calls).toHaveLength(0);
    expect(out.cursorRun.runtime).toBe("local");
    h.store.close();
  });

  test("runtime omitted uses cursor.run (default local)", async () => {
    const h = await createHarness();
    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    const out = await h.service.ship({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
    });
    expect(h.cursor.calls).toHaveLength(1);
    expect(h.cloudCursor.calls).toHaveLength(0);
    expect(out.cursorRun.runtime).toBe("local");
    h.store.close();
  });

  test("runtime cloud without cloudCursor throws before any persistence", async () => {
    const h = await createHarness({ omitCloudCursor: true });
    expect(() => {
      void h.service.ship({
        workdir: WORKDIR,
        repo: "ship",
        docPath: "docs.md",
        runtime: "cloud",
        cloud: CLOUD_SPEC,
      });
    }).toThrow(CloudRunnerNotConfiguredError);
    expect(h.store.listRuns({ limit: 10 })).toHaveLength(0);
    h.store.close();
  });
});

describe("ShipService.getRun + listRuns", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(() => {
    h.store.close();
  });

  test("getRun forwards to store.getRun; null for unknown ids", async () => {
    expect(await h.service.getRun("wf_unknown")).toBeNull();
  });

  test("listRuns forwards to store.listRuns; respects filters", async () => {
    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    const out = await h.service.ship({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
    });

    const all = await h.service.listRuns({ limit: 10 });
    expect(all.map((r) => r.id)).toContain(out.workflowRunId);

    const filtered = await h.service.listRuns({ repo: "ship", limit: 10 });
    expect(filtered.map((r) => r.id)).toContain(out.workflowRunId);

    const otherRepo = await h.service.listRuns({ repo: "elsewhere", limit: 10 });
    expect(otherRepo).toHaveLength(0);
  });
});

/**
 * Unit tests for `ShipService` — workdir/doc validation, the four
 * methods, the state machine. Backed by a real `@ship/store`
 * (:memory:), the in-memory `ShipFs`, and `FakeCursorRunner`.
 */

import type { Store } from "@ship/store";

import { FakeCursorRunner } from "@ship/cursor-runner/test/fake";
import { createStore } from "@ship/store";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { DocNotFoundError, WorkdirNotFoundError } from "./errors.js";
import { createMemoryShipFs, type MemoryShipFs } from "./fs/memory.js";
import { createShipService, type ShipService, type ShipServiceConfig } from "./service.js";

const RUNS_DIR = "/state/runs";
const WORKDIR = "/work/wt/feat";

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
  cursor: FakeCursorRunner;
  config: ShipServiceConfig;
}

async function createHarness(opts?: { defaultModelId?: string }): Promise<Harness> {
  const fs = createMemoryShipFs();
  await fs.mkdir(RUNS_DIR, { recursive: true });
  await fs.mkdir(WORKDIR, { recursive: true });
  await fs.writeFile(`${WORKDIR}/docs.md`, "# Task\n\nDo the thing.");

  const store = createStore({
    dbPath: ":memory:",
    clock: deterministicClock("2026-05-09T00:00:00.000Z"),
  });
  const cursor = new FakeCursorRunner();
  const config: ShipServiceConfig = {
    runsDir: RUNS_DIR,
    defaultModel: { id: opts?.defaultModelId ?? "composer-2" },
  };

  const service = createShipService({
    store,
    cursor,
    fs,
    clock: deterministicClock("2026-05-09T00:00:00.000Z", 1000),
    config,
    ids: deterministicIds(),
  });

  return { service, fs, store, cursor, config };
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
      cursor,
      fs,
      clock: deterministicClock("2026-05-09T00:00:00.000Z", 1000),
      config: {
        runsDir: RUNS_DIR,
        defaultModel: { id: "composer-2" },
        mcpServers: { foo: { type: "stdio" as const, command: "/bin/foo" } },
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

  test("uses config.defaultModel when input.model is omitted", async () => {
    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });

    await h.service.ship({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
    });

    expect(h.cursor.calls[0]?.input.model).toEqual({ id: "composer-2" });
  });

  test("uses input.model when provided", async () => {
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

    expect(h.cursor.calls[0]?.input.model).toEqual({ id: "composer-2-thinking" });
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

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
import {
  agentWatchUrl,
  CLOUD_WORKTREE_SENTINEL,
  DEFAULT_WORKFLOW_POLICY,
  isTerminal,
} from "@ship/workflow";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { DocSource } from "./doc-source/doc-source.js";

import { ORPHAN_RESUME_STALENESS_MS } from "./cursor-runs/orphan-resume.js";
import {
  CloudRunnerNotConfiguredError,
  DocNotFoundError,
  DocPathEscapesWorkdirError,
  MissingRepoError,
  RoomRunnerNotConfiguredError,
  WorkdirNotFoundError,
} from "./errors.js";
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
  roomCursor: FakeCursorRunner;
  config: ShipServiceConfig;
}

interface HarnessOpts {
  defaultModelId?: string;
  defaultModelParams?: { id: string; value: string }[];
  omitCloudCursor?: boolean;
  omitRoomCursor?: boolean;
  docSource?: DocSource;
}

function makeHarnessConfig(
  opts: HarnessOpts | undefined,
  runners: {
    cursor: FakeCursorRunner;
    cloudCursor: FakeCursorRunner;
    roomCursor: FakeCursorRunner;
  },
): ShipServiceConfig {
  return {
    runsDir: RUNS_DIR,
    defaultModel: {
      id: opts?.defaultModelId ?? "composer-2.5",
      params: opts?.defaultModelParams ?? [{ id: "fast", value: "true" }],
    },
    cursor: runners.cursor,
    ...(opts?.omitCloudCursor ? {} : { cloudCursor: runners.cloudCursor }),
    ...(opts?.omitRoomCursor ? {} : { roomCursor: runners.roomCursor }),
  };
}

async function createHarness(opts?: HarnessOpts): Promise<Harness> {
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
  const roomCursor = new FakeCursorRunner();
  const config = makeHarnessConfig(opts, { cursor, cloudCursor, roomCursor });

  const service = createShipService({
    store,
    fs,
    clock: deterministicClock("2026-05-09T00:00:00.000Z", 1000),
    config,
    ids: deterministicIds(),
    ...(opts?.docSource !== undefined ? { docSource: opts.docSource } : {}),
  });

  return { service, fs, store, cursor, cloudCursor, roomCursor, config };
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

  test("local succeeded run removes the worktree scratch task-doc afterward", async () => {
    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });

    const scratchPath = `${WORKDIR}/task-doc.md`;
    await h.service.ship({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
    });

    await expect(h.fs.stat(scratchPath)).rejects.toThrow();
    expect(h.fs.snapshot().files.has(scratchPath)).toBe(false);
  });

  test("local failed run also removes the worktree scratch task-doc", async () => {
    h.cursor.enqueue({
      events: [],
      result: { status: "failed", durationMs: 0, branches: [] },
    });

    const scratchPath = `${WORKDIR}/task-doc.md`;
    await h.service.ship({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
    });

    expect(h.fs.snapshot().files.has(scratchPath)).toBe(false);
  });

  test("pre-existing file at the scratch path is never overwritten or deleted", async () => {
    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });

    const scratchPath = `${WORKDIR}/task-doc.md`;
    await h.fs.writeFile(scratchPath, "user-owned content — not ship's scratch");
    await h.service.ship({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
    });

    expect(await h.fs.readFile(scratchPath, "utf-8")).toBe(
      "user-owned content — not ship's scratch",
    );
  });

  test("docPath that IS the scratch path survives the run", async () => {
    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });

    const docAtScratch = `${WORKDIR}/task-doc.md`;
    await h.fs.writeFile(docAtScratch, "# the user's actual task doc");
    await h.service.ship({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "task-doc.md",
    });

    expect(await h.fs.readFile(docAtScratch, "utf-8")).toBe("# the user's actual task doc");
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

// Builds the canonical 3-level Error.cause chain used by the
// failure-mapping cause-chain test. Extracted so the test body stays
// under the complexity cap.
function buildThreeLevelChain(): Error {
  const sdkErr = Object.assign(new Error("[validation_error] Expected string, received boolean"), {
    name: "ConfigurationError",
    code: "validation_error",
    status: 400,
    endpoint: "POST /v1/agents",
  });
  const wrapper = new Error("agent.send failed after Agent.create", { cause: sdkErr });
  return new Error("ship dispatch failed", { cause: wrapper });
}

// Parsed shape of `result.json`'s failure-side payload.
interface ParsedResult {
  status: string;
  errorMessage: string;
  errorChain: { name: string; message: string; extra?: Record<string, unknown> }[];
}

async function readResultJson(fs: MemoryShipFs, path: string): Promise<ParsedResult> {
  const raw = await fs.readFile(path, "utf-8");
  return JSON.parse(raw) as ParsedResult;
}

describe("ShipService.ship — failure mapping", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(() => {
    h.store.close();
  });

  test("cursor result.status: failed → workflow row failed; errorMessage classified", async () => {
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
    expect(row?.phases[0]?.failureCategory).toBe("unknown");
    expect(row?.phases[0]?.errorMessage).toBe("unknown; model rejected the task");
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
    expect(row?.phases[0]?.errorMessage).toMatch(/^sdk-throw; /);
    expect(row?.phases[0]?.errorMessage).toMatch(/no script enqueued/i);
    expect(row?.phases[0]?.failureCategory).toBe("sdk-throw");
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
    expect(row?.phases[0]?.errorMessage).toMatch(/^sdk-throw; /);
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
    // ArtifactWriteFailedError is ship-internal, not an SDK reject → unknown.
    expect(row?.phases[0]?.errorMessage).toMatch(/^unknown; /);
    expect(row?.phases[0]?.errorMessage).toMatch(/persist run artifacts|ENOSPC/);
  });

  test("multi-level Error.cause chain serializes into errorMessage and result.json errorChain", async () => {
    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });

    // Build a 3-level chain: top wraps a CursorRunFailedError-like wrapper
    // which wraps the underlying SDK error. Each level has its own
    // distinguishable message + the SDK-style "extra" fields on the deepest.
    const top = buildThreeLevelChain();

    const origWriteFile = h.fs.writeFile.bind(h.fs);
    h.fs.writeFile = (path: string, data: string): Promise<void> => {
      if (path.endsWith("prompt.md")) return Promise.reject(top);
      return origWriteFile(path, data);
    };

    const out = await h.service.ship({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
    });

    expect(out.status).toBe("failed");
    const row = h.store.getRun(out.workflowRunId);
    // Classified errorMessage uses sdk-throw; forensic chain stays in result.json.
    const msg = row?.phases[0]?.errorMessage ?? "";
    expect(msg).toMatch(/^sdk-throw; /);
    expect(msg).toContain("ship dispatch failed");
    expect(row?.phases[0]?.failureCategory).toBe("sdk-throw");

    // Structured chain in result.json: each level preserved with name +
    // message + SDK-side extras (status, code, endpoint).
    const parsed = await readResultJson(h.fs, out.artifacts.resultPath);
    expect(parsed.errorChain.length).toBe(3);
    expect(parsed.errorChain[0]?.message).toBe("ship dispatch failed");
    expect(parsed.errorChain[1]?.message).toBe("agent.send failed after Agent.create");
    expect(parsed.errorChain[2]?.name).toBe("ConfigurationError");
    expect(parsed.errorChain[2]?.extra).toMatchObject({
      code: "validation_error",
      status: 400,
      endpoint: "POST /v1/agents",
    });
  });

  test("non-enumerable own properties on SDK errors surface in errorChain.extra", async () => {
    // Simulates an SDK that defines its extras as non-enumerable class
    // fields (e.g. `Object.defineProperty(this, "status", { enumerable: false, value: ... })`).
    // `Object.keys` would miss these; `Object.getOwnPropertyNames` catches
    // them. This test would have failed against the prior implementation.
    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });

    const sdkErr = new Error("hidden-field error");
    Object.defineProperty(sdkErr, "status", { value: 503, enumerable: false });
    Object.defineProperty(sdkErr, "code", { value: "upstream_unavailable", enumerable: false });

    const origWriteFile = h.fs.writeFile.bind(h.fs);
    h.fs.writeFile = (path: string, data: string): Promise<void> => {
      if (path.endsWith("prompt.md")) return Promise.reject(sdkErr);
      return origWriteFile(path, data);
    };

    const out = await h.service.ship({ workdir: WORKDIR, repo: "ship", docPath: "docs.md" });
    expect(out.status).toBe("failed");

    const parsed = await readResultJson(h.fs, out.artifacts.resultPath);
    expect(parsed.errorChain.length).toBe(1);
    expect(parsed.errorChain[0]?.extra).toMatchObject({
      status: 503,
      code: "upstream_unavailable",
    });
  });

  test("result.json survives JSON-hostile extras (BigInt + circular ref)", async () => {
    // SDK errors occasionally carry BigInt (e.g. `Content-Length` from
    // a header) or circular refs (response object referencing request).
    // A naive `JSON.stringify` throws on either — the
    // `tryWriteFailureResult` catch would then silently drop the ENTIRE
    // `result.json`. Verify the safe-stringify keeps the artifact and
    // swaps in sentinel strings for the hostile values.
    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });

    const sdkErr = new Error("hostile extras error");
    Object.assign(sdkErr, {
      bigField: BigInt("9007199254740993"),
      selfRef: {} as Record<string, unknown>,
    });
    // Wire the circular reference: extra.selfRef points back at the
    // top-level extras object via err itself.
    (sdkErr as unknown as { selfRef: Record<string, unknown> }).selfRef["back"] = sdkErr;

    const origWriteFile = h.fs.writeFile.bind(h.fs);
    h.fs.writeFile = (path: string, data: string): Promise<void> => {
      if (path.endsWith("prompt.md")) return Promise.reject(sdkErr);
      return origWriteFile(path, data);
    };

    const out = await h.service.ship({ workdir: WORKDIR, repo: "ship", docPath: "docs.md" });
    expect(out.status).toBe("failed");

    const parsed = await readResultJson(h.fs, out.artifacts.resultPath);
    expect(parsed.status).toBe("failed");
    expect(parsed.errorMessage).toMatch(/^sdk-throw; /);
    expect(parsed.errorMessage).toContain("hostile extras error");
    expect(parsed.errorChain.length).toBeGreaterThanOrEqual(1);
    const extra = parsed.errorChain[0]?.extra ?? {};
    // BigInt → tagged-string form.
    expect(extra["bigField"]).toBe("9007199254740993n");
    // The selfRef → back → err cycle should be cut by the replacer. The
    // first occurrence of err's `selfRef` is fine; the recursive visit
    // through `back.selfRef` hits the WeakSet and becomes "[Circular]".
    const selfRef = extra["selfRef"] as { back?: { selfRef?: unknown } } | undefined;
    expect(selfRef?.back?.selfRef).toBe("[Circular]");
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
    expect(terminal.phases[0]?.errorMessage).toMatch(/^sdk-throw; /);
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

const ROOM_SPEC: NonNullable<ShipInput["room"]> = {
  repos: [{ url: "https://github.com/itsHabib/roxiq" }],
};

describe("ShipService.ship — rooms routing (L2)", () => {
  test("runtime: rooms uses roomCursor.run; local + cloud runners untouched", async () => {
    const h = await createHarness();
    h.roomCursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    const out = await h.service.ship({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
      runtime: "rooms",
      room: ROOM_SPEC,
    });
    expect(h.roomCursor.calls).toHaveLength(1);
    expect(h.cursor.calls).toHaveLength(0);
    expect(h.cloudCursor.calls).toHaveLength(0);
    expect(out.cursorRun.runtime).toBe("rooms");
    expect(h.store.getCursorRun(out.cursorRun.id)?.runtime).toBe("rooms");
    h.store.close();
  });

  test("rooms run forwards runtime + room spec to the runner", async () => {
    const h = await createHarness();
    h.roomCursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    await h.service.ship({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
      runtime: "rooms",
      room: { repos: [{ url: "https://github.com/itsHabib/roxiq", startingRef: "main" }] },
    });
    const input = h.roomCursor.calls[0]?.input;
    expect(input?.runtime).toBe("rooms");
    expect(input?.room?.repos[0]?.url).toBe("https://github.com/itsHabib/roxiq");
    expect(input?.room?.repos[0]?.startingRef).toBe("main");
    h.store.close();
  });

  test("rooms branches[0].branch surfaces via get_workflow_run", async () => {
    const h = await createHarness();
    h.roomCursor.enqueue({
      events: [],
      result: {
        status: "succeeded",
        durationMs: 30_000,
        branches: [
          { repoUrl: "https://github.com/itsHabib/roxiq", branch: "rooms/ship-x-abcd1234" },
        ],
      },
    });
    const out = await h.service.ship({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
      runtime: "rooms",
      room: ROOM_SPEC,
    });
    const view = await h.service.getRun(out.workflowRunId);
    expect(view?.branches?.[0]?.branch).toBe("rooms/ship-x-abcd1234");
    expect(view?.branches?.[0]?.repoUrl).toBe("https://github.com/itsHabib/roxiq");
    h.store.close();
  });

  test("rooms without workdir: synthetic worktree + repo auto-derived from room URL", async () => {
    const h = await createHarness();
    await h.fs.mkdir("/external", { recursive: true });
    await h.fs.writeFile("/external/task.md", "# External rooms task\n");
    h.roomCursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    const out = await h.service.ship({
      docPath: "/external/task.md",
      runtime: "rooms",
      room: { repos: [{ url: "https://github.com/itsHabib/roxiq" }] },
    });
    expect(out.status).toBe("succeeded");
    expect(out.worktree.path).toBe(CLOUD_WORKTREE_SENTINEL);
    expect(h.store.getRun(out.workflowRunId)?.repo).toBe("itsHabib/roxiq");
    expect(h.roomCursor.calls).toHaveLength(1);
    h.store.close();
  });

  test("runtime rooms without roomCursor throws before any persistence", async () => {
    const h = await createHarness({ omitRoomCursor: true });
    expect(() => {
      void h.service.ship({
        workdir: WORKDIR,
        repo: "ship",
        docPath: "docs.md",
        runtime: "rooms",
        room: ROOM_SPEC,
      });
    }).toThrow(RoomRunnerNotConfiguredError);
    expect(h.store.listRuns({ limit: 10 })).toHaveLength(0);
    h.store.close();
  });

  test("rooms run derives repo from room URL, ignoring a stray cloud field", async () => {
    const h = await createHarness();
    await h.fs.mkdir("/external", { recursive: true });
    await h.fs.writeFile("/external/task.md", "# t\n");
    h.roomCursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    const out = await h.service.ship({
      docPath: "/external/task.md",
      runtime: "rooms",
      room: { repos: [{ url: "https://github.com/itsHabib/roxiq" }] },
      // A stray cloud field must NOT redirect repo derivation / doc resolution.
      cloud: { repos: [{ url: "https://github.com/itsHabib/wrong-repo" }] },
    });
    expect(h.store.getRun(out.workflowRunId)?.repo).toBe("itsHabib/roxiq");
    expect(h.roomCursor.calls).toHaveLength(1);
    h.store.close();
  });
});

describe("ShipService.ship — cloud parity", () => {
  test("cloud without workdir: synthetic worktree + repo auto-derived", async () => {
    const h = await createHarness();
    await h.fs.mkdir("/external", { recursive: true });
    await h.fs.writeFile("/external/task.md", "# External cloud task\n");
    h.cloudCursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });

    const out = await h.service.ship({
      docPath: "/external/task.md",
      runtime: "cloud",
      cloud: { repos: [{ url: "https://github.com/itsHabib/roxiq" }] },
    });

    expect(out.status).toBe("succeeded");
    expect(out.worktree.path).toBe(CLOUD_WORKTREE_SENTINEL);
    expect(out.worktree.name).toBe(CLOUD_WORKTREE_SENTINEL);
    expect(out.worktree.branch).toBe(CLOUD_WORKTREE_SENTINEL);
    const row = h.store.getRun(out.workflowRunId);
    expect(row?.repo).toBe("itsHabib/roxiq");
    expect(h.cloudCursor.calls).toHaveLength(1);
    h.store.close();
  });

  test("cloud docPath outside workdir succeeds; local docPath outside workdir fails", async () => {
    const h = await createHarness();
    await h.fs.mkdir("/outside", { recursive: true });
    await h.fs.writeFile("/outside/doc.md", "# Outside\n");
    h.cloudCursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });

    const cloudOut = await h.service.ship({
      workdir: WORKDIR,
      docPath: "/outside/doc.md",
      runtime: "cloud",
      cloud: CLOUD_SPEC,
    });
    expect(cloudOut.status).toBe("succeeded");

    await expect(
      h.service.ship({ workdir: WORKDIR, repo: "ship", docPath: "/outside/doc.md" }),
    ).rejects.toBeInstanceOf(DocPathEscapesWorkdirError);
    h.store.close();
  });

  test("cloud run fetches remote doc when local file missing", async () => {
    const remoteContent = "# Remote task\n\nFrom GitHub.\n";
    const docSource: DocSource = {
      resolveRef: () => Promise.resolve("main"),
      fetch: () => Promise.resolve(remoteContent),
    };
    const h = await createHarness({ docSource });
    h.cloudCursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });

    const out = await h.service.ship({
      docPath: "docs/remote-task.md",
      runtime: "cloud",
      cloud: CLOUD_SPEC,
    });
    expect(out.status).toBe("succeeded");
    const taskDoc = await h.fs.readFile(`${RUNS_DIR}/${out.workflowRunId}/task-doc.md`, "utf-8");
    expect(taskDoc).toBe(remoteContent);
    h.store.close();
  });

  test("explicit repo wins over cloud URL auto-derive", async () => {
    const h = await createHarness();
    await h.fs.mkdir("/external", { recursive: true });
    await h.fs.writeFile("/external/task.md", "# Task\n");
    h.cloudCursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });

    const out = await h.service.ship({
      docPath: "/external/task.md",
      repo: "explicit/label",
      runtime: "cloud",
      cloud: { repos: [{ url: "https://github.com/itsHabib/roxiq" }] },
    });
    expect(h.store.getRun(out.workflowRunId)?.repo).toBe("explicit/label");
    h.store.close();
  });

  test("unparseable cloud URL without repo → MissingRepoError", async () => {
    const h = await createHarness();
    await h.fs.mkdir("/external", { recursive: true });
    await h.fs.writeFile("/external/task.md", "# Task\n");

    await expect(
      h.service.ship({
        docPath: "/external/task.md",
        runtime: "cloud",
        cloud: { repos: [{ url: "not-a-url" }] },
      }),
    ).rejects.toBeInstanceOf(MissingRepoError);
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

describe("ShipService.getRun — failure diagnostics enrichment", () => {
  test("failed run exposes duration cap, SDK terminal status, and recent events", async () => {
    const h = await createHarness();
    const statusEv = { type: "status", status: "ERROR", run_id: "r1" };
    const toolEv = {
      type: "tool_call",
      status: "error",
      result: "database is locked",
      name: "shell",
    };
    h.cursor.enqueue({
      events: [statusEv, toolEv] as never[],
      result: {
        status: "failed",
        durationMs: 27 * 60 * 1000,
        errorMessage:
          "SDK status ERROR after 27m (cap 30m); last tool_call errored: database is locked",
        sdkTerminalStatus: "ERROR",
        branches: [],
      },
    });
    const out = await h.service.ship({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
    });
    expect(out.status).toBe("failed");
    const view = await h.service.getRun(out.workflowRunId);
    expect(view?.runDurationMs).toBe(27 * 60 * 1000);
    expect(view?.maxRunDurationMs).toBe(DEFAULT_WORKFLOW_POLICY.maxRunDurationMs);
    expect(view?.sdkTerminalStatus).toBe("ERROR");
    expect(view?.recentEvents?.length).toBeGreaterThanOrEqual(2);
    h.store.close();
  });

  test("failed run hoists failureCategory from the implement phase row", async () => {
    const h = await createHarness();
    h.cursor.enqueue({
      events: [{ type: "tool_call", status: "error", result: "make check failed" }] as never[],
      result: {
        status: "failed",
        durationMs: 1000,
        errorMessage: "logic; make check failed",
        branches: [],
      },
    });
    const out = await h.service.ship({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
    });
    const stored = h.store.getRun(out.workflowRunId);
    expect(stored?.phases[0]?.failureCategory).toBe("logic");
    const view = await h.service.getRun(out.workflowRunId);
    expect(view?.failureCategory).toBe("logic");
    expect(view?.failureCategory).toBe(stored?.phases[0]?.failureCategory);
    h.store.close();
  });

  test("succeeded and cancelled runs omit top-level failureCategory", async () => {
    const h = await createHarness();
    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    const succeeded = await h.service.ship({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
    });
    expect((await h.service.getRun(succeeded.workflowRunId))?.failureCategory).toBeUndefined();

    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    const start = await h.service.startShip({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
    });
    await h.service.cancelRun(start.workflowRunId);
    await h.service.drainBackground();
    expect((await h.service.getRun(start.workflowRunId))?.failureCategory).toBeUndefined();
    h.store.close();
  });
});

describe("ShipService.getRun — cloud watchUrl enrichment", () => {
  test("cloud run with cursor row exposes agentId, provider, cursorAgentId and watchUrl", async () => {
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
      cloud: { repos: [{ url: "https://github.com/owner/repo" }] },
    });
    const row = await h.service.getRun(out.workflowRunId);
    expect(row?.agentId).toBe("agent-fake-0001");
    expect(row?.provider).toBe("cursor");
    expect(row?.cursorAgentId).toBe("agent-fake-0001");
    expect(row?.watchUrl).toBe(agentWatchUrl("cursor", "agent-fake-0001"));
    h.store.close();
  });

  test("local run omits agentId, provider, cursorAgentId and watchUrl", async () => {
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
    const row = await h.service.getRun(out.workflowRunId);
    expect(row).not.toHaveProperty("agentId");
    expect(row).not.toHaveProperty("provider");
    expect(row).not.toHaveProperty("cursorAgentId");
    expect(row).not.toHaveProperty("watchUrl");
    h.store.close();
  });

  test("cloud run before cursor row is linked omits watch fields", async () => {
    const h = await createHarness();
    const wfId = "wf_00000000000000000000000001";
    const phaseId = "ph_00000000000000000000000001";
    h.store.createWorkflowRun({
      baseRef: "main",
      docPath: "docs.md",
      id: wfId,
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
      inputJson: JSON.stringify({ docPath: "docs.md" }),
      kind: "implement",
      workflowRunId: wfId,
    });
    h.store.markRunStarted(wfId, phaseId, "2026-05-09T00:00:00.000Z");
    const row = await h.service.getRun(wfId);
    expect(row).not.toHaveProperty("agentId");
    expect(row).not.toHaveProperty("provider");
    expect(row).not.toHaveProperty("cursorAgentId");
    expect(row).not.toHaveProperty("watchUrl");
    h.store.close();
  });
});

const CLOUD_RESUME_SPEC: NonNullable<ShipInput["cloud"]> = {
  repos: [{ url: "https://github.com/owner/repo" }],
};

async function seedOrphanedCloudRun(
  h: Harness,
  opts: {
    workflowRunId: string;
    phaseId: string;
    cursorRunId: string;
    agentId?: string;
    runId?: string;
  },
): Promise<void> {
  h.store.createWorkflowRun({
    baseRef: "main",
    docPath: "docs.md",
    id: opts.workflowRunId,
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
    id: opts.phaseId,
    inputJson: JSON.stringify({ cloud: CLOUD_RESUME_SPEC, docPath: "docs.md" }),
    kind: "implement",
    workflowRunId: opts.workflowRunId,
  });
  h.store.markRunStarted(opts.workflowRunId, opts.phaseId, "2026-05-09T00:00:00.000Z");
  h.store.updatePhase(opts.phaseId, { cursorRunId: opts.cursorRunId, status: "running" });
  h.store.recordCursorRun({
    agentId: opts.agentId ?? "bc-resume-0001",
    artifactsDir: `${RUNS_DIR}/${opts.workflowRunId}`,
    id: opts.cursorRunId,
    model: { id: "composer-2.5" },
    runId: opts.runId ?? "run-resume-0001",
    runtime: "cloud",
    workflowRunId: opts.workflowRunId,
  });
  await h.fs.mkdir(`${RUNS_DIR}/${opts.workflowRunId}`, { recursive: true });
}

describe("ShipService.resumeOrphanedRuns", () => {
  test("attaches once per orphaned cloud row and finalizes succeeded", async () => {
    const fs = createMemoryShipFs();
    await fs.mkdir(RUNS_DIR, { recursive: true });
    const store = createStore({
      clock: deterministicClock("2026-05-09T00:00:00.000Z"),
      dbPath: ":memory:",
    });
    const cloudCursor = new FakeCursorRunner();
    cloudCursor.enqueueAttach({
      events: [],
      result: { status: "succeeded", durationMs: 100, branches: [], summary: "resumed ok" },
    });

    await seedOrphanedCloudRun(
      {
        cloudCursor,
        config: null as never,
        cursor: null as never,
        fs,
        roomCursor: null as never,
        service: null as never,
        store,
      },
      {
        cursorRunId: "cr_00000000000000000000000001",
        phaseId: "ph_00000000000000000000000001",
        workflowRunId: "wf_00000000000000000000000001",
      },
    );

    const service = createShipService({
      clock: deterministicClock("2026-05-09T00:06:00.000Z", 1000),
      config: {
        cloudCursor,
        cursor: new FakeCursorRunner(),
        defaultModel: { id: "composer-2.5" },
        runsDir: RUNS_DIR,
      },
      fs,
      resumeOrphans: true,
      store,
      ids: deterministicIds(),
    });

    await service.drainBackground();
    await service.resumeReady();
    const row = await waitForRunTerminal(service, "wf_00000000000000000000000001");
    expect(row.status).toBe("succeeded");
    expect(cloudCursor.attachCalls).toHaveLength(1);
    expect(cloudCursor.attachCalls[0]?.input).toMatchObject({
      agentId: "bc-resume-0001",
      runId: "run-resume-0001",
    });

    await service.resumeOrphanedRuns();
    expect(cloudCursor.attachCalls).toHaveLength(1);
    store.close();
  });

  test("agent-gone on a stale row terminalizes the run", async () => {
    // A not-found agent can never produce a result; leaving the row
    // running would strand it until a manual cancelRun. The staleness
    // guard already keeps live sibling runs out of the attach path, so
    // not-found here is proof of a dead run, not a race.
    const fs = createMemoryShipFs();
    await fs.mkdir(RUNS_DIR, { recursive: true });
    const store = createStore({
      clock: deterministicClock("2026-05-09T00:00:00.000Z"),
      dbPath: ":memory:",
    });
    const cloudCursor = new FakeCursorRunner();
    cloudCursor.enqueueAttach({ notFound: true });

    await seedOrphanedCloudRun(
      {
        cloudCursor,
        config: null as never,
        cursor: null as never,
        fs,
        roomCursor: null as never,
        service: null as never,
        store,
      },
      {
        cursorRunId: "cr_00000000000000000000000002",
        phaseId: "ph_00000000000000000000000002",
        workflowRunId: "wf_00000000000000000000000002",
      },
    );

    const service = createShipService({
      clock: deterministicClock("2026-05-09T00:06:00.000Z", 1000),
      config: {
        cloudCursor,
        cursor: new FakeCursorRunner(),
        defaultModel: { id: "composer-2.5" },
        runsDir: RUNS_DIR,
      },
      fs,
      resumeOrphans: true,
      store,
      ids: deterministicIds(),
    });

    await service.drainBackground();
    await service.resumeReady();
    const row = await service.getRun("wf_00000000000000000000000002");
    expect(row?.status).toBe("failed");
    expect(row?.phases[0]?.errorMessage).toMatch(/no longer reachable/);
    expect(cloudCursor.attachCalls).toHaveLength(1);
    store.close();
  });

  test("transient attach failure leaves row running and logs error", async () => {
    const fs = createMemoryShipFs();
    await fs.mkdir(RUNS_DIR, { recursive: true });
    const store = createStore({
      clock: deterministicClock("2026-05-09T00:00:00.000Z"),
      dbPath: ":memory:",
    });
    const cloudCursor = new FakeCursorRunner();
    // Errors the classification can't prove terminal (auth, network) must
    // not touch the row — a later sweep retries once the cause clears.
    const flakyCloud: typeof cloudCursor = Object.assign(Object.create(cloudCursor) as never, {
      attach: () => Promise.reject(new Error("transient: socket hang up")),
    });

    await seedOrphanedCloudRun(
      {
        cloudCursor,
        config: null as never,
        cursor: null as never,
        fs,
        roomCursor: null as never,
        service: null as never,
        store,
      },
      {
        cursorRunId: "cr_00000000000000000000000010",
        phaseId: "ph_00000000000000000000000010",
        workflowRunId: "wf_00000000000000000000000010",
      },
    );

    const service = createShipService({
      clock: deterministicClock("2026-05-09T00:06:00.000Z", 1000),
      config: {
        cloudCursor: flakyCloud,
        cursor: new FakeCursorRunner(),
        defaultModel: { id: "composer-2.5" },
        runsDir: RUNS_DIR,
      },
      fs,
      resumeOrphans: true,
      store,
      ids: deterministicIds(),
    });

    await service.drainBackground();
    await service.resumeReady();
    const row = await service.getRun("wf_00000000000000000000000010");
    expect(row?.status).toBe("running");
    expect(store.getCursorRun("cr_00000000000000000000000010")?.status).toBe("running");
    store.close();
  });

  test("no cloudCursor configured is a no-op", async () => {
    const h = await createHarness({ omitCloudCursor: true });
    await seedOrphanedCloudRun(h, {
      cursorRunId: "cr_00000000000000000000000003",
      phaseId: "ph_00000000000000000000000003",
      workflowRunId: "wf_00000000000000000000000003",
    });
    await h.service.resumeOrphanedRuns();
    expect(h.cloudCursor.attachCalls).toHaveLength(0);
    h.store.close();
  });

  test("skips attach + finalizes cursor row when workflow already terminal", async () => {
    // P1 from cycle-1 review (codex): cancelRun updates workflow + phase
    // but leaves cursor_runs marked running. On restart, resumeOrphanedRuns
    // must NOT revive a cancelled workflow — that overrides the user's
    // cancel intent and continues cloud-side mutations/cost.
    const fs = createMemoryShipFs();
    await fs.mkdir(RUNS_DIR, { recursive: true });
    const store = createStore({
      clock: deterministicClock("2026-05-09T00:00:00.000Z"),
      dbPath: ":memory:",
    });
    const cloudCursor = new FakeCursorRunner();
    // No attach script enqueued. If the code attempts attach, the fake
    // throws (loud-fail per FakeCursorRunner contract) — assertion below
    // also defends.

    await seedOrphanedCloudRun(
      {
        cloudCursor,
        config: null as never,
        cursor: null as never,
        fs,
        roomCursor: null as never,
        service: null as never,
        store,
      },
      {
        cursorRunId: "cr_00000000000000000000000004",
        phaseId: "ph_00000000000000000000000004",
        workflowRunId: "wf_00000000000000000000000004",
      },
    );
    // Workflow was cancelled before the crash; cursor_run row is the
    // stale revivor.
    store.updateWorkflowRunStatus("wf_00000000000000000000000004", "cancelled");

    const service = createShipService({
      clock: deterministicClock("2026-05-09T00:06:00.000Z", 1000),
      config: {
        cloudCursor,
        cursor: new FakeCursorRunner(),
        defaultModel: { id: "composer-2.5" },
        runsDir: RUNS_DIR,
      },
      fs,
      resumeOrphans: true,
      store,
      ids: deterministicIds(),
    });

    await service.drainBackground();
    await service.resumeReady();

    // No attach attempted — user's cancel intent preserved.
    expect(cloudCursor.attachCalls).toHaveLength(0);
    // Cursor row closed out to match the workflow's terminal status.
    const cursorRow = store.getCursorRun("cr_00000000000000000000000004");
    expect(cursorRow?.status).toBe("cancelled");
    expect(cursorRow?.endedAt).toBeDefined();
    expect(cursorRow?.durationMs).toBeDefined();
    expect(cursorRow?.durationMs ?? -1).toBeGreaterThanOrEqual(0);

    store.close();
  });

  test("construction without resumeOrphans does not attach sibling-process live runs", async () => {
    const fs = createMemoryShipFs();
    await fs.mkdir(RUNS_DIR, { recursive: true });
    const store = createStore({
      clock: deterministicClock("2026-06-12T12:00:00.000Z"),
      dbPath: ":memory:",
    });
    const cloudCursor = new FakeCursorRunner();
    const workflowRunId = "wf_00000000000000000000000005";

    await seedOrphanedCloudRun(
      {
        cloudCursor,
        config: null as never,
        cursor: null as never,
        fs,
        roomCursor: null as never,
        service: null as never,
        store,
      },
      {
        cursorRunId: "cr_00000000000000000000000005",
        phaseId: "ph_00000000000000000000000005",
        workflowRunId,
      },
    );

    const readOnlyService = createShipService({
      clock: deterministicClock("2026-06-12T12:00:00.000Z", 1000),
      config: {
        cloudCursor,
        cursor: new FakeCursorRunner(),
        defaultModel: { id: "composer-2.5" },
        runsDir: RUNS_DIR,
      },
      fs,
      store,
      ids: deterministicIds(),
    });

    await readOnlyService.drainBackground();
    await readOnlyService.resumeReady();
    expect(cloudCursor.attachCalls).toHaveLength(0);
    expect((await readOnlyService.getRun(workflowRunId))?.status).toBe("running");
    store.close();
  });

  test("resumeOrphans with fresh updatedAt skips attach for sibling live runs", async () => {
    const fs = createMemoryShipFs();
    await fs.mkdir(RUNS_DIR, { recursive: true });
    const store = createStore({
      clock: deterministicClock("2026-06-12T12:00:00.000Z"),
      dbPath: ":memory:",
    });
    const cloudCursor = new FakeCursorRunner();
    const workflowRunId = "wf_00000000000000000000000006";

    await seedOrphanedCloudRun(
      {
        cloudCursor,
        config: null as never,
        cursor: null as never,
        fs,
        roomCursor: null as never,
        service: null as never,
        store,
      },
      {
        cursorRunId: "cr_00000000000000000000000006",
        phaseId: "ph_00000000000000000000000006",
        workflowRunId,
      },
    );

    const mcpBootService = createShipService({
      clock: deterministicClock("2026-06-12T12:00:00.000Z", 1000),
      config: {
        cloudCursor,
        cursor: new FakeCursorRunner(),
        defaultModel: { id: "composer-2.5" },
        runsDir: RUNS_DIR,
      },
      fs,
      resumeOrphans: true,
      store,
      ids: deterministicIds(),
    });

    await mcpBootService.drainBackground();
    await mcpBootService.resumeReady();
    expect(cloudCursor.attachCalls).toHaveLength(0);
    expect((await mcpBootService.getRun(workflowRunId))?.status).toBe("running");
    store.close();
  });

  test("two services on one db: stale row resumes when resumeOrphans is true", async () => {
    const fs = createMemoryShipFs();
    await fs.mkdir(RUNS_DIR, { recursive: true });
    const store = createStore({
      clock: deterministicClock("2026-06-12T12:00:00.000Z"),
      dbPath: ":memory:",
    });
    const cloudCursor = new FakeCursorRunner();
    const workflowRunId = "wf_00000000000000000000000007";

    await seedOrphanedCloudRun(
      {
        cloudCursor,
        config: null as never,
        cursor: null as never,
        fs,
        roomCursor: null as never,
        service: null as never,
        store,
      },
      {
        cursorRunId: "cr_00000000000000000000000007",
        phaseId: "ph_00000000000000000000000007",
        workflowRunId,
      },
    );

    cloudCursor.enqueueAttach({
      events: [],
      result: { status: "succeeded", durationMs: 100, branches: [], summary: "resumed ok" },
    });

    const resumedService = createShipService({
      clock: deterministicClock("2026-06-12T12:06:00.000Z", 1000),
      config: {
        cloudCursor,
        cursor: new FakeCursorRunner(),
        defaultModel: { id: "composer-2.5" },
        runsDir: RUNS_DIR,
      },
      fs,
      resumeOrphans: true,
      store,
      ids: deterministicIds(),
    });

    await resumedService.drainBackground();
    await resumedService.resumeReady();
    const row = await waitForRunTerminal(resumedService, workflowRunId);
    expect(row.status).toBe("succeeded");
    expect(cloudCursor.attachCalls).toHaveLength(1);
    store.close();
  });

  test("fresh-at-boot row is adopted by a later resumeOrphanedRuns sweep once stale", async () => {
    const fs = createMemoryShipFs();
    await fs.mkdir(RUNS_DIR, { recursive: true });
    const store = createStore({
      clock: deterministicClock("2026-06-12T12:00:00.000Z"),
      dbPath: ":memory:",
    });
    const cloudCursor = new FakeCursorRunner();
    const workflowRunId = "wf_00000000000000000000000008";

    await seedOrphanedCloudRun(
      {
        cloudCursor,
        config: null as never,
        cursor: null as never,
        fs,
        roomCursor: null as never,
        service: null as never,
        store,
      },
      {
        cursorRunId: "cr_00000000000000000000000008",
        phaseId: "ph_00000000000000000000000008",
        workflowRunId,
      },
    );

    // Crash-then-fast-restart: the boot sweep sees a fresh heartbeat and
    // must skip; the periodic re-sweep (mcp-server bin cadence) calls
    // resumeOrphanedRuns again after the threshold and must adopt.
    let nowMs = Date.parse("2026-06-12T12:00:30.000Z");
    const service = createShipService({
      clock: () => new Date(nowMs).toISOString(),
      config: {
        cloudCursor,
        cursor: new FakeCursorRunner(),
        defaultModel: { id: "composer-2.5" },
        runsDir: RUNS_DIR,
      },
      fs,
      resumeOrphans: true,
      store,
      ids: deterministicIds(),
    });

    await service.drainBackground();
    await service.resumeReady();
    expect(cloudCursor.attachCalls).toHaveLength(0);

    cloudCursor.enqueueAttach({
      events: [],
      result: { status: "succeeded", durationMs: 100, branches: [], summary: "resumed late" },
    });
    nowMs += ORPHAN_RESUME_STALENESS_MS + 60_000;
    await service.resumeOrphanedRuns();
    await service.drainBackground();

    const row = await waitForRunTerminal(service, workflowRunId);
    expect(row.status).toBe("succeeded");
    expect(cloudCursor.attachCalls).toHaveLength(1);
    store.close();
  });

  test("terminal-parent cursor row reconciles immediately despite a fresh heartbeat", async () => {
    const fs = createMemoryShipFs();
    await fs.mkdir(RUNS_DIR, { recursive: true });
    const store = createStore({
      clock: deterministicClock("2026-06-12T12:00:00.000Z"),
      dbPath: ":memory:",
    });
    const cloudCursor = new FakeCursorRunner();
    const workflowRunId = "wf_00000000000000000000000009";

    await seedOrphanedCloudRun(
      {
        cloudCursor,
        config: null as never,
        cursor: null as never,
        fs,
        roomCursor: null as never,
        service: null as never,
        store,
      },
      {
        cursorRunId: "cr_00000000000000000000000009",
        phaseId: "ph_00000000000000000000000009",
        workflowRunId,
      },
    );

    // A cancel just before boot bumps updated_at (fresh) but leaves the
    // cursor row running. Reconciliation carries no attach risk, so the
    // staleness guard must not apply to it.
    store.cancelRun(workflowRunId);

    const service = createShipService({
      clock: deterministicClock("2026-06-12T12:00:30.000Z", 1000),
      config: {
        cloudCursor,
        cursor: new FakeCursorRunner(),
        defaultModel: { id: "composer-2.5" },
        runsDir: RUNS_DIR,
      },
      fs,
      resumeOrphans: true,
      store,
      ids: deterministicIds(),
    });

    await service.drainBackground();
    await service.resumeReady();
    expect(cloudCursor.attachCalls).toHaveLength(0);
    expect(store.listResumableCloudCursorRuns()).toHaveLength(0);
    expect((await service.getRun(workflowRunId))?.status).toBe("cancelled");
    store.close();
  });
});

/**
 * ShipService observability wiring — list/status parity, batched store reads,
 * and artifact-I/O independence for the shared projection.
 */

import { FakeAgentRunner } from "@ship/agent-runner/test/fake";
import { FakeCursorRunner } from "@ship/cursor-runner/test/fake";
import { createStore, type Store } from "@ship/store";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { ShipFs } from "./fs/shape.js";

import { createMemoryShipFs } from "./fs/memory.js";
import { createShipService, type ShipService, type ShipServiceConfig } from "./service.js";

const RUNS_DIR = "/runs";
const WORKDIR = "/work/wt/feat";

function throwingArtifactShipFs(): ShipFs {
  const inner = createMemoryShipFs();
  return {
    createWriteStream: (...args) => inner.createWriteStream(...args),
    lstat: (...args) => inner.lstat(...args),
    mkdir: (...args) => inner.mkdir(...args),
    readFile: (path, encoding) => {
      if (path.endsWith("result.json") || path.endsWith("events.ndjson")) {
        return Promise.reject(new Error("ShipFs artifact read blocked for observability test"));
      }
      return inner.readFile(path, encoding);
    },
    realpath: (...args) => inner.realpath(...args),
    stat: (...args) => inner.stat(...args),
    unlink: (...args) => inner.unlink(...args),
    writeFile: (...args) => inner.writeFile(...args),
    writeFileBytes: (...args) => inner.writeFileBytes(...args),
  };
}

interface Harness {
  service: ShipService;
  store: Store;
  cursor: FakeCursorRunner;
  cloudCursor: FakeCursorRunner;
}

async function createHarness(fs: ShipFs = createMemoryShipFs()): Promise<Harness> {
  const store = createStore({ clock: () => "2026-05-08T00:00:00.000Z", dbPath: ":memory:" });
  const cursor = new FakeCursorRunner();
  const cloudCursor = new FakeCursorRunner();
  const config: ShipServiceConfig = {
    runsDir: RUNS_DIR,
    defaultModel: { id: "composer-2" },
    cursor,
    cloudCursor,
    roomCursor: new FakeCursorRunner(),
    claude: new FakeAgentRunner(),
    cloudClaude: new FakeAgentRunner(),
    codex: new FakeAgentRunner(),
  };
  const service = createShipService({
    clock: () => "2026-05-08T00:00:00.000Z",
    config,
    fs,
    store,
  });
  await fs.mkdir(WORKDIR, { recursive: true });
  await fs.writeFile(`${WORKDIR}/docs.md`, "# Task\n");
  return { cloudCursor, cursor, service, store };
}

describe("ShipService observability wiring", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 12_000, branches: [] },
    });
  });

  afterEach(() => {
    h.store.close();
  });

  test("list and status return equal observability subviews for the same run", async () => {
    const out = await h.service.ship({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
    });
    const listed = await h.service.listRuns({ limit: 10 });
    const listedRow = listed.find((row) => row.id === out.workflowRunId);
    const statusRow = await h.service.getRun(out.workflowRunId);
    expect(listedRow?.observability).toEqual(statusRow?.observability);
    expect(listedRow?.observability?.actual?.runtime).toBe("local");
    expect(listedRow?.observability?.durationMs).toBe(12_000);
  });

  test("listRuns uses one batched latest-cursor-run lookup for N rows", async () => {
    for (let i = 0; i < 3; i += 1) {
      h.cursor.enqueue({
        events: [],
        result: { status: "succeeded", durationMs: 1, branches: [] },
      });
      await h.service.ship({ workdir: WORKDIR, repo: "ship", docPath: "docs.md" });
    }
    const spy = vi.spyOn(h.store, "listLatestCursorRunsByWorkflowRunIds");
    await h.service.listRuns({ limit: 10 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toHaveLength(3);
    spy.mockRestore();
  });

  test("list observability completes when artifact reads throw (no artifact I/O for projection)", async () => {
    const throwingHarness = await createHarness(throwingArtifactShipFs());
    throwingHarness.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 5, branches: [] },
    });
    const out = await throwingHarness.service.ship({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
    });
    const listed = await throwingHarness.service.listRuns({ limit: 10 });
    const row = listed.find((entry) => entry.id === out.workflowRunId);
    expect(row?.observability?.actual?.runtime).toBe("local");
    throwingHarness.store.close();
  });

  test("status observability is present when legacy artifact diagnostics cannot load", async () => {
    const throwingHarness = await createHarness(throwingArtifactShipFs());
    throwingHarness.cursor.enqueue({
      events: [{ type: "status", status: "ERROR" } as never],
      result: {
        status: "failed",
        durationMs: 1000,
        errorMessage: "boom",
        sdkTerminalStatus: "ERROR",
        branches: [],
      },
    });
    const out = await throwingHarness.service.ship({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
    });
    const view = await throwingHarness.service.getRun(out.workflowRunId);
    expect(view?.observability?.failure?.detail).toBeDefined();
    expect(view?.recentEvents).toBeUndefined();
    throwingHarness.store.close();
  });

  test("cloud run requested runtime is cloud without inferring provider/model from actual", async () => {
    h.store.close();
    const cloudHarness = await createHarness();
    cloudHarness.cloudCursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 9000, branches: [] },
    });
    const out = await cloudHarness.service.ship({
      workdir: WORKDIR,
      repo: "ship",
      docPath: "docs.md",
      runtime: "cloud",
      cloud: { repos: [{ url: "https://github.com/o/r" }] },
    });
    const view = await cloudHarness.service.getRun(out.workflowRunId);
    expect(view?.observability?.requested).toEqual({ runtime: "cloud" });
    expect(view?.observability?.actual?.runtime).toBe("cloud");
    expect(view?.observability?.requested?.provider).toBeUndefined();
    cloudHarness.store.close();
  });
});

/**
 * Property-based state-machine invariants for ShipService.
 */

import type { ShipInput } from "@ship/mcp";
import type { Store } from "@ship/store";
import type { WorkflowStatus } from "@ship/workflow";

import { fc, test } from "@fast-check/vitest";
import { FakeCursorRunner } from "@ship/cursor-runner/test/fake";
import { createStore } from "@ship/store";
import { isTerminal, terminalWorkflowStatusSchema } from "@ship/workflow";
import { afterEach, beforeEach, describe, expect } from "vitest";

import { createMemoryShipFs, type MemoryShipFs } from "./fs/memory.js";
import { createShipService, type ShipService, type ShipServiceConfig } from "./service.js";

function readPositiveIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const ITER = readPositiveIntEnv("SHIP_PROP_ITER", 50);
const PROP_SEED = readPositiveIntEnv("SHIP_PROP_SEED", 0x2fed12f);

fc.configureGlobal({ seed: PROP_SEED });

const RUNS_DIR = "/state/runs";
const WORKDIR = "/work/wt/feat";

interface ParsedFailureResult {
  status: string;
  errorMessage: string;
  errorChain: { name: string; message: string }[];
}

interface Harness {
  service: ShipService;
  fs: MemoryShipFs;
  store: Store;
  cursor: FakeCursorRunner;
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

async function createHarness(): Promise<Harness> {
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
    defaultModel: {
      id: "composer-2.5",
      params: [{ id: "fast", value: "true" }],
    },
    cursor,
    cloudCursor: new FakeCursorRunner(),
  };

  const service = createShipService({
    store,
    fs,
    clock: deterministicClock("2026-05-09T00:00:00.000Z", 1000),
    config,
    ids: deterministicIds(),
  });

  return { service, fs, store, cursor };
}

function buildErrorChain(depth: number): Error {
  let err = new Error(`level-${String(depth)}`);
  for (let i = depth - 1; i >= 0; i -= 1) {
    err = new Error(`level-${String(i)}`, { cause: err });
  }
  return err;
}

async function readResultJson(fs: MemoryShipFs, path: string): Promise<ParsedFailureResult> {
  const raw = await fs.readFile(path, "utf-8");
  return JSON.parse(raw) as ParsedFailureResult;
}

const shipInputArbitrary: fc.Arbitrary<ShipInput> = fc.record({
  workdir: fc.constant(WORKDIR),
  repo: fc.constant("ship"),
  docPath: fc.constant("docs.md"),
});

const cursorOutcomeArbitrary = fc.constantFrom(
  { status: "succeeded" as const, durationMs: 0, branches: [] as const },
  {
    status: "failed" as const,
    durationMs: 1,
    errorMessage: "model rejected",
    branches: [] as const,
  },
  { status: "cancelled" as const, durationMs: 0, branches: [] as const },
);

describe("ShipService properties (fast-check)", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(() => {
    h.store.close();
  });

  test.prop([shipInputArbitrary, cursorOutcomeArbitrary, fc.boolean()], { numRuns: ITER })(
    "P1: ship sequences end in a terminal workflow status",
    async (input, result, doCancel) => {
      h.cursor.enqueue({ events: [], result });

      const shipPromise = h.service.ship(input);

      if (doCancel) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 20);
        });
        const runs = h.store.listRuns({ limit: 5 });
        const id = runs[0]?.id;
        if (id !== undefined) {
          await h.service.cancelRun(id);
        }
      }

      const out = await shipPromise;
      expect(terminalWorkflowStatusSchema.safeParse(out.status).success).toBe(true);
      const row = h.store.getRun(out.workflowRunId);
      expect(row).not.toBeNull();
      expect(isTerminal(row!.status)).toBe(true);
      expect(["succeeded", "failed", "cancelled"] as const).toContain(row!.status);
    },
  );

  test.prop([shipInputArbitrary], { numRuns: ITER })(
    "P2: cancelRun is idempotent — second call returns the same terminal status",
    async (input) => {
      h.cursor.enqueue({
        events: [],
        result: { status: "succeeded", durationMs: 0, branches: [] },
        cancelBehavior: "ignore",
      });

      const shipPromise = h.service.ship(input);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 30);
      });

      const runs = h.store.listRuns({ limit: 5 });
      const id = runs[0]?.id;
      expect(id).toBeDefined();
      if (id === undefined) return;

      const first = await h.service.cancelRun(id);
      const second = await h.service.cancelRun(id);
      expect(second.status).toBe(first.status);
      expect(isTerminal(second.status as WorkflowStatus)).toBe(true);

      const row = h.store.getRun(id);
      expect(row?.status).toBe(second.status);

      await shipPromise.catch(() => undefined);
    },
  );

  test.prop([fc.integer({ min: 0, max: 15 })], { numRuns: ITER })(
    "P3: finalizeFailure errorChain length is min(depth + 1, 10)",
    async (depth) => {
      h.cursor.enqueue({
        events: [],
        result: { status: "succeeded", durationMs: 0, branches: [] },
      });

      const chain = buildErrorChain(depth);
      const origWriteFile = h.fs.writeFile.bind(h.fs);
      h.fs.writeFile = (path: string, data: string): Promise<void> => {
        if (path.endsWith("prompt.md")) return Promise.reject(chain);
        return origWriteFile(path, data);
      };

      const out = await h.service.ship({
        workdir: WORKDIR,
        repo: "ship",
        docPath: "docs.md",
      });

      expect(out.status).toBe("failed");
      const parsed = await readResultJson(h.fs, out.artifacts.resultPath);
      expect(parsed.errorChain.length).toBe(Math.min(depth + 1, 10));
    },
  );
});

/**
 * `Harness` — scenario-test substrate that bundles a `@ship/store`, a
 * deterministic `TestClock`, prefixed-ULID id factories, a
 * scripted `FakeCursorRunner`, and a `close()`. The
 * `createServiceFromHarness(h)` helper wires these collaborators into
 * a `ShipService` for cross-package scenario tests.
 */

import type { ShipService, ShipServiceConfig } from "@ship/core";
import type { CursorRunner } from "@ship/cursor-runner";
import type { Store } from "@ship/store";

import { createMemoryShipFs, createShipService, type MemoryShipFs } from "@ship/core";
import { FakeCursorRunner } from "@ship/cursor-runner/test/fake";
import { createStore } from "@ship/store";
import { newCursorRunId, newPhaseId, newWorkflowRunId } from "@ship/workflow";

import type { TestClock } from "./clock.js";

import { createTestClock } from "./clock.js";

/**
 * Construction options for `createHarness`.
 *
 * - `dbPath`      — defaults to `":memory:"`. Set to an absolute path to
 *                   exercise WAL / file-backed flows.
 * - `clockStart`  — ISO-8601-with-offset starting moment.
 * - `clockStepMs` — auto-advance per `clock()` call. Default 1ms.
 */
export interface CreateHarnessOptions {
  dbPath?: string;
  clockStart?: string;
  clockStepMs?: number;
}

/** Handle a scenario test holds onto. Owns the store, clock, fake runner, and id factories. */
export interface Harness {
  readonly store: Store;
  readonly clock: TestClock;
  /** Scriptable cursor runner. Tests `enqueue()` per expected `cursor.run()`. */
  readonly cursor: FakeCursorRunner;
  /** Id factories returning fresh prefixed ULIDs via `@ship/workflow`. */
  readonly ids: {
    workflowRun: () => string;
    phase: () => string;
    cursorRun: () => string;
  };
  /** Disposes the underlying `Store`. Idempotent. */
  readonly close: () => void;
}

/**
 * Constructs a `Harness`. Synchronous; the store opens and migrations run
 * before this returns. Throws `RangeError` on bad `clockStart`; propagates
 * SQLite open errors on bad `dbPath`.
 */
export function createHarness(opts: CreateHarnessOptions = {}): Harness {
  const clock = createTestClock(opts.clockStart ?? DEFAULT_CLOCK_START, opts.clockStepMs);
  const store = createStore({ clock, dbPath: opts.dbPath ?? ":memory:" });
  const cursor = new FakeCursorRunner();

  let closed = false;
  return {
    clock,
    close: () => {
      if (closed) return;
      closed = true;
      store.close();
    },
    cursor,
    ids: {
      cursorRun: newCursorRunId,
      phase: newPhaseId,
      workflowRun: newWorkflowRunId,
    },
    store,
  };
}

/**
 * Construction options for `createServiceFromHarness`. The harness's
 * store + cursor + clock are reused; the rest is freshly minted per
 * call so multiple services can co-exist over the same store rows.
 */
export interface CreateServiceFromHarnessOptions {
  /** Default model `core` falls back to when `input.model` is omitted. Default `"composer-2"`. */
  defaultModelId?: string;
  /** Optional default Cursor `thinking` param for tests that mirror production wiring. */
  defaultThinking?: "low" | "high";
  /** Absolute artifacts directory inside the in-memory `ShipFs`. Default `/state/runs`. */
  runsDir?: string;
  /** Optional override `CursorRunner`. Defaults to the harness's `FakeCursorRunner`. */
  cursor?: CursorRunner;
  /** Optional cloud runner; forwarded into `ShipService` config when set. */
  cloudCursor?: CursorRunner;
}

/** Bundle returned by `createServiceFromHarness` — convenient for scenario assertions. */
export interface ServiceBundle {
  readonly service: ShipService;
  /** The in-memory FS the service is wired to; tests read it for artifact assertions. */
  readonly fs: MemoryShipFs;
  readonly config: ShipServiceConfig;
}

/**
 * Wires `harness.store` + `harness.cursor` + a fresh in-memory `ShipFs` +
 * `harness.clock` into a `ShipService`. The returned bundle exposes the
 * service plus the `fs` (so tests can inspect artifacts) and `config`
 * (so tests can resolve absolute artifact paths).
 */
export function createServiceFromHarness(
  h: Harness,
  opts: CreateServiceFromHarnessOptions = {},
): ServiceBundle {
  const fs = createMemoryShipFs();
  const config: ShipServiceConfig = {
    runsDir: opts.runsDir ?? DEFAULT_RUNS_DIR,
    defaultModel: {
      id: opts.defaultModelId ?? "composer-2",
      ...(opts.defaultThinking !== undefined && {
        params: [{ id: "thinking", value: opts.defaultThinking }],
      }),
    },
    cursor: opts.cursor ?? h.cursor,
    ...(opts.cloudCursor !== undefined ? { cloudCursor: opts.cloudCursor } : {}),
  };
  const service = createShipService({
    store: h.store,
    fs,
    clock: h.clock,
    config,
    ids: h.ids,
  });
  return { service, fs, config };
}

const DEFAULT_CLOCK_START = "2026-05-09T00:00:00.000Z";
const DEFAULT_RUNS_DIR = "/state/runs";

/**
 * `Harness` — the scenario-test substrate for `@ship` packages.
 *
 * A `Harness` owns the moving parts every cross-package scenario needs:
 * - a `@ship/store` instance (in-memory by default, file-backed on opt-in)
 * - a deterministic `TestClock` that advances 1ms per call
 * - id factories that generate `wf_/ph_/cr_<ulid>` strings via the
 *   real `@ship/workflow` factories (so ULID structure is real and
 *   sortable in test order)
 * - a `close()` that disposes the store and any pending work
 *
 * Phases 5–9 will extend this shape with `tower` / `cursor` properties as
 * those packages land. The interface stays additive; renames break every
 * consumer in the same commit per the package's stability promise.
 *
 * Why a class-flavored builder instead of a flat factory: scenarios benefit
 * from a single object that owns lifecycle (`close`) plus the components.
 * Flat factories would force scenarios to thread three or four refs and
 * remember to dispose every one.
 */

import type { Store } from "@ship/store";

import { createStore } from "@ship/store";
import { newCursorRunId, newPhaseId, newWorkflowRunId } from "@ship/workflow";

import type { TestClock } from "./clock.js";

import { createTestClock } from "./clock.js";

/**
 * Construction options for `createHarness`.
 *
 * - `dbPath`      — defaults to `":memory:"`. Set to an absolute path to
 *                   exercise WAL / file-backed flows (concurrent-readers
 *                   scenario does this).
 * - `clockStart`  — ISO-8601-with-offset starting moment. Defaults to
 *                   `"2026-05-09T00:00:00.000Z"`.
 * - `clockStepMs` — auto-advance per `clock()` call. Defaults to 1ms so
 *                   ULIDs sort in call order and `created_at` strictly
 *                   increases between consecutive writes.
 */
export interface CreateHarnessOptions {
  dbPath?: string;
  clockStart?: string;
  clockStepMs?: number;
}

/**
 * The handle a scenario test holds onto. Owns the store, the clock, and
 * the id factories; provides a single `close()` to dispose.
 *
 * `Harness` deliberately does NOT expose the underlying `Db` handle. Tests
 * that need raw SQL (e.g. corrupting a row to test hydration) live in the
 * consuming package's own unit tests, not in scenarios — the boundary
 * keeps scenario tests honest about exercising the public API.
 */
export interface Harness {
  /** The `@ship/store` `Store` bound to this harness's clock. */
  readonly store: Store;
  /** The deterministic test clock. Use `clock()` to mint a new timestamp. */
  readonly clock: TestClock;
  /**
   * Id factories. Each call returns a fresh prefixed ULID via the real
   * `@ship/workflow` factories. ULIDs embed a timestamp; with the auto-
   * advancing test clock, two consecutive calls within the same scenario
   * still produce distinct, sortable ids.
   */
  readonly ids: {
    workflowRun: () => string;
    phase: () => string;
    cursorRun: () => string;
  };
  /**
   * Disposes the underlying `Store` (closes the SQLite handle, runs WAL
   * checkpoint). Idempotent at the harness level — calling twice is a
   * no-op on the second call. Tests should call this in `afterEach`.
   */
  readonly close: () => void;
}

/**
 * Constructs a `Harness`. Synchronous; the store opens and migrations run
 * before this returns.
 *
 * Failure modes:
 * - Bad `clockStart` ISO → `RangeError` (from the underlying clock).
 * - Bad `dbPath` (unwritable, etc.) → propagates the SQLite open error
 *   through `createStore`, which closes the half-open handle before
 *   re-throwing.
 */
export function createHarness(opts: CreateHarnessOptions = {}): Harness {
  const clock = createTestClock(opts.clockStart ?? DEFAULT_CLOCK_START, opts.clockStepMs);
  const store = createStore({ clock, dbPath: opts.dbPath ?? ":memory:" });

  let closed = false;
  return {
    clock,
    close: () => {
      if (closed) return;
      closed = true;
      store.close();
    },
    ids: {
      cursorRun: newCursorRunId,
      phase: newPhaseId,
      workflowRun: newWorkflowRunId,
    },
    store,
  };
}

/** Default clock start used when `createHarness` isn't given one. */
const DEFAULT_CLOCK_START = "2026-05-09T00:00:00.000Z";

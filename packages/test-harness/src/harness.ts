/**
 * `Harness` — scenario-test substrate that bundles a `@ship/store`, a
 * deterministic `TestClock`, prefixed-ULID id factories, and a `close()`.
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
 *                   exercise WAL / file-backed flows.
 * - `clockStart`  — ISO-8601-with-offset starting moment.
 * - `clockStepMs` — auto-advance per `clock()` call. Default 1ms.
 */
export interface CreateHarnessOptions {
  dbPath?: string;
  clockStart?: string;
  clockStepMs?: number;
}

/** Handle a scenario test holds onto. Owns the store, clock, and id factories. */
export interface Harness {
  readonly store: Store;
  readonly clock: TestClock;
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

const DEFAULT_CLOCK_START = "2026-05-09T00:00:00.000Z";

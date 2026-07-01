/**
 * `Harness` — scenario-test substrate that bundles a `@ship/store`, a
 * deterministic `TestClock`, prefixed-ULID id factories, a
 * scripted `FakeCursorRunner`, and a `close()`. The
 * `createServiceFromHarness(h)` helper wires these collaborators into
 * a `ShipService` for cross-package scenario tests.
 */

import type { ShipService, ShipServiceConfig } from "@ship/core";
import type { AgentRunner } from "@ship/cursor-runner";
import type { Store } from "@ship/store";
import type { ModelSelection } from "@ship/workflow";

import {
  createMemoryShipFs,
  createShipService,
  DEFAULT_MODEL,
  type DocSource,
  type MemoryShipFs,
} from "@ship/core";
import { FakeCursorRunner } from "@ship/cursor-runner/test/fake";
import { createStore } from "@ship/store";
import { newCursorRunId, newPhaseId, newWorkflowRunId } from "@ship/workflow";

import type { TestClock } from "./clock.js";

import { createTestClock } from "./clock.js";
import { FakeDocSource } from "./fake-doc-source.js";

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
  /**
   * Full default `ModelSelection`; when set, ignores `defaultModelId` and
   * `defaultModelParams`.
   */
  defaultModel?: ModelSelection;
  /**
   * Default model id when `input.model` is omitted. Default mirrors
   * production wiring (`DEFAULT_MODEL.id`).
   */
  defaultModelId?: string;
  /**
   * Default params when defaultModel omitted. Default mirrors production
   * wiring (`DEFAULT_MODEL.params`).
   */
  defaultModelParams?: NonNullable<ModelSelection["params"]>;
  /** Absolute artifacts directory inside the in-memory `ShipFs`. Default `/state/runs`. */
  runsDir?: string;
  /** Optional override `AgentRunner`. Defaults to the harness's `FakeCursorRunner`. */
  cursor?: AgentRunner;
  /** Optional cloud runner; forwarded into `ShipService` config when set. */
  cloudCursor?: AgentRunner;
  /** Optional claude runner; forwarded into `ShipService` config when set. */
  claude?: AgentRunner;
  /** Optional cloud claude runner; forwarded into `ShipService` config when set. */
  cloudClaude?: AgentRunner;
  /** Optional codex runner; forwarded into `ShipService` config when set. */
  codex?: AgentRunner;
  /** Remote doc source; defaults to a fresh `FakeDocSource`. */
  docSource?: DocSource;
}

/** Bundle returned by `createServiceFromHarness` — convenient for scenario assertions. */
export interface ServiceBundle {
  readonly service: ShipService;
  /** The in-memory FS the service is wired to; tests read it for artifact assertions. */
  readonly fs: MemoryShipFs;
  readonly config: ShipServiceConfig;
}

function optionalInjectedRunners(
  opts: CreateServiceFromHarnessOptions,
): Partial<Pick<ShipServiceConfig, "cloudCursor" | "claude" | "cloudClaude" | "codex">> {
  return {
    ...(opts.cloudCursor !== undefined ? { cloudCursor: opts.cloudCursor } : {}),
    ...(opts.claude !== undefined ? { claude: opts.claude } : {}),
    ...(opts.cloudClaude !== undefined ? { cloudClaude: opts.cloudClaude } : {}),
    ...(opts.codex !== undefined ? { codex: opts.codex } : {}),
  };
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
  const defaultSelection: ModelSelection = opts.defaultModel ?? {
    id: opts.defaultModelId ?? DEFAULT_MODEL.id,
    params: opts.defaultModelParams ?? DEFAULT_MODEL.params,
  };
  const config: ShipServiceConfig = {
    runsDir: opts.runsDir ?? DEFAULT_RUNS_DIR,
    defaultModel: defaultSelection,
    cursor: opts.cursor ?? h.cursor,
    ...optionalInjectedRunners(opts),
  };
  const service = createShipService({
    store: h.store,
    fs,
    clock: h.clock,
    config,
    ids: h.ids,
    docSource: opts.docSource ?? new FakeDocSource(),
  });
  return { service, fs, config };
}

const DEFAULT_CLOCK_START = "2026-05-09T00:00:00.000Z";
const DEFAULT_RUNS_DIR = "/state/runs";

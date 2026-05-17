/**
 * Production wiring for `ShipService` + `OpenPrService`. Both
 * `@ship/cli` and `@ship/mcp-server` consume these factories so they
 * get an identical collaborator graph without duplicating the recipe.
 *
 * Both factories are lazy: construction is deferred until the first
 * `factory()` call so no SQLite open / fs `mkdir` happens during a
 * `--help` run. After the first call the same service is memoized
 * and returned on subsequent calls.
 *
 * `OpenPrService` ships alongside `ShipService` and shares the
 * `activeRuns` registry so `cancelRun` can signal whichever service
 * holds the controller (docs/features/ship-v2/phases/02-open-pr.md
 * § ED-8). Both consumers add their own path-resolution layer on top
 * — the CLI computes `<UserConfigDir>/ship/...` defaults; the
 * mcp-server reads paths from env vars.
 */

import type { CursorRunner } from "@ship/cursor-runner";
import type { ThinkingEffort } from "@ship/mcp";
import type { Store } from "@ship/store";
import type { ModelSelection } from "@ship/workflow";

import { LocalCursorRunner } from "@ship/cursor-runner";
import { createStore } from "@ship/store";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { GhClient } from "./gh.js";
import type { GitRemote } from "./git-remote.js";
import type { OpenPrService } from "./open-pr.js";
import type { ActiveRunsRegistry, ShipService } from "./service.js";

import { createNodeShipFs } from "./fs/index.js";
import { createNodeGhClient } from "./gh.js";
import { createNodeGitRemote } from "./git-remote.js";
import { createOpenPrService } from "./open-pr.js";
import { createShipService } from "./service.js";

/**
 * Wiring-level fallback for the Cursor `thinking` parameter. Cursor's
 * SDK has no documented default — the server resolves `params: []` to
 * whichever `ModelVariant.isDefault` is set today, which can shift
 * silently across releases. Pinning to `"high"` keeps Ship's real
 * runs at the quality grid we measured against; tests / harnesses
 * downshift to `"low"` via `defaultThinking`.
 */
const PRODUCTION_DEFAULT_THINKING: ThinkingEffort = "high";

/** Construction-time options for the production-wired `ShipService`. */
export interface DefaultShipServiceOpts {
  /** Absolute path to the SQLite db file, or `:memory:` for ephemeral. */
  readonly dbPath: string;
  /** Absolute path to the artifacts directory. */
  readonly runsDir: string;
  /** Default model id when `input.model` is omitted. */
  readonly defaultModelId?: string;
  /**
   * Exact default model params. Use `[]` for a custom `defaultModelId`
   * that does not support Cursor's `thinking` grid. When omitted,
   * Ship pins `thinking` from `defaultThinking`.
   */
  readonly defaultModelParams?: NonNullable<ModelSelection["params"]>;
  /**
   * Wiring-level override for the default Cursor `thinking` param.
   * Applies when a `ship` call omits `input.thinking`. Production
   * omits this and gets `"high"`; e2e harnesses pass `"low"` to
   * downshift cost / latency for the whole `ShipService` instance.
   * Ignored when `defaultModelParams` is provided.
   */
  readonly defaultThinking?: ThinkingEffort;
  /**
   * Cursor runner override. Production omits this and gets the real
   * `LocalCursorRunner`; integration tests pass a `FakeCursorRunner`
   * so they can exercise real `node:fs` + real SQLite without an API
   * key + without burning real model quota.
   */
  readonly cursor?: CursorRunner;
}

/** Memoizing factory shape. Returns the same `ShipService` across calls. */
export type ShipServiceFactory = () => ShipService;

/** Memoizing factory shape for `OpenPrService`. */
export type OpenPrServiceFactory = () => OpenPrService;

/** Construction-time options for the production-wired `OpenPrService`. */
export interface DefaultOpenPrServiceOpts {
  /** Absolute path to the SQLite db file, or `:memory:` for ephemeral. */
  readonly dbPath: string;
  /**
   * `GhClient` override. Production omits this and gets a
   * `createNodeGhClient()` (Octokit) that reads `GITHUB_TOKEN` /
   * `GH_TOKEN` from the environment. Integration tests inject a
   * stub or a pre-built Octokit pointing at a localhost mock.
   */
  readonly gh?: GhClient;
  /** `GitRemote` override. Production gets `createNodeGitRemote()`. */
  readonly git?: GitRemote;
}

interface SharedInfra {
  readonly store: Store;
  readonly clock: () => string;
  readonly activeRuns: ActiveRunsRegistry;
}

// Module-level cache keyed by the `dbPath` string — both factories
// constructed against the same dbPath share the underlying store +
// clock + activeRuns map. Without this an `open_pr` factory + a
// separately-constructed `ship` factory would each open their own
// SQLite handle (read/write contention on the same file) and have
// separate registries (cancel signals lost across services).
//
// The cache is a small Map; entries are GC-eligible once the binary
// exits because nothing else references them.
const SHARED_INFRA_BY_DB_PATH = new Map<string, SharedInfra>();

function getOrCreateSharedInfra(dbPath: string): SharedInfra {
  const existing = SHARED_INFRA_BY_DB_PATH.get(dbPath);
  if (existing !== undefined) return existing;
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const clock = (): string => new Date().toISOString();
  const store = createStore({ dbPath, clock });
  const activeRuns: ActiveRunsRegistry = new Map();
  const infra: SharedInfra = { store, clock, activeRuns };
  SHARED_INFRA_BY_DB_PATH.set(dbPath, infra);
  return infra;
}

/**
 * Returns a memoizing factory that constructs the production-wired
 * `ShipService` on first call. Subsequent calls return the cached
 * instance so each binary invocation gets exactly one
 * service-store-runner-fs triple. Shares store + activeRuns with
 * `createDefaultOpenPrService` constructed against the same `dbPath`.
 */
export function createDefaultShipService(opts: DefaultShipServiceOpts): ShipServiceFactory {
  let cached: ShipService | undefined;
  return () => {
    if (cached !== undefined) return cached;
    mkdirSync(opts.runsDir, { recursive: true });
    const infra = getOrCreateSharedInfra(opts.dbPath);
    const cursor = opts.cursor ?? new LocalCursorRunner();
    const fs = createNodeShipFs();
    const defaultModelParams = opts.defaultModelParams ?? [
      { id: "thinking", value: opts.defaultThinking ?? PRODUCTION_DEFAULT_THINKING },
    ];
    cached = createShipService({
      store: infra.store,
      cursor,
      fs,
      clock: infra.clock,
      activeRuns: infra.activeRuns,
      config: {
        runsDir: opts.runsDir,
        defaultModel: {
          id: opts.defaultModelId ?? "composer-2",
          params: defaultModelParams,
        },
      },
    });
    return cached;
  };
}

/**
 * Returns a memoizing factory that constructs the production-wired
 * `OpenPrService`. Shares store + activeRuns with
 * `createDefaultShipService` constructed against the same `dbPath`.
 */
export function createDefaultOpenPrService(opts: DefaultOpenPrServiceOpts): OpenPrServiceFactory {
  let cached: OpenPrService | undefined;
  return () => {
    if (cached !== undefined) return cached;
    const infra = getOrCreateSharedInfra(opts.dbPath);
    const fs = createNodeShipFs();
    cached = createOpenPrService({
      store: infra.store,
      fs,
      clock: infra.clock,
      activeRuns: infra.activeRuns,
      gh: opts.gh ?? createNodeGhClient(),
      git: opts.git ?? createNodeGitRemote(),
    });
    return cached;
  };
}

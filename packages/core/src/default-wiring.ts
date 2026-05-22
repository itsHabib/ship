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
import type { Store } from "@ship/store";
import type { ModelSelection } from "@ship/workflow";

import { CloudCursorRunner, LocalCursorRunner } from "@ship/cursor-runner";
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

// Read from cursor's GET /v1/models catalog on 2026-05-21. composer-2.5 is
// cursor's current default variant; `fast: true` is its isDefault param
// shape. Update both when the catalog rotates.
export const DEFAULT_MODEL: ModelSelection = {
  id: "composer-2.5",
  params: [{ id: "fast", value: "true" }],
};

function resolveConfiguredDefaultModel(opts: DefaultShipServiceOpts): ModelSelection {
  if (opts.defaultModel !== undefined) return opts.defaultModel;
  return {
    id: opts.defaultModelId ?? DEFAULT_MODEL.id,
    params: opts.defaultModelParams ?? DEFAULT_MODEL.params,
  };
}

/** Construction-time options for the production-wired `ShipService`. */
export interface DefaultShipServiceOpts {
  /** Absolute path to the SQLite db file, or `:memory:` for ephemeral. */
  readonly dbPath: string;
  /** Absolute path to the artifacts directory. */
  readonly runsDir: string;
  /**
   * Full default `ModelSelection` when set; ignores `defaultModelId` /
   * `defaultModelParams`. Use in tests / harnesses to downshift cost.
   */
  readonly defaultModel?: ModelSelection;
  /** Default model id when `input.model` is omitted. */
  readonly defaultModelId?: string;
  /**
   * Exact default model params. Use `[]` for models that omit the
   * default param grid entirely. When omitted, uses `DEFAULT_MODEL.params`.
   */
  readonly defaultModelParams?: NonNullable<ModelSelection["params"]>;
  /**
   * Cursor runner override. Production omits this and gets the real
   * `LocalCursorRunner`; integration tests pass a `FakeCursorRunner`
   * so they can exercise real `node:fs` + real SQLite without an API
   * key + without burning real model quota.
   */
  readonly cursor?: CursorRunner;
  /**
   * Cloud runner override. Production omits this and gets
   * `CloudCursorRunner`. Tests may omit via config construction (no
   * `cloudCursor` field) to exercise not-configured errors.
   */
  readonly cloudCursor?: CursorRunner;
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
    const cloudCursor = opts.cloudCursor ?? new CloudCursorRunner();
    const fs = createNodeShipFs();
    cached = createShipService({
      store: infra.store,
      fs,
      clock: infra.clock,
      activeRuns: infra.activeRuns,
      config: {
        runsDir: opts.runsDir,
        defaultModel: resolveConfiguredDefaultModel(opts),
        cursor,
        cloudCursor,
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

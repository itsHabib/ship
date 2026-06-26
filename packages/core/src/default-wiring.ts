// Production wiring for `ShipService`. Both `@ship/cli` and
// `@ship/mcp-server` consume this factory so they get an identical
// collaborator graph without duplicating the recipe.
//
// The factory is lazy: construction is deferred until the first
// `factory()` call so no SQLite open / fs `mkdir` happens during a
// `--help` run. After the first call the same service is memoized
// and returned on subsequent calls. Both consumers add their own
// path-resolution layer on top — the CLI computes
// `<UserConfigDir>/ship/...` defaults; the mcp-server reads paths
// from env vars.

import type { AgentRunner } from "@ship/agent-runner";
import type { Logger } from "@ship/logger";
import type { Store } from "@ship/store";
import type { ModelSelection } from "@ship/workflow";

import { LocalClaudeRunner } from "@ship/claude-runner";
import { CloudCursorRunner, LocalCursorRunner, RoomCursorRunner } from "@ship/cursor-runner";
import { createLogger } from "@ship/logger";
import { createStore } from "@ship/store";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { ActiveRunsRegistry, ShipService } from "./service.js";

import { createRemoteDocSource } from "./doc-source/index.js";
import { createNodeShipFs } from "./fs/index.js";
import { createShipService } from "./service.js";

// Read from cursor's GET /v1/models catalog on 2026-05-21. composer-2.5 is
// cursor's current default variant; `fast: true` is its isDefault param
// shape. Update both when the catalog rotates. String form (rather than
// boolean) — cursor's API accepts both, and string matches the SDK's typed
// shape verbatim. parseModelParam produces boolean for `--model-param`
// overrides; the path inconsistency is tracked as a deferred chip from
// PR #59 cycle-1 review (P3).
export const DEFAULT_MODEL: ModelSelection = {
  id: "composer-2.5",
  params: [{ id: "fast", value: "true" }],
};

// Claude Agent SDK default for `provider: "claude"` runs that omit `--model`.
// A Cursor model id (composer-2.5) is invalid for the Claude SDK, so claude runs
// need their own default. Override per-deployment via
// `DefaultShipServiceOpts.claudeDefaultModel` or per-run via `--model`; rotate
// the id when the catalog changes, and ensure the gateway/key allows it.
export const DEFAULT_CLAUDE_MODEL: ModelSelection = {
  id: "claude-sonnet-4-6",
};

function resolveConfiguredDefaultModel(opts: DefaultShipServiceOpts): ModelSelection {
  if (opts.defaultModel !== undefined) return opts.defaultModel;
  return {
    id: opts.defaultModelId ?? DEFAULT_MODEL.id,
    params: opts.defaultModelParams ?? DEFAULT_MODEL.params,
  };
}

function resolveConfiguredClaudeDefaultModel(opts: DefaultShipServiceOpts): ModelSelection {
  return opts.claudeDefaultModel ?? DEFAULT_CLAUDE_MODEL;
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
   * Full default `ModelSelection` for `provider: "claude"` runs. When omitted,
   * uses `DEFAULT_CLAUDE_MODEL`. Independent of the cursor `defaultModel*` knobs.
   */
  readonly claudeDefaultModel?: ModelSelection;
  /**
   * Cursor runner override. Production omits this and gets the real
   * `LocalCursorRunner`; integration tests pass a `FakeCursorRunner`
   * so they can exercise real `node:fs` + real SQLite without an API
   * key + without burning real model quota.
   */
  readonly cursor?: AgentRunner;
  /**
   * Cloud runner override. Production omits this and gets
   * `CloudCursorRunner`. Tests may omit via config construction (no
   * `cloudCursor` field) to exercise not-configured errors.
   */
  readonly cloudCursor?: AgentRunner;
  /**
   * Rooms runner override. Production omits this and gets
   * `RoomCursorRunner`. Tests may inject a `FakeCursorRunner`.
   */
  readonly roomCursor?: AgentRunner;
  /**
   * Claude runner override. Production omits this and gets
   * `LocalClaudeRunner`. Tests inject a `FakeAgentRunner`.
   */
  readonly claude?: AgentRunner;
  /**
   * Structured diagnostics logger. Production entrypoints pass
   * `createLogger({ stream: process.stderr })` explicitly.
   */
  readonly logger?: Logger;
  /**
   * When `true`, the first `ShipService` construction runs the orphan
   * resume sweep (mcp-server boot crash recovery). Default `false`.
   */
  readonly resumeOrphans?: boolean;
}

// Memoizing factory shape. Returns the same `ShipService` across calls.
export type ShipServiceFactory = () => ShipService;

/** Options for resolving the shared store without constructing `ShipService`. */
export type DefaultSharedStoreOpts = Pick<DefaultShipServiceOpts, "dbPath" | "logger">;

interface SharedInfra {
  readonly store: Store;
  readonly clock: () => string;
  readonly activeRuns: ActiveRunsRegistry;
}

// Module-level cache keyed by the `dbPath` string — multiple factory
// constructions against the same dbPath share the underlying store +
// clock + activeRuns map. The cache is a small Map; entries are
// GC-eligible once the binary exits because nothing else references
// them.
const SHARED_INFRA_BY_DB_PATH = new Map<string, SharedInfra>();

/**
 * Returns the shared `Store` for `dbPath`, creating it on first access.
 * `@ship/driver` wiring in CLI / mcp-server uses this so driver rows and
 * workflow rows share one SQLite handle without inverting the dep graph.
 */
export function getDefaultSharedStore(opts: DefaultSharedStoreOpts): Store {
  const logger = opts.logger ?? createLogger({ stream: process.stderr });
  return getOrCreateSharedInfra(opts.dbPath, logger).store;
}

/**
 * Closes and evicts the shared store for `dbPath`. Test harnesses call this
 * before removing a temp db directory — Windows cannot unlink an open SQLite
 * file. No-op when nothing is cached for the path.
 */
export function closeDefaultSharedStore(dbPath: string): void {
  const infra = SHARED_INFRA_BY_DB_PATH.get(dbPath);
  if (infra === undefined) return;
  SHARED_INFRA_BY_DB_PATH.delete(dbPath);
  infra.store.close();
}

function getOrCreateSharedInfra(dbPath: string, logger: Logger): SharedInfra {
  const existing = SHARED_INFRA_BY_DB_PATH.get(dbPath);
  if (existing !== undefined) return existing;
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const clock = (): string => new Date().toISOString();
  const store = createStore({ dbPath, clock, logger });
  const activeRuns: ActiveRunsRegistry = new Map();
  const infra: SharedInfra = { store, clock, activeRuns };
  SHARED_INFRA_BY_DB_PATH.set(dbPath, infra);
  return infra;
}

// Returns a memoizing factory that constructs the production-wired
// `ShipService` on first call. Subsequent calls return the cached
// instance so each binary invocation gets exactly one
// service-store-runner-fs triple.
export function createDefaultShipService(opts: DefaultShipServiceOpts): ShipServiceFactory {
  let cached: ShipService | undefined;
  const logger = opts.logger ?? createLogger({ stream: process.stderr });
  return () => {
    if (cached !== undefined) return cached;
    mkdirSync(opts.runsDir, { recursive: true });
    const infra = getOrCreateSharedInfra(opts.dbPath, logger);
    const cursor = opts.cursor ?? new LocalCursorRunner();
    const cloudCursor = opts.cloudCursor ?? new CloudCursorRunner();
    const roomCursor = opts.roomCursor ?? new RoomCursorRunner();
    const claude = opts.claude ?? new LocalClaudeRunner();
    const fs = createNodeShipFs();
    cached = createShipService({
      store: infra.store,
      fs,
      clock: infra.clock,
      activeRuns: infra.activeRuns,
      docSource: createRemoteDocSource(),
      logger,
      ...(opts.resumeOrphans === true ? { resumeOrphans: true } : {}),
      config: {
        runsDir: opts.runsDir,
        defaultModel: resolveConfiguredDefaultModel(opts),
        claudeDefaultModel: resolveConfiguredClaudeDefaultModel(opts),
        cursor,
        cloudCursor,
        roomCursor,
        claude,
      },
    });
    return cached;
  };
}

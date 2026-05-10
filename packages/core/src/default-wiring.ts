/**
 * Production wiring for `ShipService`. Both `@ship/cli` and
 * `@ship/mcp-server` consume this so they get an identical service
 * triple (`LocalCursorRunner` + `createNodeShipFs` + `createStore`)
 * without duplicating the recipe.
 *
 * The factory is lazy: construction is deferred until the first
 * `factory()` call so no SQLite open / fs `mkdir` happens during a
 * `--help` run. After the first call the same service is memoized
 * and returned on subsequent calls.
 *
 * Both consumers add their own path-resolution layer on top of this
 * helper — the CLI computes `<UserConfigDir>/ship/...` defaults; the
 * mcp-server reads paths from env vars. This helper just takes the
 * resolved absolute paths and turns them into a service.
 */

import type { CursorRunner } from "@ship/cursor-runner";

import { LocalCursorRunner } from "@ship/cursor-runner";
import { createStore } from "@ship/store";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { ShipService } from "./service.js";

import { createNodeShipFs } from "./fs/index.js";
import { createShipService } from "./service.js";

/** Construction-time options for the production-wired `ShipService`. */
export interface DefaultShipServiceOpts {
  /** Absolute path to the SQLite db file, or `:memory:` for ephemeral. */
  readonly dbPath: string;
  /** Absolute path to the artifacts directory. */
  readonly runsDir: string;
  /** Default model id when `input.model` is omitted. */
  readonly defaultModelId?: string;
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

/**
 * Returns a memoizing factory that constructs the production-wired
 * `ShipService` on first call. Subsequent calls return the cached
 * instance so each binary invocation gets exactly one
 * service-store-runner-fs triple.
 */
export function createDefaultShipService(opts: DefaultShipServiceOpts): ShipServiceFactory {
  let cached: ShipService | undefined;
  return () => {
    if (cached !== undefined) return cached;
    // First-invocation safety: create the dbPath's parent + runsDir
    // up front so SQLite + the artifact writer don't fault on a fresh
    // install. Skipped for the `:memory:` sentinel since SQLite handles
    // it in-process.
    if (opts.dbPath !== ":memory:") {
      mkdirSync(dirname(opts.dbPath), { recursive: true });
    }
    mkdirSync(opts.runsDir, { recursive: true });
    const clock = (): string => new Date().toISOString();
    const store = createStore({ dbPath: opts.dbPath, clock });
    const cursor = opts.cursor ?? new LocalCursorRunner();
    const fs = createNodeShipFs();
    cached = createShipService({
      store,
      cursor,
      fs,
      clock,
      config: {
        runsDir: opts.runsDir,
        defaultModel: { id: opts.defaultModelId ?? "composer-2" },
      },
    });
    return cached;
  };
}

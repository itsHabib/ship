/**
 * MCP-server-side `DriverService` factory — shares store + `ShipService`
 * with the ship factory without pulling `@ship/driver` into `@ship/core`.
 */

import type { DefaultShipServiceOpts, ShipServiceFactory } from "@ship/core";
import type { DriverService } from "@ship/driver";

import { getDefaultSharedStore } from "@ship/core";
import { createDriverService } from "@ship/driver";

export type DriverServiceFactory = () => DriverService;

/** Memoizing factory wired to the same db-backed store as `shipFactory`. */
export function createMcpDriverServiceFactory(
  opts: DefaultShipServiceOpts,
  shipFactory: ShipServiceFactory,
): DriverServiceFactory {
  let cached: DriverService | undefined;
  return () => {
    if (cached !== undefined) return cached;
    const ship = shipFactory();
    const store = getDefaultSharedStore({
      dbPath: opts.dbPath,
      ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
    });
    cached = createDriverService({ ship, store });
    return cached;
  };
}

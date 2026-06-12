/**
 * DriverService factory — public surface (spec §6).
 */

import type { Store } from "@ship/store";
import type { DriverRun, DriverRunStatus, ListDriverRunsFilter } from "@ship/store";

import type { ImportManifestResult } from "./import.js";
import type { DriverShipPort } from "./ship-port.js";
import type { Decision, DriverRunRef, DriverTickResult, MergeFacts, RunOpts } from "./types.js";

import { resolveRunOpts, runTick } from "./engine.js";
import { DriverRunNotFoundEngineError } from "./errors.js";
import { importManifest as importManifestFn } from "./import.js";
import { cancelRun, decide as decideFn, markMerged as markMergedFn } from "./judgment.js";
import { renderDriverRun } from "./render.js";

export interface DriverService {
  importManifest(manifestPath: string): ImportManifestResult;
  run(ref: DriverRunRef, opts?: RunOpts): Promise<DriverTickResult>;
  decide(driverRunId: string, streamId: string, decision: Decision): DriverRun;
  markMerged(driverRunId: string, streamId: string, facts: MergeFacts): DriverRun;
  cancel(driverRunId: string): Promise<DriverRun>;
  render(driverRunId: string): string;
  getDriverRun(id: string): DriverRun | null;
  listDriverRuns(filter?: {
    repo?: string;
    status?: DriverRunStatus[];
    limit?: number;
  }): DriverRun[];
}

export interface CreateDriverServiceOpts {
  store: Store;
  ship: DriverShipPort;
  clock?: () => number;
  rng?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function createDriverService(opts: CreateDriverServiceOpts): DriverService {
  const { store, ship, clock, rng, sleep } = opts;

  const now = (): string => new Date((clock ?? Date.now)()).toISOString();

  return {
    cancel: (driverRunId) => cancelRun(store, ship, driverRunId, now()),
    decide: (driverRunId, streamId, decision) => decideFn(store, driverRunId, streamId, decision),
    getDriverRun: (id) => store.getDriverRun(id),
    importManifest: (manifestPath) => importManifestFn(store, manifestPath),
    listDriverRuns: (filter) => store.listDriverRuns(filter ?? {}),
    markMerged: (driverRunId, streamId, facts) => markMergedFn(store, driverRunId, streamId, facts),
    render: (driverRunId) => renderDriverRun(store, driverRunId),
    run: async (ref, runOpts) => {
      const resolved = resolveRunOpts(runOpts);
      const driverRunId = resolveRunRef(store, ref);
      const deps: Parameters<typeof runTick>[2] = { ship, store };
      if (clock !== undefined) deps.clock = clock;
      if (rng !== undefined) deps.rng = rng;
      if (sleep !== undefined) deps.sleep = sleep;
      return runTick(driverRunId, resolved, deps);
    },
  };
}

function resolveRunRef(store: Store, ref: DriverRunRef): string {
  if ("driverRunId" in ref) {
    if (store.getDriverRun(ref.driverRunId) === null) {
      throw new DriverRunNotFoundEngineError(ref.driverRunId);
    }
    return ref.driverRunId;
  }
  const imported = importManifestFn(store, ref.manifestPath);
  return imported.run.id;
}

export type { ImportManifestResult, ListDriverRunsFilter };

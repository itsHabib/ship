/**
 * DriverService factory — public surface (spec §6).
 */

import type { Store } from "@ship/store";
import type { DriverRun, DriverRunStatus, ListDriverRunsFilter, RepoMergeGrant } from "@ship/store";

import type { DriverGhPort } from "./gh-port.js";
import type { ImportManifestResult } from "./import.js";
import type { DriverShipPort } from "./ship-port.js";
import type {
  Decision,
  DriverRunRef,
  DriverTickResult,
  LandOpts,
  MergeFacts,
  RunOpts,
} from "./types.js";

import { resolveRunOpts, runTick } from "./engine.js";
import { DecideError, DriverRunNotFoundEngineError } from "./errors.js";
import { importManifest as importManifestFn } from "./import.js";
import { cancelRun, decide as decideFn, markMerged as markMergedFn } from "./judgment.js";
import { land as landFn } from "./land.js";
import { renderDriverRun } from "./render.js";

export interface DriverService {
  importManifest(manifestPath: string): ImportManifestResult;
  run(ref: DriverRunRef, opts?: RunOpts): Promise<DriverTickResult>;
  decide(driverRunId: string, streamId: string, decision: Decision): DriverRun;
  markMerged(driverRunId: string, streamId: string, facts: MergeFacts): DriverRun;
  land(driverRunId: string, opts: LandOpts): Promise<DriverRun>;
  grantMerge(repo: string): RepoMergeGrant;
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
  gh?: DriverGhPort;
  clock?: () => number;
  monotonicClock?: () => number;
  rng?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function createDriverService(opts: CreateDriverServiceOpts): DriverService {
  const { store, ship, gh, clock, monotonicClock, rng, sleep } = opts;

  const now = (): string => new Date((clock ?? Date.now)()).toISOString();

  return {
    cancel: (driverRunId) => cancelRun(store, ship, driverRunId, now()),
    decide: (driverRunId, streamId, decision) => decideFn(store, driverRunId, streamId, decision),
    getDriverRun: (id) => store.getDriverRun(id),
    grantMerge: (repo) => store.registerRepoMergeGrant(repo),
    importManifest: (manifestPath) => importManifestFn(store, manifestPath),
    listDriverRuns: (filter) => store.listDriverRuns(filter ?? {}),
    land: async (driverRunId, landOpts) => {
      if (gh === undefined) {
        throw new DecideError("land requires a GitHub port — wire gh in createDriverService");
      }
      return landFn(store, gh, driverRunId, landOpts);
    },
    markMerged: (driverRunId, streamId, facts) => markMergedFn(store, driverRunId, streamId, facts),
    render: (driverRunId) => renderDriverRun(store, driverRunId),
    run: async (ref, runOpts) => {
      // A tick is the one driver operation that polls in-flight work, so it
      // owns orphan recovery: re-attach this process's cloud runs that a prior
      // tick left orphaned (kill+resume), then let the poll loop harvest the
      // result. Fire-and-forget keeps the tick within its maxWait bound — the
      // staleness-guarded re-attach lands in this poll window or the next
      // re-invocation. Read verbs (status/render/decide/...) never resume.
      void ship.resumeOrphanedRuns?.().catch(() => undefined);
      const resolved = resolveRunOpts(runOpts);
      const { driverRunId, warnings } = resolveRunRef(store, ref);
      const deps: Parameters<typeof runTick>[2] = { ship, store };
      if (clock !== undefined) deps.clock = clock;
      if (monotonicClock !== undefined) deps.monotonicClock = monotonicClock;
      if (rng !== undefined) deps.rng = rng;
      if (sleep !== undefined) deps.sleep = sleep;
      const tick = await runTick(driverRunId, resolved, deps);
      if (warnings === undefined || warnings.length === 0) return tick;
      return { ...tick, warnings };
    },
  };
}

interface ResolvedRunRef {
  driverRunId: string;
  warnings?: string[];
}

function resolveRunRef(store: Store, ref: DriverRunRef): ResolvedRunRef {
  if ("driverRunId" in ref) {
    if (store.getDriverRun(ref.driverRunId) === null) {
      throw new DriverRunNotFoundEngineError(ref.driverRunId);
    }
    return { driverRunId: ref.driverRunId };
  }
  const imported = importManifestFn(store, ref.manifestPath);
  const resolved: ResolvedRunRef = { driverRunId: imported.run.id };
  if (imported.warnings !== undefined && imported.warnings.length > 0) {
    resolved.warnings = imported.warnings;
  }
  return resolved;
}

export type { ImportManifestResult, ListDriverRunsFilter };

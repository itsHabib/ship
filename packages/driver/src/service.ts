/**
 * DriverService factory — public surface (spec §6).
 */

import type { Logger } from "@ship/logger";
import type { Store } from "@ship/store";
import type { DriverRun, DriverRunStatus, ListDriverRunsFilter } from "@ship/store";

import type { DriverGhPort } from "./gh-port.js";
import type { ImportManifestResult } from "./import.js";
import type { DriverShipPort } from "./ship-port.js";
import type {
  AddressOpts,
  Decision,
  DriverRunRef,
  DriverTickResult,
  LandOpts,
  MergeFacts,
  RunOpts,
} from "./types.js";

import { address as addressFn, flipStreamToCloud, resolveRunOpts, runTick } from "./engine.js";
import { DecideError, DriverRunNotFoundEngineError } from "./errors.js";
import { importManifest as importManifestFn } from "./import.js";
import { cancelRun, decide as decideFn, markMerged as markMergedFn } from "./judgment.js";
import { land as landFn } from "./land.js";
import { createNotifyPort, type NotifyExec } from "./notify.js";
import { renderDriverRun } from "./render.js";

export interface DriverService {
  importManifest(manifestPath: string): ImportManifestResult;
  run(ref: DriverRunRef, opts?: RunOpts): Promise<DriverTickResult>;
  decide(driverRunId: string, streamId: string, decision: Decision): DriverRun;
  markMerged(driverRunId: string, streamId: string, facts: MergeFacts): DriverRun;
  land(driverRunId: string, opts: LandOpts): Promise<DriverRun>;
  cancel(driverRunId: string): Promise<DriverRun>;
  flipStreamToCloud(driverRunId: string, streamId: string): Promise<DriverRun>;
  address(driverRunId: string, opts: AddressOpts): Promise<DriverRun>;
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
  /** Injectable notify exec for tests; production omits this. */
  notifyExec?: NotifyExec;
  /** Structured logger for notify failures; omitted in tests that silence logs. */
  logger?: Logger;
}

export function createDriverService(opts: CreateDriverServiceOpts): DriverService {
  const { store, ship, gh, clock, monotonicClock, rng, sleep, notifyExec, logger } = opts;

  const now = (): string => new Date((clock ?? Date.now)()).toISOString();

  return {
    address: async (driverRunId, addressOpts) => {
      if (gh === undefined) {
        throw new DecideError("address requires a GitHub port — wire gh in createDriverService");
      }
      return addressFn({ clock: clock ?? Date.now, gh, ship, store }, driverRunId, addressOpts);
    },
    cancel: (driverRunId) => cancelRun(store, ship, driverRunId, now()),
    flipStreamToCloud: (driverRunId, streamId) =>
      flipStreamToCloud(store, ship, driverRunId, streamId, clock ?? Date.now),
    decide: (driverRunId, streamId, decision) => decideFn(store, driverRunId, streamId, decision),
    getDriverRun: (id) => store.getDriverRun(id),
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
      void ship.resumeOrphanedRuns?.().catch(() => undefined);
      const resolved = resolveRunOpts(runOpts);
      const { driverRunId, warnings } = resolveRunRef(store, ref);
      const tick = await runTick(
        driverRunId,
        resolved,
        buildTickDeps({
          resolved,
          ship,
          store,
          clock,
          gh,
          logger,
          monotonicClock,
          notifyExec,
          rng,
          sleep,
        }),
      );
      if (warnings === undefined || warnings.length === 0) return tick;
      return { ...tick, warnings };
    },
  };
}

function buildTickDeps(input: {
  store: Store;
  ship: DriverShipPort;
  resolved: ReturnType<typeof resolveRunOpts>;
  gh?: DriverGhPort | undefined;
  logger?: Logger | undefined;
  notifyExec?: NotifyExec | undefined;
  clock?: (() => number) | undefined;
  monotonicClock?: (() => number) | undefined;
  rng?: (() => number) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}): Parameters<typeof runTick>[2] {
  const deps: Parameters<typeof runTick>[2] = { ship: input.ship, store: input.store };
  if (input.gh !== undefined) deps.gh = input.gh;
  if (input.logger !== undefined) deps.logger = input.logger;
  const notifyPort = createNotifyPort(input.resolved.notify, input.notifyExec);
  if (notifyPort !== undefined) deps.notify = notifyPort;
  if (input.resolved.escalation !== undefined) deps.escalation = input.resolved.escalation;
  if (input.clock !== undefined) deps.clock = input.clock;
  if (input.monotonicClock !== undefined) deps.monotonicClock = input.monotonicClock;
  if (input.rng !== undefined) deps.rng = input.rng;
  if (input.sleep !== undefined) deps.sleep = input.sleep;
  return deps;
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

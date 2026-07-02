/**
 * Driver engine tick — walker, dispatcher, poller (spec §4.1, §7).
 */

import type { GetWorkflowRunOutput, ShipInput, ShipStartOutput } from "@ship/core";
import type { Store } from "@ship/store";
import type { DriverBatch, DriverRun, DriverStream, StreamAttempt } from "@ship/store";
import type { AgentProvider, FailureCategory } from "@ship/workflow";

import { isTerminal } from "@ship/workflow";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { DispatchAmbiguity } from "./judgment.js";
import type { DriverShipPort } from "./ship-port.js";
import type { DriverTickResult, RunOpts, TierDispatchResult } from "./types.js";

import { DriverRunNotFoundEngineError, PreconditionError, TickLiveError } from "./errors.js";
import {
  allStreams,
  batchHasPendingDispatchable,
  buildDispatchAmbiguityRequests,
  buildFailureTriageRequests,
  buildProgress,
  buildStreamViews,
  buildUnmergedViews,
  everyStreamTerminalDoneOrSkipped,
  extractRepoUrl,
  hasInFlightStreams,
  isBatchEligible,
  isBlockedOnMerges,
  recoverDispatchingStreams,
  rollBatchStatus,
} from "./judgment.js";
import { mapTierToDispatch } from "./tier-map.js";

const DEFAULT_DISPATCH_PROVIDER: AgentProvider = "cursor";
const DEFAULT_MAX_WAIT_MS = 20 * 60 * 1000;
const DEFAULT_RUNAWAY_BACKSTOP_MS = 2 * 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_MAX_PARALLEL_LOCAL = 1;
const DEFAULT_MAX_PARALLEL_CLOUD = 4;
const RUNAWAY_BACKSTOP_MULTIPLIER = 6;

export interface EngineDeps {
  store: Store;
  ship: DriverShipPort;
  clock?: () => number;
  monotonicClock?: () => number;
  rng?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ResolvedRunOpts {
  batch?: number | undefined;
  maxWaitMs: number;
  runawayBackstopMs: number;
  pollIntervalMs: number;
  maxParallelLocal: number;
  maxParallelCloud: number;
  force: boolean;
}

interface TickContext {
  clock: () => number;
  monotonicClock: () => number;
  rng: () => number;
  sleep: (ms: number) => Promise<void>;
  ship: DriverShipPort;
  store: Store;
}

interface TickLiveness {
  lastProgressMono: number;
  lastSeenUpdatedAt: Map<string, string>;
  tickStartedMono: number;
  noteProgress(mono: number): void;
}

function createTickLiveness(tickStartedMono: number): TickLiveness {
  const tracker: TickLiveness = {
    lastProgressMono: tickStartedMono,
    lastSeenUpdatedAt: new Map(),
    tickStartedMono,
    noteProgress(mono: number): void {
      tracker.lastProgressMono = mono;
    },
  };
  return tracker;
}

interface DispatchContext {
  clock: () => number;
  cloudInFlight: number;
  localInFlight: number;
  onProgress: () => void;
  opts: ResolvedRunOpts;
  repoRoot: string;
  repoUrl: string | undefined;
  runId: string;
  ship: DriverShipPort;
  store: Store;
}

export function resolveRunOpts(opts?: RunOpts): ResolvedRunOpts {
  const parallel = defaultParallelLimits(opts);
  const maxWaitMs = opts?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  return {
    batch: opts?.batch,
    force: opts?.force === true,
    maxParallelCloud: parallel.cloud,
    maxParallelLocal: parallel.local,
    maxWaitMs,
    pollIntervalMs: opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    runawayBackstopMs: opts?.runawayBackstopMs ?? resolveRunawayBackstopMs(maxWaitMs),
  };
}

/** Absolute monotonic ceiling — catches trickle events that reset inactivity forever. */
export function resolveRunawayBackstopMs(maxWaitMs: number): number {
  return Math.max(maxWaitMs * RUNAWAY_BACKSTOP_MULTIPLIER, DEFAULT_RUNAWAY_BACKSTOP_MS);
}

/** True when the tick should stop polling and return progress (still `running`). */
export function shouldGiveUpTick(
  monoNow: number,
  liveness: Pick<TickLiveness, "lastProgressMono" | "tickStartedMono">,
  opts: Pick<ResolvedRunOpts, "maxWaitMs" | "runawayBackstopMs">,
): boolean {
  const inactivityMs = monoNow - liveness.lastProgressMono;
  if (inactivityMs >= opts.maxWaitMs) return true;
  const elapsedMonoMs = monoNow - liveness.tickStartedMono;
  if (elapsedMonoMs >= opts.runawayBackstopMs) return true;
  return false;
}

function defaultParallelLimits(opts?: RunOpts): { cloud: number; local: number } {
  const parallel = opts?.maxParallel;
  return {
    cloud: parallel?.cloud ?? DEFAULT_MAX_PARALLEL_CLOUD,
    local: parallel?.local ?? DEFAULT_MAX_PARALLEL_LOCAL,
  };
}

/** Execute one bounded engine tick. */
export async function runTick(
  driverRunId: string,
  opts: ResolvedRunOpts,
  deps: EngineDeps,
): Promise<DriverTickResult> {
  const ctx = buildTickContext(deps);
  loadRun(ctx.store, driverRunId);

  // Atomic check-and-stamp: two concurrent ticks can't both pass a separate
  // liveness check before either stamps (codex cycle-2).
  const claimed = ctx.store.claimDriverRunTick(driverRunId, {
    force: opts.force,
    staleBefore: new Date(ctx.clock() - 3 * opts.pollIntervalMs).toISOString(),
  });
  if (!claimed) {
    throw new TickLiveError(driverRunId);
  }
  const run = loadRun(ctx.store, driverRunId);

  try {
    return await executeTick(driverRunId, run, opts, ctx);
  } finally {
    ctx.store.stampDriverRunTickEnded(driverRunId);
  }
}

function buildTickContext(deps: EngineDeps): TickContext {
  return {
    clock: deps.clock ?? Date.now,
    monotonicClock: deps.monotonicClock ?? performance.now.bind(performance),
    rng: deps.rng ?? Math.random,
    ship: deps.ship,
    sleep: deps.sleep ?? defaultSleep,
    store: deps.store,
  };
}

async function executeTick(
  driverRunId: string,
  initialRun: DriverRun,
  opts: ResolvedRunOpts,
  ctx: TickContext,
): Promise<DriverTickResult> {
  const ambiguities: DispatchAmbiguity[] = [];
  if (isStickyTerminal(initialRun.status)) {
    return buildResult(initialRun, ambiguities, normalizeStickyStatus(initialRun.status));
  }

  const running = ensureRunning(ctx.store, driverRunId, initialRun);
  const recovered = await recoverDispatchingStreams(ctx.store, ctx.ship, running, ambiguities);
  validatePreFlight(recovered, opts);

  const tickStartedMono = ctx.monotonicClock();
  const liveness = createTickLiveness(tickStartedMono);
  return runDispatchPollLoop({ ambiguities, ctx, driverRunId, liveness, opts, run: recovered });
}

interface PollLoopState {
  ambiguities: DispatchAmbiguity[];
  ctx: TickContext;
  driverRunId: string;
  liveness: TickLiveness;
  opts: ResolvedRunOpts;
  run: DriverRun;
}

async function runDispatchPollLoop(state: PollLoopState): Promise<DriverTickResult> {
  let current = state.run;
  const noteProgress = (): void => {
    state.liveness.noteProgress(state.ctx.monotonicClock());
  };
  for (;;) {
    await dispatchEligible(buildDispatchContext(current, state.opts, state.ctx, noteProgress));
    current = loadRun(state.ctx.store, state.driverRunId);
    current = await pollDispatched(
      state.ctx,
      state.liveness,
      state.ctx.store,
      state.ctx.ship,
      current,
    );

    const exit = evaluateExit(current, state.ambiguities);
    if (exit !== undefined) {
      return finalizeExit(
        state.driverRunId,
        current,
        state.ambiguities,
        exit.status,
        state.ctx.store,
      );
    }
    if (shouldGiveUpTick(state.ctx.monotonicClock(), state.liveness, state.opts)) {
      return buildResult(current, state.ambiguities, "running");
    }

    await state.ctx.sleep(jitteredPollInterval(state.opts.pollIntervalMs, state.ctx.rng));
    current = loadRun(state.ctx.store, state.driverRunId);
  }
}

function finalizeExit(
  driverRunId: string,
  run: DriverRun,
  ambiguities: DispatchAmbiguity[],
  status: DriverTickResult["status"],
  store: Store,
): DriverTickResult {
  if (status === "awaiting_judgment") {
    store.updateDriverRunStatus(driverRunId, "awaiting_judgment");
  }
  if (status === "done") {
    const current = store.getDriverRun(driverRunId) ?? run;
    rollBatchStatus(store, current);
    store.updateDriverRunStatus(driverRunId, "done");
  }
  const refreshed = store.getDriverRun(driverRunId) ?? run;
  return buildResult(refreshed, ambiguities, status);
}

function loadRun(store: Store, driverRunId: string): DriverRun {
  const run = store.getDriverRun(driverRunId);
  if (run === null) {
    throw new DriverRunNotFoundEngineError(driverRunId);
  }
  return run;
}

function ensureRunning(store: Store, driverRunId: string, run: DriverRun): DriverRun {
  if (run.status === "running" || run.status === "awaiting_judgment") {
    return run;
  }
  store.updateDriverRunStatus(driverRunId, "running");
  return loadRun(store, driverRunId);
}

export function isTickLive(run: DriverRun, pollIntervalMs: number, clock: () => number): boolean {
  if (run.tickStartedAt === undefined) return false;
  const endedBeforeStart =
    run.tickEndedAt === undefined || Date.parse(run.tickEndedAt) < Date.parse(run.tickStartedAt);
  if (!endedBeforeStart) return false;

  const staleMs = 3 * pollIntervalMs;
  return clock() - Date.parse(run.updatedAt) < staleMs;
}

function isStickyTerminal(status: DriverRun["status"]): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

function validatePreFlight(run: DriverRun, opts: ResolvedRunOpts): void {
  const repoRoot = resolveRepoRoot(run.manifestPath);
  const repoUrl = extractRepoUrl(run);
  const missing = collectMissingWorktrees(run, opts, repoRoot, repoUrl);
  if (missing.length === 0) return;
  const lines = missing.map((path) => `${path} — create with /worktree-add <branch>`);
  throw new PreconditionError(`missing worktree directories:\n${lines.join("\n")}`);
}

function collectMissingWorktrees(
  run: DriverRun,
  opts: ResolvedRunOpts,
  repoRoot: string,
  repoUrl: string | undefined,
): string[] {
  const missing: string[] = [];
  for (const batch of run.batches) {
    if (!couldDispatchThisTick(batch, run.batches, opts.batch)) continue;
    for (const stream of batch.streams) {
      collectStreamPreflightErrors(stream, repoRoot, repoUrl, missing);
    }
  }
  return missing;
}

function collectStreamPreflightErrors(
  stream: DriverStream,
  repoRoot: string,
  repoUrl: string | undefined,
  missing: string[],
): void {
  if (stream.status !== "pending") return;
  if (stream.runtime === "rooms") {
    throw new PreconditionError(
      `rooms stream ${stream.id} is not supported by the engine yet — dispatch rooms work via ship.ship directly`,
    );
  }
  if (stream.runtime === "cloud" && repoUrl === undefined) {
    throw new PreconditionError(
      `cloud stream ${stream.id} requires repo_url in manifest — add repo_url to the driver frontmatter`,
    );
  }
  if (stream.runtime !== "local") return;
  if (stream.branch === undefined) {
    throw new PreconditionError(`local stream ${stream.id} requires branch_name in manifest`);
  }
  const worktreePath = join(repoRoot, ".claude", "worktrees", stream.branch);
  if (!existsSync(worktreePath)) missing.push(worktreePath);
}

function couldDispatchThisTick(
  batch: DriverBatch,
  batches: DriverBatch[],
  targetBatch?: number,
): boolean {
  if (targetBatch !== undefined && batch.batchIndex !== targetBatch) return false;
  if (!isBatchEligible(batch, batches, targetBatch)) return false;
  return batch.streams.some((s) => s.status === "pending");
}

export function resolveRepoRoot(manifestPath: string): string {
  let dir = resolve(dirname(manifestPath));
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new PreconditionError(`no .git ancestor found for manifest path ${manifestPath}`);
    }
    dir = parent;
  }
}

export function resolveDocPath(repoRoot: string, specPath: string): string {
  return resolve(repoRoot, specPath);
}

/**
 * Local docs resolve inside the stream's worktree — core requires a local
 * `docPath` to be a descendant of `workdir`. Cloud docs resolve against the
 * repo root (content is embedded at dispatch).
 */
export function resolveStreamDocPath(repoRoot: string, stream: DriverStream): string {
  if (stream.runtime === "local" && stream.branch !== undefined) {
    return resolveDocPath(join(repoRoot, ".claude", "worktrees", stream.branch), stream.specPath);
  }
  return resolveDocPath(repoRoot, stream.specPath);
}

function buildDispatchContext(
  run: DriverRun,
  opts: ResolvedRunOpts,
  ctx: TickContext,
  onProgress: () => void,
): DispatchContext {
  return {
    clock: ctx.clock,
    cloudInFlight: countInFlight(run, "cloud"),
    localInFlight: countInFlight(run, "local"),
    onProgress,
    opts,
    repoRoot: resolveRepoRoot(run.manifestPath),
    repoUrl: extractRepoUrl(run),
    runId: run.id,
    ship: ctx.ship,
    store: ctx.store,
  };
}

async function dispatchEligible(ctx: DispatchContext): Promise<void> {
  const run = loadRun(ctx.store, ctx.runId);
  let localInFlight = ctx.localInFlight;
  let cloudInFlight = ctx.cloudInFlight;

  for (const batch of run.batches) {
    localInFlight = await dispatchBatchStreams(batch, run, ctx, localInFlight, cloudInFlight);
    cloudInFlight = countInFlight(loadRun(ctx.store, ctx.runId), "cloud");
  }
}

async function dispatchBatchStreams(
  batch: DriverBatch,
  run: DriverRun,
  ctx: DispatchContext,
  localInFlight: number,
  cloudInFlight: number,
): Promise<number> {
  if (!batchHasPendingDispatchable(batch, run.batches)) return localInFlight;
  if (ctx.opts.batch !== undefined && batch.batchIndex !== ctx.opts.batch) return localInFlight;

  let local = localInFlight;
  let cloud = cloudInFlight;
  for (const stream of batch.streams) {
    if (stream.status !== "pending") continue;
    if (!canDispatchStream(stream, local, cloud, ctx.opts)) continue;
    const dispatched = await dispatchStream(ctx, stream);
    // A failed dispatch holds no slot — only live work counts against the caps.
    if (!dispatched) continue;
    ctx.onProgress();
    if (stream.runtime === "local") local += 1;
    if (stream.runtime === "cloud") cloud += 1;
  }
  return local;
}

function canDispatchStream(
  stream: DriverStream,
  localInFlight: number,
  cloudInFlight: number,
  opts: ResolvedRunOpts,
): boolean {
  if (stream.runtime === "local" && localInFlight >= opts.maxParallelLocal) return false;
  if (stream.runtime === "cloud" && cloudInFlight >= opts.maxParallelCloud) return false;
  return true;
}

function countInFlight(run: DriverRun, runtime: "local" | "cloud"): number {
  return allStreams(run).filter((s) => {
    if (s.status !== "dispatching" && s.status !== "dispatched") return false;
    return s.runtime === runtime;
  }).length;
}

async function dispatchStream(ctx: DispatchContext, stream: DriverStream): Promise<boolean> {
  const docPath = resolveStreamDocPath(ctx.repoRoot, stream);
  const attempt: StreamAttempt = {
    dispatchedAt: new Date(ctx.clock()).toISOString(),
    docPath,
    terminal: false,
  };
  const attempts = [...stream.attempts, attempt];
  const tierMapping = mapTierToDispatch(
    DEFAULT_DISPATCH_PROVIDER,
    stream.modelTier,
    stream.effortTier,
  );

  ctx.store.updateDriverStream(stream.id, {
    attempts,
    status: "dispatching",
    ...tierDispatchPatch(DEFAULT_DISPATCH_PROVIDER, tierMapping),
  });
  const input = buildShipInput(ctx, stream, docPath, tierMapping);
  return dispatchStartShip({
    baseAttempts: attempts,
    input,
    runId: ctx.runId,
    ship: ctx.ship,
    store: ctx.store,
    streamId: stream.id,
  });
}

interface StartShipParams {
  store: Store;
  ship: DriverShipPort;
  streamId: string;
  input: ShipInput;
  runId: string;
  baseAttempts: StreamAttempt[];
}

async function dispatchStartShip(params: StartShipParams): Promise<boolean> {
  let output: ShipStartOutput;
  try {
    output = await params.ship.startShip(params.input);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    params.store.updateDriverStream(params.streamId, {
      attempts: markLatestAttemptFailed(params.baseAttempts, "sdk-throw"),
      errorMessage: message,
      status: "failed",
    });
    return false;
  }
  // Persistence failures past this point propagate as engine errors: the
  // workflow is live, so the stream must stay `dispatching` for §7.3 recovery
  // to adopt — marking it failed would invite duplicate dispatch on retry.
  params.store.updateDriverStream(params.streamId, {
    attempts: markLatestAttemptWorkflowRunId(params.baseAttempts, output.workflowRunId),
    status: "dispatched",
    workflowRunId: output.workflowRunId,
  });
  return true;
}

function buildShipInput(
  ctx: DispatchContext,
  stream: DriverStream,
  docPath: string,
  tierMapping?: TierDispatchResult,
): ShipInput {
  let input: ShipInput;
  if (stream.runtime === "rooms") {
    throw new PreconditionError(`rooms stream ${stream.id} is not supported by the engine yet`);
  }
  if (stream.runtime === "cloud") {
    const repoUrl = ctx.repoUrl;
    if (repoUrl === undefined) {
      throw new PreconditionError(`cloud stream ${stream.id} requires repo_url in manifest`);
    }
    input = {
      docPath,
      repo: loadRun(ctx.store, ctx.runId).repo,
      runtime: "cloud",
      cloud: {
        autoCreatePR: true,
        env: { type: "cloud" },
        repos: [{ url: repoUrl }],
        workOnCurrentBranch: false,
      },
    };
  } else {
    const branch = stream.branch;
    if (branch === undefined) {
      throw new PreconditionError(`local stream ${stream.id} missing branch`);
    }
    input = {
      branch,
      docPath,
      repo: loadRun(ctx.store, ctx.runId).repo,
      runtime: "local",
      workdir: join(ctx.repoRoot, ".claude", "worktrees", branch),
    };
  }
  return applyTierMapping(input, tierMapping);
}

function applyTierMapping(input: ShipInput, tierMapping?: TierDispatchResult): ShipInput {
  if (tierMapping === undefined) {
    return input;
  }
  if (tierMapping.model === undefined && tierMapping.modelParams === undefined) {
    return input;
  }
  const mapped: ShipInput = { ...input };
  if (tierMapping.model !== undefined) {
    mapped.model = tierMapping.model;
  }
  if (tierMapping.modelParams !== undefined) {
    mapped.modelParams = tierMapping.modelParams;
  }
  return mapped;
}

function tierDispatchPatch(
  provider: AgentProvider,
  mapping: TierDispatchResult,
): Parameters<Store["updateDriverStream"]>[1] {
  const patch: Parameters<Store["updateDriverStream"]>[1] = { dispatchProvider: provider };
  if (mapping.model !== undefined) {
    patch.dispatchModel = mapping.model;
  }
  if (mapping.modelParams !== undefined) {
    patch.dispatchModelParams = mapping.modelParams;
  }
  if (mapping.degrade?.effortDegraded === true) {
    patch.effortDegraded = true;
  }
  if (mapping.degrade?.reason !== undefined) {
    patch.tierDegradeReason = mapping.degrade.reason;
  }
  return patch;
}

/** @internal Exported for unit tests — builds the `ShipInput` a stream dispatch would send. */
export function buildShipInputForTest(
  ctx: DispatchContext,
  stream: DriverStream,
  docPath: string,
): ShipInput {
  const tierMapping = mapTierToDispatch(
    DEFAULT_DISPATCH_PROVIDER,
    stream.modelTier,
    stream.effortTier,
  );
  return buildShipInput(ctx, stream, docPath, tierMapping);
}

function markLatestAttemptWorkflowRunId(
  attempts: StreamAttempt[],
  workflowRunId: string,
): StreamAttempt[] {
  if (attempts.length === 0) return attempts;
  const copy = [...attempts];
  const last = copy.at(-1);
  if (last === undefined) return copy;
  copy[copy.length - 1] = { ...last, workflowRunId };
  return copy;
}

function markLatestAttemptFailed(
  attempts: StreamAttempt[],
  failureCategory: FailureCategory,
): StreamAttempt[] {
  const last = attempts.at(-1);
  // No attempt to mark — don't fabricate one; the failure facts live on the
  // stream row either way.
  if (last === undefined) return attempts;
  return [...attempts.slice(0, -1), { ...last, failureCategory, terminal: true }];
}

async function pollDispatched(
  ctx: TickContext,
  liveness: TickLiveness,
  store: Store,
  ship: DriverShipPort,
  run: DriverRun,
): Promise<DriverRun> {
  for (const stream of allStreams(run)) {
    await pollOneStream(ctx, liveness, store, ship, stream);
  }
  return loadRun(store, run.id);
}

async function pollOneStream(
  ctx: TickContext,
  liveness: TickLiveness,
  store: Store,
  ship: DriverShipPort,
  stream: DriverStream,
): Promise<void> {
  if (stream.status !== "dispatched") return;
  const wfId = stream.workflowRunId;
  if (wfId === undefined) return;

  const wfRun = await ship.getRun(wfId);
  if (wfRun === null) return;
  noteWorkflowRunProgress(ctx, liveness, wfId, wfRun.updatedAt);
  if (!isTerminal(wfRun.status)) return;

  if (wfRun.status === "succeeded") {
    store.updateDriverStream(stream.id, buildLandedPatch(stream, wfRun));
    return;
  }

  store.updateDriverStream(stream.id, {
    attempts: markLatestAttemptFailed(stream.attempts, wfRun.failureCategory ?? "unknown"),
    errorMessage: wfRun.failureCategory ?? wfRun.status,
    status: "failed",
  });
}

function buildLandedPatch(
  stream: DriverStream,
  wfRun: GetWorkflowRunOutput,
): Parameters<Store["updateDriverStream"]>[1] {
  const patch: Parameters<Store["updateDriverStream"]>[1] = { status: "landed" };
  const branchRef = wfRun.branches?.[0];
  if (branchRef?.prUrl !== undefined) patch.prUrl = branchRef.prUrl;
  if (stream.branch === undefined && branchRef?.branch !== undefined) {
    patch.branch = branchRef.branch;
  }
  return patch;
}

function evaluateExit(
  run: DriverRun,
  ambiguities: DispatchAmbiguity[],
): Pick<DriverTickResult, "status"> | undefined {
  if (ambiguities.length > 0) {
    return { status: "awaiting_judgment" };
  }

  const hasFailed = allStreams(run).some((s) => s.status === "failed");
  const inFlight = hasInFlightStreams(run);

  if (hasFailed && !inFlight) {
    return { status: "awaiting_judgment" };
  }
  if (everyStreamTerminalDoneOrSkipped(run)) return { status: "done" };
  if (isBlockedOnMerges(run)) return { status: "blocked_on_merges" };
  return undefined;
}

function buildResult(
  run: DriverRun,
  ambiguities: DispatchAmbiguity[],
  status: DriverTickResult["status"],
): DriverTickResult {
  const awaiting =
    status === "awaiting_judgment"
      ? [...buildFailureTriageRequests(run), ...buildDispatchAmbiguityRequests(run, ambiguities)]
      : [];
  const unmerged = status === "blocked_on_merges" ? buildUnmergedViews(run) : [];

  return {
    awaiting,
    driverRunId: run.id,
    progress: buildProgress(run),
    status,
    streams: buildStreamViews(run),
    unmerged,
  };
}

function noteWorkflowRunProgress(
  ctx: TickContext,
  liveness: TickLiveness,
  workflowRunId: string,
  updatedAt: string,
): void {
  const previous = liveness.lastSeenUpdatedAt.get(workflowRunId);
  liveness.lastSeenUpdatedAt.set(workflowRunId, updatedAt);
  if (previous === undefined) return;
  if (previous === updatedAt) return;
  liveness.noteProgress(ctx.monotonicClock());
}

function jitteredPollInterval(baseMs: number, rng: () => number): number {
  return Math.round(baseMs * (0.8 + rng() * 0.4));
}

function normalizeStickyStatus(status: DriverRun["status"]): DriverTickResult["status"] {
  if (status === "done" || status === "failed" || status === "cancelled") return status;
  return "running";
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

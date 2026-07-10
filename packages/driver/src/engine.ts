/**
 * Driver engine tick — walker, dispatcher, poller (spec §4.1, §7).
 */

import type { GetWorkflowRunOutput, ShipInput, ShipStartOutput } from "@ship/core";
import type { Logger } from "@ship/logger";
import type { Store } from "@ship/store";
import type { DriverBatch, DriverRun, DriverStream, StreamAttempt } from "@ship/store";
import type { AgentProvider, FailureCategory } from "@ship/workflow";

import { prNumberFromUrl } from "@ship/receipt";
import { isTerminal } from "@ship/workflow";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { DriverGhPort } from "./gh-port.js";
import type { DispatchAmbiguity } from "./judgment.js";
import type { DriverShipPort } from "./ship-port.js";
import type {
  AddressOpts,
  DriverTickResult,
  EscalationConfig,
  NotifyConfig,
  RunOpts,
  TierDispatchResult,
} from "./types.js";

import {
  AddressError,
  DriverRunNotFoundEngineError,
  PreconditionError,
  TickLiveError,
} from "./errors.js";
import {
  retryPendingEscalationNotifications,
  writeAndDeliverEscalations,
  writeCycleExhaustedEscalation,
} from "./escalation.js";
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
import { createNotifyPort, type NotifyPort } from "./notify.js";
import { mapTierToDispatch } from "./tier-map.js";

const DEFAULT_DISPATCH_PROVIDER: AgentProvider = "cursor";
const DEFAULT_MAX_WAIT_MS = 20 * 60 * 1000;
const DEFAULT_RUNAWAY_BACKSTOP_MS = 2 * 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_MAX_PARALLEL_LOCAL = 1;
const DEFAULT_MAX_PARALLEL_CLOUD = 4;
const RUNAWAY_BACKSTOP_MULTIPLIER = 6;

// Review-cycle cap for `address` re-dispatch (TDD §7 Flow B). A policy value
// with a default — NOT wired to REQUIRED_REVIEW_COORDINATOR_CYCLES (same 3,
// different semantic scope: re-dispatch budget vs merge-gate evidence).
const DEFAULT_MAX_REVIEW_CYCLES = 3;

// Fixed mechanical preamble prepended to the findings file — instructs the
// agent to fix findings on the current branch and NOT open a new PR. The
// findings themselves are carried opaquely (no parsing, no selection).
const ADDRESS_DOC_PREAMBLE = [
  "# Address review findings",
  "",
  "Address the following review findings on the current branch; do not open a new PR.",
  "Push your changes to the branch the existing pull request already tracks.",
  "",
  "## Review findings",
  "",
].join("\n");

/** Cloud branch-continuation override — used by `flipStreamToCloud` and unit tests. */
export interface CloudContinuation {
  readonly startingRef: string;
  readonly workOnCurrentBranch: true;
}

const FLIP_CLOUD_RESET_PATCH = {
  dispatchModel: null,
  dispatchModelParams: null,
  dispatchProvider: null,
  effortDegraded: false,
  status: "pending" as const,
  tierDegradeReason: null,
  runtime: "cloud" as const,
  workOnCurrentBranch: true,
};

export interface EngineDeps {
  store: Store;
  ship: DriverShipPort;
  gh?: DriverGhPort;
  notify?: NotifyPort;
  escalation?: EscalationConfig;
  logger?: Logger;
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
  notify?: NotifyConfig | undefined;
  escalation?: EscalationConfig | undefined;
}

interface TickContext {
  clock: () => number;
  monotonicClock: () => number;
  rng: () => number;
  sleep: (ms: number) => Promise<void>;
  ship: DriverShipPort;
  gh?: DriverGhPort;
  store: Store;
  notify?: NotifyPort | undefined;
  escalation?: EscalationConfig | undefined;
  logger?: Logger | undefined;
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
    ...optionalNotifyFields(opts),
    batch: opts?.batch,
    force: opts?.force === true,
    maxParallelCloud: parallel.cloud,
    maxParallelLocal: parallel.local,
    maxWaitMs,
    pollIntervalMs: opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    runawayBackstopMs: opts?.runawayBackstopMs ?? resolveRunawayBackstopMs(maxWaitMs),
  };
}

function optionalNotifyFields(opts?: RunOpts): Pick<ResolvedRunOpts, "notify" | "escalation"> {
  const fields: Pick<ResolvedRunOpts, "notify" | "escalation"> = {};
  if (opts?.notify !== undefined) fields.notify = opts.notify;
  if (opts?.escalation !== undefined) fields.escalation = opts.escalation;
  return fields;
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
  const ctx: TickContext = {
    clock: deps.clock ?? Date.now,
    escalation: deps.escalation,
    logger: deps.logger,
    monotonicClock: deps.monotonicClock ?? performance.now.bind(performance),
    notify: deps.notify,
    rng: deps.rng ?? Math.random,
    ship: deps.ship,
    sleep: deps.sleep ?? defaultSleep,
    store: deps.store,
  };
  if (deps.gh !== undefined) {
    ctx.gh = deps.gh;
  }
  return ctx;
}

function buildEscalationDeps(
  ctx: TickContext,
  opts: ResolvedRunOpts,
): {
  store: Store;
  notify?: NotifyPort | undefined;
  escalation?: EscalationConfig | undefined;
  logger?: Logger | undefined;
  clock: () => string;
} {
  const notify = ctx.notify ?? createNotifyPort(opts.notify);
  const deps: {
    store: Store;
    notify?: NotifyPort | undefined;
    escalation?: EscalationConfig | undefined;
    logger?: Logger | undefined;
    clock: () => string;
  } = {
    clock: () => new Date(ctx.clock()).toISOString(),
    escalation: opts.escalation ?? ctx.escalation,
    logger: ctx.logger,
    store: ctx.store,
  };
  if (notify !== undefined) deps.notify = notify;
  return deps;
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

  await retryPendingEscalationNotifications(buildEscalationDeps(ctx, opts));

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
      return finalizeExit({
        ambiguities: state.ambiguities,
        ctx: state.ctx,
        driverRunId: state.driverRunId,
        opts: state.opts,
        run: current,
        status: exit.status,
      });
    }
    if (shouldGiveUpTick(state.ctx.monotonicClock(), state.liveness, state.opts)) {
      return buildResult(current, state.ambiguities, "running");
    }

    await state.ctx.sleep(jitteredPollInterval(state.opts.pollIntervalMs, state.ctx.rng));
    current = loadRun(state.ctx.store, state.driverRunId);
  }
}

interface FinalizeExitInput {
  ambiguities: DispatchAmbiguity[];
  ctx: TickContext;
  driverRunId: string;
  opts: ResolvedRunOpts;
  run: DriverRun;
  status: DriverTickResult["status"];
}

async function finalizeExit(input: FinalizeExitInput): Promise<DriverTickResult> {
  const { ambiguities, ctx, driverRunId, opts, run, status } = input;
  if (status === "awaiting_judgment") {
    ctx.store.updateDriverRunStatus(driverRunId, "awaiting_judgment");
    await writeAndDeliverEscalations(buildEscalationDeps(ctx, opts), run, ambiguities);
  }
  if (status === "done") {
    const current = ctx.store.getDriverRun(driverRunId) ?? run;
    rollBatchStatus(ctx.store, current);
    ctx.store.updateDriverRunStatus(driverRunId, "done");
  }
  const refreshed = ctx.store.getDriverRun(driverRunId) ?? run;
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

interface DispatchStreamOpts {
  continuation?: CloudContinuation;
  /** Explicit dispatch doc, overriding the latest-attempt/spec resolution. */
  docPath?: string;
}

async function dispatchStream(
  ctx: DispatchContext,
  stream: DriverStream,
  opts: DispatchStreamOpts = {},
): Promise<boolean> {
  const docPath = opts.docPath ?? resolveDispatchDocPath(ctx.repoRoot, stream);
  const attempt: StreamAttempt = {
    dispatchedAt: new Date(ctx.clock()).toISOString(),
    docPath,
    terminal: false,
  };
  const attempts = [...stream.attempts, attempt];
  const provider = stream.provider ?? DEFAULT_DISPATCH_PROVIDER;
  const tierMapping = mapTierToDispatch(provider, stream.modelTier, stream.effortTier);

  ctx.store.updateDriverStream(stream.id, {
    attempts,
    status: "dispatching",
    ...tierDispatchPatch(provider, tierMapping),
  });
  const input = buildShipInput({
    ctx,
    docPath,
    stream,
    tierMapping,
    ...(opts.continuation !== undefined ? { continuation: opts.continuation } : {}),
  });
  return dispatchStartShip({
    baseAttempts: attempts,
    input,
    runId: ctx.runId,
    ship: ctx.ship,
    store: ctx.store,
    streamId: stream.id,
  });
}

/**
 * The doc a tick re-dispatch resolves: the latest attempt's recorded docPath
 * (so a `decide retry` of a failed `address` re-runs the synthesized findings
 * doc, not the spec) before falling back to the stream's spec path for a fresh
 * dispatch. Callers that change runtime (flip-cloud) or synthesize a doc
 * (address) pass an explicit `docPath` and never hit this.
 */
function resolveDispatchDocPath(repoRoot: string, stream: DriverStream): string {
  const recorded = stream.attempts.at(-1)?.docPath;
  if (recorded !== undefined) return recorded;
  return resolveStreamDocPath(repoRoot, stream);
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

function buildShipInput(params: {
  ctx: DispatchContext;
  stream: DriverStream;
  docPath: string;
  tierMapping?: TierDispatchResult;
  continuation?: CloudContinuation;
}): ShipInput {
  const { ctx, stream, docPath, tierMapping, continuation } = params;
  if (stream.runtime === "rooms") {
    throw new PreconditionError(`rooms stream ${stream.id} is not supported by the engine yet`);
  }
  const base =
    stream.runtime === "cloud"
      ? buildCloudShipInput(ctx, stream, docPath, continuation)
      : buildLocalShipInput(ctx, stream, docPath);
  const input = stream.provider !== undefined ? { ...base, provider: stream.provider } : base;
  return applyTierMapping(input, tierMapping);
}

function buildCloudShipInput(
  ctx: DispatchContext,
  stream: DriverStream,
  docPath: string,
  continuation?: CloudContinuation,
): ShipInput {
  const repoUrl = ctx.repoUrl;
  if (repoUrl === undefined) {
    throw new PreconditionError(`cloud stream ${stream.id} requires repo_url in manifest`);
  }
  const cloudContinuation = resolveCloudContinuation(stream, continuation);
  // A persisted prUrl means the PR already exists (an `address` re-dispatch, or
  // any retry of one): never auto-create a second PR, and carry the prUrl so the
  // claude runner's prompt switches to push-to-existing-branch. Fresh + flip-cloud
  // streams have no prUrl and keep the auto-create-on-omitted-or-true default.
  const prExists = stream.prUrl !== undefined;
  const repoEntry = buildCloudRepoEntry(stream, repoUrl, cloudContinuation.startingRef, prExists);
  return {
    docPath,
    repo: loadRun(ctx.store, ctx.runId).repo,
    runtime: "cloud",
    ...(cloudContinuation.startingRef !== undefined
      ? { startingRef: cloudContinuation.startingRef }
      : {}),
    cloud: {
      autoCreatePR: !prExists,
      env: { type: "cloud" },
      repos: [repoEntry],
      workOnCurrentBranch: cloudContinuation.workOnCurrentBranch,
    },
  };
}

function buildCloudRepoEntry(
  stream: DriverStream,
  repoUrl: string,
  startingRef: string | undefined,
  prExists: boolean,
): NonNullable<ShipInput["cloud"]>["repos"][number] {
  const repoEntry: NonNullable<ShipInput["cloud"]>["repos"][number] = { url: repoUrl };
  if (startingRef !== undefined) repoEntry.startingRef = startingRef;
  if (stream.provider === "claude" && stream.branch !== undefined) {
    repoEntry.prBranch = stream.branch;
  }
  if (prExists) repoEntry.prUrl = stream.prUrl;
  return repoEntry;
}

function buildLocalShipInput(
  ctx: DispatchContext,
  stream: DriverStream,
  docPath: string,
): ShipInput {
  const branch = stream.branch;
  if (branch === undefined) {
    throw new PreconditionError(`local stream ${stream.id} missing branch`);
  }
  return {
    branch,
    docPath,
    repo: loadRun(ctx.store, ctx.runId).repo,
    runtime: "local",
    workdir: join(ctx.repoRoot, ".claude", "worktrees", branch),
  };
}

function resolveCloudContinuation(
  stream: DriverStream,
  override?: CloudContinuation,
): { startingRef?: string; workOnCurrentBranch: boolean } {
  if (override !== undefined) {
    return { startingRef: override.startingRef, workOnCurrentBranch: true };
  }
  if (stream.workOnCurrentBranch === true) {
    const ref = stream.branch;
    if (ref !== undefined) {
      return { startingRef: ref, workOnCurrentBranch: true };
    }
  }
  return { workOnCurrentBranch: false };
}

/**
 * Flip an imported local stream to cloud dispatch, continuing from its branch
 * without re-importing the manifest.
 */
export async function flipStreamToCloud(
  store: Store,
  ship: DriverShipPort,
  driverRunId: string,
  streamId: string,
  clock: () => number = Date.now,
): Promise<DriverRun> {
  const run = loadRun(store, driverRunId);
  const stream = allStreams(run).find((s) => s.id === streamId);
  if (stream === undefined) {
    throw new PreconditionError(`stream not found: ${streamId}`);
  }
  const branch = assertFlipEligibleStream(stream, run);

  store.updateDriverStream(streamId, FLIP_CLOUD_RESET_PATCH);
  const refreshed = store.getDriverRun(driverRunId);
  if (refreshed === null) {
    throw new DriverRunNotFoundEngineError(driverRunId);
  }
  const flipped = allStreams(refreshed).find((s) => s.id === streamId);
  if (flipped === undefined) {
    throw new PreconditionError(`stream not found after flip: ${streamId}`);
  }

  if (refreshed.status !== "running" && refreshed.status !== "awaiting_judgment") {
    store.updateDriverRunStatus(driverRunId, "running");
  }

  const ctx: DispatchContext = {
    clock,
    cloudInFlight: 0,
    localInFlight: 0,
    onProgress: () => undefined,
    opts: resolveRunOpts(),
    repoRoot: resolveRepoRoot(refreshed.manifestPath),
    repoUrl: extractRepoUrl(refreshed),
    runId: driverRunId,
    ship,
    store,
  };
  const continuation: CloudContinuation = {
    startingRef: branch,
    workOnCurrentBranch: true,
  };
  // Explicit docPath: the flip changed runtime to cloud, so resolve against the
  // repo root now rather than inherit a prior local attempt's worktree path.
  const dispatched = await dispatchStream(ctx, flipped, {
    continuation,
    docPath: resolveStreamDocPath(ctx.repoRoot, flipped),
  });
  if (!dispatched) {
    throw new PreconditionError(`cloud dispatch failed for stream ${streamId} after flip`);
  }
  const finalRun = store.getDriverRun(driverRunId);
  if (finalRun === null) {
    throw new DriverRunNotFoundEngineError(driverRunId);
  }
  return finalRun;
}

function assertFlipEligibleStream(stream: DriverStream, run: DriverRun): string {
  if (stream.runtime !== "local") {
    throw new PreconditionError(
      `stream ${stream.id} is not local (runtime=${stream.runtime}); flip-cloud applies to local streams only`,
    );
  }
  const branch = stream.branch;
  if (branch === undefined || branch === "") {
    throw new PreconditionError(`stream ${stream.id} missing branch — cannot continue on cloud`);
  }
  if (stream.status !== "pending" && stream.status !== "failed") {
    throw new PreconditionError(
      `stream ${stream.id} is not flip-eligible (status=${stream.status}); expected pending or failed`,
    );
  }
  const repoUrl = extractRepoUrl(run);
  if (repoUrl === undefined) {
    throw new PreconditionError(`cloud flip for stream ${stream.id} requires repo_url in manifest`);
  }
  return branch;
}

/** Ports + clock a `driver address` call needs (dispatch + live PR state). */
export interface AddressDeps {
  store: Store;
  ship: DriverShipPort;
  gh: DriverGhPort;
  clock?: () => number;
}

/**
 * Re-dispatch consolidated review findings onto a landed stream's existing PR
 * branch (TDD §7 Flow B). Mechanism only: the findings file is carried opaquely;
 * *which* findings to take and *whether* to push back stays seat-side. Every
 * illegal call refuses with a structured `AddressError` code — never a silent
 * no-op — and a call at the cycle cap also writes a `cycle-exhausted` escalation.
 *
 * Caller invariant: not safe to call concurrently for the same stream — the
 * cycle-cap read and the `reviewCycles` increment are separate store operations
 * (no lease; the seat owns not racing its own verb, as with its own PR branch).
 */
export async function address(
  deps: AddressDeps,
  driverRunId: string,
  opts: AddressOpts,
): Promise<DriverRun> {
  const { store, ship, gh } = deps;
  const clock = deps.clock ?? Date.now;
  const run = loadRun(store, driverRunId);
  if (isStickyTerminal(run.status)) {
    throw new AddressError(
      "run-not-addressable",
      `run ${driverRunId} is ${run.status}; cannot address findings`,
    );
  }
  const stream = allStreams(run).find((s) => s.id === opts.streamId);
  if (stream === undefined) {
    throw new PreconditionError(`stream not found: ${opts.streamId}`);
  }
  const branch = assertAddressableStream(stream);
  await assertPrOpen(gh, run, stream);

  const maxCycles = opts.maxCycles ?? DEFAULT_MAX_REVIEW_CYCLES;
  const current = stream.reviewCycles ?? 0;
  if (current >= maxCycles) {
    writeCycleExhaustedRow(store, run, stream, maxCycles, clock);
    throw new AddressError(
      "cycle-exhausted",
      `stream ${opts.streamId} has reached the review-cycle cap (${String(maxCycles)})`,
    );
  }

  const findings = readFindings(opts.findingsPath);
  const nextCycle = current + 1;
  const docPath = writeAddressDoc(run.manifestPath, stream.id, nextCycle, findings);

  // Persist the continuation on the row (load-bearing: a failed address retried
  // via `decide retry` resolves the continuation from the row) and bump the
  // engine-owned counter before dispatch — one `address` call is one cycle,
  // whether or not the dispatch lands.
  store.updateDriverStream(stream.id, { reviewCycles: nextCycle, workOnCurrentBranch: true });
  return dispatchAddress({ clock, ship, store }, driverRunId, stream.id, branch, docPath);
}

async function dispatchAddress(
  deps: { store: Store; ship: DriverShipPort; clock: () => number },
  driverRunId: string,
  streamId: string,
  branch: string,
  docPath: string,
): Promise<DriverRun> {
  const { store, ship, clock } = deps;
  const refreshed = store.getDriverRun(driverRunId);
  if (refreshed === null) {
    throw new DriverRunNotFoundEngineError(driverRunId);
  }
  const flipped = allStreams(refreshed).find((s) => s.id === streamId);
  if (flipped === undefined) {
    throw new PreconditionError(`stream not found after patch: ${streamId}`);
  }
  // The sticky-terminal guard in `address()` already refused done/failed/
  // cancelled, so this stamp only catches "pending" (a never-ticked import)
  // and the derived blocked-on-merges presentation — not a general fallback.
  if (refreshed.status !== "running" && refreshed.status !== "awaiting_judgment") {
    store.updateDriverRunStatus(driverRunId, "running");
  }
  const ctx: DispatchContext = {
    clock,
    cloudInFlight: 0,
    localInFlight: 0,
    onProgress: () => undefined,
    opts: resolveRunOpts(),
    repoRoot: resolveRepoRoot(refreshed.manifestPath),
    repoUrl: extractRepoUrl(refreshed),
    runId: driverRunId,
    ship,
    store,
  };
  const dispatched = await dispatchStream(ctx, flipped, {
    continuation: { startingRef: branch, workOnCurrentBranch: true },
    docPath,
  });
  if (!dispatched) {
    throw new PreconditionError(
      `address dispatch failed for stream ${streamId}; stream is failed — decide retry re-dispatches the findings doc on the PR branch`,
    );
  }
  return loadRun(store, driverRunId);
}

/** Assert a stream is address-eligible; returns its branch. */
function assertAddressableStream(stream: DriverStream): string {
  if (stream.status !== "landed") {
    throw new AddressError(
      "not-landed",
      `stream ${stream.id} is not landed (status=${stream.status})`,
    );
  }
  if (stream.runtime !== "cloud") {
    throw new AddressError(
      "not-cloud",
      `stream ${stream.id} runtime is ${stream.runtime}; address handles cloud streams only`,
    );
  }
  if (stream.prUrl === undefined || stream.branch === undefined) {
    const missing = stream.prUrl === undefined ? "PR" : "branch";
    throw new AddressError("no-pr", `stream ${stream.id} has no ${missing} to address`);
  }
  return stream.branch;
}

async function assertPrOpen(gh: DriverGhPort, run: DriverRun, stream: DriverStream): Promise<void> {
  const repo = extractRepoUrl(run);
  if (repo === undefined) {
    throw new PreconditionError(`cannot resolve repo URL for gh operations on run ${run.id}`);
  }
  const prNumber = prNumberFromUrl(stream.prUrl);
  if (prNumber === undefined) {
    throw new AddressError(
      "pr-not-open",
      `cannot parse PR number from prUrl ${String(stream.prUrl)}`,
    );
  }
  let view: Awaited<ReturnType<DriverGhPort["viewPullRequest"]>>;
  try {
    view = await gh.viewPullRequest(repo, prNumber);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new AddressError("pr-not-open", `gh view failed for PR #${String(prNumber)}: ${detail}`);
  }
  if (view.state !== "OPEN") {
    throw new AddressError("pr-not-open", `PR #${String(prNumber)} is ${view.state}, not open`);
  }
}

function readFindings(findingsPath: string): string {
  let content: string;
  try {
    content = readFileSync(findingsPath, "utf8");
  } catch {
    throw new AddressError("findings-unreadable", `findings file not readable: ${findingsPath}`);
  }
  if (content.trim() === "") {
    throw new AddressError("findings-unreadable", `findings file is empty: ${findingsPath}`);
  }
  return content;
}

/**
 * Write the synthesized address doc beside the run manifest so the exact
 * dispatched text is auditable, and return its absolute path (the dispatch
 * `docPath`).
 */
function writeAddressDoc(
  manifestPath: string,
  streamId: string,
  cycle: number,
  findings: string,
): string {
  const outPath = join(
    dirname(resolve(manifestPath)),
    `address-${streamId}-cycle${String(cycle)}.md`,
  );
  // Structured like the read side (`findings-unreadable`) so a disk/permission
  // failure surfaces through the land/decide error formatter, not as a raw
  // throw. The store is untouched at this point — the state stays clean.
  try {
    writeFileSync(outPath, `${ADDRESS_DOC_PREAMBLE}${findings}`, "utf8");
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new PreconditionError(`cannot write address doc ${outPath}: ${detail}`);
  }
  return outPath;
}

function writeCycleExhaustedRow(
  store: Store,
  run: DriverRun,
  stream: DriverStream,
  maxCycles: number,
  clock: () => number,
): void {
  writeCycleExhaustedEscalation(
    { store, clock: () => new Date(clock()).toISOString() },
    run,
    stream,
    `Review-cycle cap (${String(maxCycles)}) reached for stream ${stream.id}; seat must decide next step`,
    "address findings manually, extend the cap, or abandon the PR",
  );
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
  // Every dispatch writes every tier column: a re-dispatch after a retry
  // must not inherit a previous attempt's mapping or degrade flags.
  return {
    dispatchModel: mapping.model ?? null,
    dispatchModelParams: mapping.modelParams ?? null,
    dispatchProvider: provider,
    effortDegraded: mapping.degrade?.effortDegraded === true,
    tierDegradeReason: mapping.degrade?.reason ?? null,
  };
}

/** @internal Exported for unit tests — builds the `ShipInput` a stream dispatch would send. */
export function buildShipInputForTest(
  ctx: DispatchContext,
  stream: DriverStream,
  docPath: string,
  continuation?: CloudContinuation,
): ShipInput {
  const provider = stream.provider ?? DEFAULT_DISPATCH_PROVIDER;
  const tierMapping = mapTierToDispatch(provider, stream.modelTier, stream.effortTier);
  return buildShipInput({
    ctx,
    docPath,
    stream,
    tierMapping,
    ...(continuation !== undefined ? { continuation } : {}),
  });
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
    await pollOneStream({ ctx, liveness, run, ship, store, stream });
  }
  return loadRun(store, run.id);
}

interface PollOneStreamParams {
  ctx: TickContext;
  liveness: TickLiveness;
  run: DriverRun;
  ship: DriverShipPort;
  store: Store;
  stream: DriverStream;
}

async function pollOneStream(params: PollOneStreamParams): Promise<void> {
  const { ctx, liveness, run, ship, store, stream } = params;
  if (stream.status !== "dispatched") return;
  const wfId = stream.workflowRunId;
  if (wfId === undefined) return;

  const wfRun = await ship.getRun(wfId);
  if (wfRun === null) return;
  noteWorkflowRunProgress(ctx, liveness, wfId, wfRun.updatedAt);
  if (!isTerminal(wfRun.status)) return;

  if (wfRun.status === "succeeded") {
    await handleSucceededPoll(ctx, run, store, stream, wfRun);
    return;
  }

  store.updateDriverStream(stream.id, {
    attempts: markLatestAttemptFailed(stream.attempts, wfRun.failureCategory ?? "unknown"),
    errorMessage: wfRun.failureCategory ?? wfRun.status,
    status: "failed",
  });
}

async function handleSucceededPoll(
  ctx: TickContext,
  run: DriverRun,
  store: Store,
  stream: DriverStream,
  wfRun: GetWorkflowRunOutput,
): Promise<void> {
  const prUrl = wfRun.branches?.[0]?.prUrl;
  // Flip only when THIS dispatch created the PR: a stream that already carried a
  // prUrl before the poll (an `address` re-dispatch onto an open PR) has nothing
  // to flip — skip the readiness round-trip and keep the flip's meaning tied to
  // PR creation.
  if (stream.runtime === "cloud" && prUrl !== undefined && stream.prUrl === undefined) {
    const flipError = await flipCloudDraftReady(ctx.gh, run, prUrl);
    if (flipError !== undefined) {
      store.updateDriverStream(stream.id, {
        ...buildPrMetaPatch(stream, wfRun),
        errorMessage: flipError,
        status: "failed",
      });
      return;
    }
  }
  store.updateDriverStream(stream.id, buildLandedPatch(stream, wfRun));
}

async function flipCloudDraftReady(
  gh: DriverGhPort | undefined,
  run: DriverRun,
  prUrl: string,
): Promise<string | undefined> {
  if (gh === undefined) {
    return "draft→ready flip failed: GitHub port not configured";
  }
  const repo = extractRepoUrl(run);
  if (repo === undefined) {
    return "draft→ready flip failed: manifest missing repo_url";
  }
  const prNumber = prNumberFromUrl(prUrl);
  if (prNumber === undefined) {
    return `draft→ready flip failed: cannot parse PR number from prUrl ${prUrl}`;
  }
  try {
    await gh.markReady(repo, prNumber);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return `draft→ready flip failed: ${message}`;
  }
  return undefined;
}

function buildPrMetaPatch(
  stream: DriverStream,
  wfRun: GetWorkflowRunOutput,
): Parameters<Store["updateDriverStream"]>[1] {
  const patch: Parameters<Store["updateDriverStream"]>[1] = {};
  const branchRef = wfRun.branches?.[0];
  if (branchRef?.prUrl !== undefined) patch.prUrl = branchRef.prUrl;
  if (stream.branch === undefined && branchRef?.branch !== undefined) {
    patch.branch = branchRef.branch;
  }
  return patch;
}

function buildLandedPatch(
  stream: DriverStream,
  wfRun: GetWorkflowRunOutput,
): Parameters<Store["updateDriverStream"]>[1] {
  return { ...buildPrMetaPatch(stream, wfRun), status: "landed" };
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

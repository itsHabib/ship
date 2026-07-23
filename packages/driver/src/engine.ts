/**
 * Driver engine tick — walker, dispatcher, poller (spec §4.1, §7).
 */

import type { GetWorkflowRunOutput, ShipInput, ShipStartOutput } from "@ship/core";
import type { Logger } from "@ship/logger";
import type { Store } from "@ship/store";
import type { DriverBatch, DriverRun, DriverStream, StreamAttempt } from "@ship/store";
import type { AgentProvider, FailureCategory } from "@ship/workflow";

import {
  buildParkReceipts,
  type ParkStreamInput,
  persistReceipts,
  prNumberFromUrl,
  resolveDefaultReceiptsPath,
} from "@ship/receipt";
import { ReviewArtifactAddressRacedError, ReviewArtifactDuplicateError } from "@ship/store";
import { isTerminal } from "@ship/workflow";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { DriverGhPort, GhPullRequestView } from "./gh-port.js";
import type { DispatchAmbiguity } from "./judgment.js";
import type { DriverShipPort } from "./ship-port.js";
import type { TriageClassifier, TriageOutcome } from "./triage.js";
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
  decideFallbackHop,
  decideTransientRetry,
  type FallbackHopDecision,
} from "./fallback-hop.js";
import { assertGhIdentity } from "./gh-identity.js";
import { toGhRepo } from "./gh-port.js";
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
  extractStreamBaseBranch,
  hasInFlightStreams,
  isBatchEligible,
  isBlockedOnMerges,
  recoverDispatchingStreams,
  rollBatchStatus,
} from "./judgment.js";
import { createNotifyPort, type NotifyPort } from "./notify.js";
import {
  loadDispatchPolicy,
  type LoadedDispatchPolicy,
  providerCeilingViolation,
  runtimeCeilingViolation,
} from "./policy.js";
import {
  canonicalReviewFindingsSha256,
  MAX_REVIEW_FINDINGS_BYTES,
  parseReviewFindings,
  renderReviewFindings,
  type ReviewFindingsV1,
  ReviewFindingsValidationError,
} from "./review-findings.js";
import { mapTierToDispatch } from "./tier-map.js";
import { createViabilityDeps } from "./viability.js";

/** The provider the engine dispatches with when nothing else names one. */
export const DEFAULT_DISPATCH_PROVIDER: AgentProvider = "cursor";
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

// Fixed mechanical preamble prepended to the validated findings projection.
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
  /** Review-risk classifier; when absent the engine records no triage tier. */
  triage?: TriageClassifier;
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
  triage?: TriageClassifier | undefined;
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
  gh?: DriverGhPort;
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
  if (deps.triage !== undefined) {
    ctx.triage = deps.triage;
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

    // Poll-seam hop/retry leaves pending work with no in-flight — re-dispatch
    // until the stream leaves pending or the structural attempt bound is hit
    // (§8: ≤ 2×(1+chain)) so maxWaitMs:0 ticks can finish a retry-then-hop
    // without spinning when pending stays undispatchable (caps keep
    // hasInFlight true and skip this block).
    const maxRedispatches = maxPollRedispatches(current);
    for (let n = 0; n < maxRedispatches; n++) {
      current = loadRun(state.ctx.store, state.driverRunId);
      if (hasInFlightStreams(current) || !runHasPendingDispatchable(current, state.opts)) {
        break;
      }
      noteProgress();
      await dispatchEligible(buildDispatchContext(current, state.opts, state.ctx, noteProgress));
      current = loadRun(state.ctx.store, state.driverRunId);
      current = await pollDispatched(
        state.ctx,
        state.liveness,
        state.ctx.store,
        state.ctx.ship,
        current,
      );
      const afterHop = evaluateExit(current, state.ambiguities);
      if (afterHop !== undefined) {
        return finalizeExit({
          ambiguities: state.ambiguities,
          ctx: state.ctx,
          driverRunId: state.driverRunId,
          opts: state.opts,
          run: current,
          status: afterHop.status,
        });
      }
    }

    if (shouldGiveUpTick(state.ctx.monotonicClock(), state.liveness, state.opts)) {
      return buildResult(current, state.ambiguities, "running");
    }

    await state.ctx.sleep(jitteredPollInterval(state.opts.pollIntervalMs, state.ctx.rng));
    current = loadRun(state.ctx.store, state.driverRunId);
  }
}

function runHasPendingDispatchable(run: DriverRun, opts: ResolvedRunOpts): boolean {
  for (const batch of run.batches) {
    if (opts.batch !== undefined && batch.batchIndex !== opts.batch) continue;
    if (batchHasPendingDispatchable(batch, run.batches)) return true;
  }
  return false;
}

/** Spec §8 structural attempt ceiling — bounds poll-seam redispatch loops. */
function maxPollRedispatches(run: DriverRun): number {
  let maxChain = 0;
  for (const stream of allStreams(run)) {
    if (stream.status !== "pending") continue;
    const len = stream.fallbackChain?.length ?? 0;
    if (len > maxChain) maxChain = len;
  }
  return 2 * (1 + maxChain);
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
    writeParkReceiptsAtJudgment(run, ambiguities, ctx);
  }
  if (status === "done") {
    const current = ctx.store.getDriverRun(driverRunId) ?? run;
    rollBatchStatus(ctx.store, current);
    ctx.store.updateDriverRunStatus(driverRunId, "done");
  }
  const refreshed = ctx.store.getDriverRun(driverRunId) ?? run;
  return buildResult(refreshed, ambiguities, status);
}

function writeParkReceiptsAtJudgment(
  run: DriverRun,
  ambiguities: DispatchAmbiguity[],
  ctx: Pick<TickContext, "clock" | "logger">,
): void {
  const parkedStreamIds = new Set<string>();
  for (const request of [
    ...buildFailureTriageRequests(run),
    ...buildDispatchAmbiguityRequests(run, ambiguities),
  ]) {
    parkedStreamIds.add(request.streamId);
  }
  if (parkedStreamIds.size === 0) {
    return;
  }

  const streams: ParkStreamInput[] = [];
  for (const batch of run.batches) {
    for (const stream of batch.streams) {
      if (!parkedStreamIds.has(stream.id)) {
        continue;
      }
      streams.push(toParkStreamInput(stream, batch.batchIndex));
    }
  }

  const receipts = buildParkReceipts({
    driverRunId: run.id,
    generatedAt: new Date(ctx.clock()).toISOString(),
    phase: run.phase,
    project: run.project,
    repo: run.repo,
    streams,
  });
  // Park receipts go to the ONE canonical ship data-dir file that flare tails —
  // NOT a per-driven-repo file (the driver drives many repos into one global
  // receipts stream). See resolveDefaultReceiptsPath.
  const receiptsPath = resolveDefaultReceiptsPath(process.env, platform(), homedir());
  // Park receipts are telemetry, not load-bearing state: the run is already
  // stamped awaiting_judgment and escalations delivered. A write failure (fresh
  // data-dir, a malformed existing receipts file that fails to parse on read,
  // full disk) must NOT abort the tick — log and continue.
  try {
    persistReceipts(receiptsPath, receipts);
  } catch (error) {
    ctx.logger?.warn(
      { driverRunId: run.id, err: String(error), receiptsPath },
      "park receipts: persist failed; continuing (telemetry only)",
    );
  }
}

function toParkStreamInput(stream: DriverStream, batchIndex: number): ParkStreamInput {
  const runtime = stream.runtime === "rooms" ? undefined : stream.runtime;
  return {
    batchIndex,
    branch: stream.branch,
    prNumber: stream.prNumber,
    runtime,
    specPath: stream.specPath,
    streamIndex: stream.streamIndex,
    taskId: stream.taskId,
    taskSlug: stream.taskSlug,
    workflowRunId: stream.workflowRunId,
  };
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
  // Re-load the repo policy from the run's manifest path so a store-resident
  // stream that reached the store by any path still cannot dispatch past the
  // ceiling (import-time guard is not the only entry point).
  const policy = loadDispatchPolicy(dirname(run.manifestPath));
  const missing = collectMissingWorktrees(run, opts, repoRoot, repoUrl, policy);
  if (missing.length === 0) return;
  const lines = missing.map((path) => `${path} — create with /worktree-add <branch>`);
  throw new PreconditionError(`missing worktree directories:\n${lines.join("\n")}`);
}

function collectMissingWorktrees(
  run: DriverRun,
  opts: ResolvedRunOpts,
  repoRoot: string,
  repoUrl: string | undefined,
  policy: LoadedDispatchPolicy,
): string[] {
  const missing: string[] = [];
  for (const batch of run.batches) {
    if (!couldDispatchThisTick(batch, run.batches, opts.batch)) continue;
    for (const stream of batch.streams) {
      collectStreamPreflightErrors(stream, repoRoot, repoUrl, policy, missing);
    }
  }
  return missing;
}

function collectStreamPreflightErrors(
  stream: DriverStream,
  repoRoot: string,
  repoUrl: string | undefined,
  policy: LoadedDispatchPolicy,
  missing: string[],
): void {
  if (stream.status !== "pending") return;
  assertStreamWithinPolicy(stream, policy);
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

// The stored runtime/provider re-checked against the repo ceiling at dispatch
// time — a stream that slipped past import (edited store, older row) must not
// dispatch past the allowlist.
function assertStreamWithinPolicy(stream: DriverStream, policy: LoadedDispatchPolicy): void {
  const runtimeViolation = runtimeCeilingViolation(policy, stream.runtime);
  if (runtimeViolation !== undefined) {
    throw new PreconditionError(`stream ${stream.id}: ${runtimeViolation}`);
  }
  const providerViolation = providerCeilingViolation(policy, stream.provider);
  if (providerViolation !== undefined) {
    throw new PreconditionError(`stream ${stream.id}: ${providerViolation}`);
  }
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
    const gitPath = join(dir, ".git");
    // A linked worktree's `.git` is a *file* pointing back to the main repo. Its
    // `.claude/worktrees/` lives under the main worktree root, not here — so
    // resolve through the pointer, else a manifest read from inside a worktree
    // doubles the path (…/<branch>/.claude/worktrees/<branch>).
    if (existsSync(gitPath))
      return statSync(gitPath).isDirectory() ? dir : repoRootFromGitFile(gitPath);
    const parent = dirname(dir);
    if (parent === dir) {
      throw new PreconditionError(`no .git ancestor found for manifest path ${manifestPath}`);
    }
    dir = parent;
  }
}

// Resolve the repo root from a `.git` *file* (`.git` is a file, not a dir).
// A linked worktree's admin dir carries a `commondir` pointing at the main
// `.git`, so the main worktree root is its parent — that's where
// `.claude/worktrees/` lives, and resolving here avoids doubling the path
// (…/<branch>/.claude/worktrees/<branch>) when the manifest is read from
// inside a worktree. A `--separate-git-dir` checkout (also submodules) has a
// `.git` file but no `commondir`; there the working tree holding the `.git`
// file is itself the repo root — fall back to it rather than throwing on the
// missing pointer.
function repoRootFromGitFile(gitFilePath: string): string {
  const pointer = readFileSync(gitFilePath, "utf8").trim();
  const gitdir = pointer.startsWith("gitdir:") ? pointer.slice("gitdir:".length).trim() : "";
  if (gitdir === "") {
    throw new PreconditionError(`malformed git worktree pointer at ${gitFilePath}`);
  }
  const commonDirPointer = join(resolve(dirname(gitFilePath), gitdir), "commondir");
  if (!existsSync(commonDirPointer)) return dirname(gitFilePath);
  const commonDir = resolve(
    dirname(commonDirPointer),
    readFileSync(commonDirPointer, "utf8").trim(),
  );
  return dirname(commonDir);
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
  const base: DispatchContext = {
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
  if (ctx.gh !== undefined) base.gh = ctx.gh;
  return base;
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
    const bumped = bumpInFlightAfterDispatch(ctx, stream, local, cloud);
    local = bumped.local;
    cloud = bumped.cloud;
  }
  return local;
}

/** Count the post-dispatch runtime — a hop may have rewritten it mid-call. */
function bumpInFlightAfterDispatch(
  ctx: DispatchContext,
  stream: DriverStream,
  local: number,
  cloud: number,
): { local: number; cloud: number } {
  const live = findStream(loadRun(ctx.store, ctx.runId), stream.id);
  const runtime = live?.runtime ?? stream.runtime;
  if (runtime === "local") return { cloud, local: local + 1 };
  if (runtime === "cloud") return { cloud: cloud + 1, local };
  return { cloud, local };
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
  // Sync-seam hops reset the stream to pending on a new target; re-dispatch in
  // the same tick until start succeeds, the chain exhausts, or the failure is
  // ineligible. Cursor monotonicity bounds the loop to chain length.
  let current = stream;
  for (;;) {
    const dispatched = await dispatchStreamOnce(ctx, current, opts);
    if (dispatched) return true;
    const refreshed = ctx.store.getDriverRun(ctx.runId);
    if (refreshed === null) return false;
    const next = findStream(refreshed, current.id);
    if (next?.status !== "pending") return false;
    // A hop may have rewritten the runtime — the redispatch must clear the
    // same caps a fresh dispatch would; a saturated target waits for a later
    // tick instead of overshooting maxParallel*.
    const local = countInFlight(refreshed, "local");
    const cloud = countInFlight(refreshed, "cloud");
    if (!canDispatchStream(next, local, cloud, ctx.opts)) return false;
    current = next;
  }
}

function findStream(run: DriverRun, streamId: string): DriverStream | undefined {
  for (const batch of run.batches) {
    for (const s of batch.streams) {
      if (s.id === streamId) return s;
    }
  }
  return undefined;
}

async function dispatchStreamOnce(
  ctx: DispatchContext,
  stream: DriverStream,
  opts: DispatchStreamOpts,
): Promise<boolean> {
  const headOk = await checkTickAddressHead(ctx, stream);
  if (!headOk) return false;
  const docPath = opts.docPath ?? resolveDispatchDocPath(ctx.repoRoot, stream);
  const attempt: StreamAttempt = {
    dispatchedAt: new Date(ctx.clock()).toISOString(),
    docPath,
    terminal: false,
  };
  const attempts = [...stream.attempts, attempt];
  const provider = stream.provider ?? DEFAULT_DISPATCH_PROVIDER;
  const tierMapping = mapTierToDispatch(
    provider,
    stream.modelTier,
    stream.effortTier,
    stream.modelId,
  );

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
    repoRoot: ctx.repoRoot,
    repoUrl: ctx.repoUrl,
    runId: ctx.runId,
    ship: ctx.ship,
    store: ctx.store,
    stream,
    clock: ctx.clock,
  });
}

/**
 * Tick-path guard for the stale-head check. A fresh (cycle-0) dispatch needs no
 * head re-validation and may proceed without a gh port. An address-cycle
 * re-dispatch must re-validate the consumed head against the live PR — so when
 * the driver was created without a gh port, fail the stream closed rather than
 * bypass the check. The design requires that no path re-dispatch an address
 * attempt on a stale head; a silent skip here would be a fail-open.
 */
async function checkTickAddressHead(ctx: DispatchContext, stream: DriverStream): Promise<boolean> {
  const cycle = stream.reviewCycles;
  if (cycle === undefined || cycle === 0) return true;
  if (ctx.gh === undefined) {
    ctx.store.updateDriverStream(stream.id, {
      errorMessage: "stale-head: cannot re-validate address head — driver has no gh port",
      status: "failed",
    });
    return false;
  }
  return checkAddressAttemptHead(ctx.store, ctx.gh, ctx.repoUrl, ctx.runId, stream);
}

/**
 * Re-validate the consumed artifact's head against the live PR before starting
 * any address-cycle attempt. Returns true when OK to proceed; false when the PR
 * head has moved, in which case the stream is already marked failed so the
 * caller can return early without dispatching.
 *
 * Skips silently only when the stream has no consumed review artifact (not an
 * address cycle, or the store has no artifact row). Once a consumed head
 * exists, an unresolvable repo URL or PR number fails the stream closed — a
 * consumed artifact whose live head cannot be re-checked must never dispatch.
 */
async function checkAddressAttemptHead(
  store: Store,
  gh: DriverGhPort,
  repoUrl: string | undefined,
  runId: string,
  stream: DriverStream,
): Promise<boolean> {
  const cycle = stream.reviewCycles;
  if (cycle === undefined || cycle === 0) return true;
  const consumedHead = store.getConsumedArtifactHeadSha(runId, stream.id, cycle);
  if (consumedHead === undefined) return true;
  if (repoUrl === undefined) {
    return failStreamHeadCheck(store, stream.id, "cannot resolve repo URL for re-validation");
  }
  const prNumber = prNumberFromUrl(stream.prUrl);
  if (prNumber === undefined) {
    return failStreamHeadCheck(store, stream.id, "cannot resolve PR number for re-validation");
  }
  const view = await gh.viewPullRequest(toGhRepo(repoUrl), prNumber);
  const liveHead = view.headRefOid.toLowerCase();
  if (consumedHead.toLowerCase() === liveHead) return true;
  return failStreamHeadCheck(
    store,
    stream.id,
    `findings head ${consumedHead} does not match live head ${liveHead}`,
  );
}

/** Park a stream that failed the stale-head re-validation; always returns false. */
function failStreamHeadCheck(store: Store, streamId: string, reason: string): false {
  store.updateDriverStream(streamId, {
    errorMessage: `stale-head: ${reason}`,
    status: "failed",
  });
  return false;
}

/**
 * The doc a tick re-dispatch resolves. An `address` re-dispatch (reviewCycles
 * > 0) must reuse the latest attempt's synthesized findings doc. Everything
 * else — including a fallback hop onto a new runtime — resolves from the
 * stream's spec path for the *current* runtime (cloud root vs local worktree).
 * Reusing a prior cloud attempt's docPath after a hop to local would miss the
 * worktree and break the fake-runner / core workdir invariant.
 */
function resolveDispatchDocPath(repoRoot: string, stream: DriverStream): string {
  if ((stream.reviewCycles ?? 0) > 0) {
    const recorded = stream.attempts.at(-1)?.docPath;
    if (recorded !== undefined) return recorded;
  }
  return resolveStreamDocPath(repoRoot, stream);
}

interface StartShipParams {
  store: Store;
  ship: DriverShipPort;
  stream: DriverStream;
  input: ShipInput;
  runId: string;
  baseAttempts: StreamAttempt[];
  repoRoot: string;
  repoUrl: string | undefined;
  clock: () => number;
}

async function dispatchStartShip(params: StartShipParams): Promise<boolean> {
  let output: ShipStartOutput;
  try {
    output = await params.ship.startShip(params.input);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const failedAttempts = markLatestAttemptFailed(params.baseAttempts, "sdk-throw");
    await applyFallbackAfterFailure({
      category: "sdk-throw",
      clock: params.clock,
      errorMessage: message,
      failedAttempts,
      repoRoot: params.repoRoot,
      repoUrl: params.repoUrl,
      store: params.store,
      stream: params.stream,
    });
    // false either way: hop leaves pending for the dispatchStream loop; fail parks.
    return false;
  }
  // Persistence failures past this point propagate as engine errors: the
  // workflow is live, so the stream must stay `dispatching` for §7.3 recovery
  // to adopt — marking it failed would invite duplicate dispatch on retry.
  params.store.updateDriverStream(params.stream.id, {
    attempts: markLatestAttemptWorkflowRunId(params.baseAttempts, output.workflowRunId),
    status: "dispatched",
    workflowRunId: output.workflowRunId,
  });
  return true;
}

/**
 * Shared hop gate for both seams. Returns `hopped` when the stream was reset to
 * pending (same-target §4.7 retry or a new chain target); `failed` when it
 * stays (or becomes) failed.
 */
async function applyFallbackAfterFailure(params: {
  store: Store;
  stream: DriverStream;
  failedAttempts: StreamAttempt[];
  category: FailureCategory;
  errorMessage: string;
  repoRoot: string;
  repoUrl: string | undefined;
  clock: () => number;
  pollPrUrl?: string;
}): Promise<"hopped" | "failed"> {
  const at = new Date(params.clock()).toISOString();
  // §4.7 transient retry — checked FIRST, independent of the category allowlist.
  const retry = decideTransientRetry(params.stream, {
    at,
    category: params.category,
    errorMessage: params.errorMessage,
    failedAttempts: params.failedAttempts,
    ...(params.pollPrUrl !== undefined ? { pollPrUrl: params.pollPrUrl } : {}),
  });
  if (retry !== undefined) {
    return commitFallbackDecision(params, retry);
  }
  const decision = await decideFallbackHop(params.stream, {
    at,
    category: params.category,
    failedAttempts: params.failedAttempts,
    repoRoot: params.repoRoot,
    repoUrl: params.repoUrl,
    viability: createViabilityDeps(process.env),
    ...(params.pollPrUrl !== undefined ? { pollPrUrl: params.pollPrUrl } : {}),
  });
  return commitFallbackDecision(params, decision);
}

function commitFallbackDecision(
  params: {
    store: Store;
    stream: DriverStream;
    failedAttempts: StreamAttempt[];
    errorMessage: string;
    pollPrUrl?: string;
  },
  decision: FallbackHopDecision,
): "hopped" | "failed" {
  if (decision.kind === "retry" || decision.kind === "hop") {
    params.store.updateDriverStream(params.stream.id, decision.patch);
    return "hopped";
  }
  if (decision.kind === "exhaust") {
    params.store.updateDriverStream(params.stream.id, {
      ...decision.patch,
      errorMessage: params.errorMessage,
    });
    return "failed";
  }
  // A workflow PR seen at the poll seam is a work product every later
  // stored-column reader (sync seam, breaker predicate, decide retry) must
  // see — persist it with the failure.
  const prUrlExtras =
    params.pollPrUrl !== undefined && params.stream.prUrl === undefined
      ? { prUrl: params.pollPrUrl }
      : {};
  params.store.updateDriverStream(params.stream.id, {
    attempts: params.failedAttempts,
    errorMessage: params.errorMessage,
    status: "failed",
    ...prUrlExtras,
  });
  return "failed";
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
  // Continuation (flip-cloud / address) pins the ref to the stream's branch and
  // always wins; a fresh dispatch with no continuation honors the manifest
  // `base_branch` as the cloud starting ref.
  const run = loadRun(ctx.store, ctx.runId);
  const startingRef =
    cloudContinuation.startingRef ?? extractStreamBaseBranch(run, stream.specPath);
  // A persisted prUrl means the PR already exists (an `address` re-dispatch, or
  // any retry of one): never auto-create a second PR, and carry the prUrl so the
  // claude runner's prompt switches to push-to-existing-branch. Fresh + flip-cloud
  // streams have no prUrl and keep the auto-create-on-omitted-or-true default.
  const prExists = stream.prUrl !== undefined;
  const repoEntry = buildCloudRepoEntry(stream, repoUrl, startingRef, prExists);
  return {
    docPath,
    repo: run.repo,
    runtime: "cloud",
    // The local repo root is the policy-resolution cwd: a driver cloud stream
    // executes remotely but its `.ship.json` lives in this checkout, so carrying
    // the root lets the credential guard (and the dispatch-policy ceiling) resolve
    // the repo's constraint — the same fail-closed lookup local streams get.
    // Without it, the runner would resolve policy from a ship scratch dir and the
    // guard would silently no-op on cloud dispatches.
    workdir: ctx.repoRoot,
    ...(startingRef !== undefined ? { startingRef } : {}),
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
  // Refuse the flip when the repo policy forbids cloud — without this the
  // import-time guard has a hole (this verb mutates runtime after import).
  // Provider ceiling is NOT re-checked here: the flip changes runtime, not
  // provider; the next tick's validatePreFlight catches provider violations.
  const policy = loadDispatchPolicy(dirname(run.manifestPath));
  const cloudViolation = runtimeCeilingViolation(policy, "cloud");
  if (cloudViolation !== undefined) {
    throw new PreconditionError(`flip-cloud for stream ${streamId}: ${cloudViolation}`);
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
  files?: AddressFilePort;
}

export interface AddressFilePort {
  read(path: string): string;
  write(path: string, content: string): void;
}

const DEFAULT_ADDRESS_FILES: AddressFilePort = {
  read(path) {
    if (statSync(path).size > MAX_REVIEW_FINDINGS_BYTES) {
      throw new Error("findings file exceeds 1 MiB");
    }
    return readFileSync(path, "utf8");
  },
  write(path, content) {
    writeFileSync(path, content, "utf8");
  },
};

/**
 * Re-dispatch consolidated review findings onto a landed stream's existing PR
 * branch (TDD §7 Flow B). Mechanism only: findings are structurally validated;
 * *which* findings to take and *whether* to push back stays seat-side. Every
 * illegal call refuses with a structured `AddressError` code — never a silent
 * no-op — and a call at the cycle cap also writes a `cycle-exhausted` escalation.
 *
 * Concurrent callers are serialized by the store's consume-and-prepare
 * transaction; exactly one artifact/cycle can win.
 */
export async function address(
  deps: AddressDeps,
  driverRunId: string,
  opts: AddressOpts,
): Promise<DriverRun> {
  const { store, ship, gh } = deps;
  const clock = deps.clock ?? Date.now;
  const files = deps.files ?? DEFAULT_ADDRESS_FILES;
  const { branch, run, stream } = loadAddressTarget(store, driverRunId, opts.streamId);
  const pr = await loadAddressPr(gh, run, stream);
  const artifact = readFindings(files, opts.findingsPath);
  assertArtifactMatchesPr(artifact, pr);
  const nextCycle = nextAddressCycle(
    store,
    run,
    stream,
    opts.maxCycles ?? DEFAULT_MAX_REVIEW_CYCLES,
    clock,
  );
  const canonicalSha256 = canonicalReviewFindingsSha256(artifact);
  const docPath = writeAddressDoc({
    canonicalSha256,
    cycle: nextCycle,
    files,
    findings: renderReviewFindings(artifact),
    manifestPath: run.manifestPath,
    streamId: stream.id,
  });
  const tierMapping = consumePreparedAddress({
    artifact,
    canonicalSha256,
    clock,
    docPath,
    driverRunId,
    nextCycle,
    pr,
    store,
    stream,
  });
  return dispatchAddress({
    branch,
    deps: { clock, gh, ship, store },
    docPath,
    driverRunId,
    streamId: stream.id,
    tierMapping,
  });
}

function loadAddressTarget(store: Store, driverRunId: string, streamId: string) {
  const run = loadRun(store, driverRunId);
  if (isStickyTerminal(run.status)) {
    throw new AddressError(
      "run-not-addressable",
      `run ${driverRunId} is ${run.status}; cannot address findings`,
    );
  }
  const stream = allStreams(run).find((candidate) => candidate.id === streamId);
  if (stream === undefined) {
    throw new PreconditionError(`stream not found: ${streamId}`);
  }
  const branch = assertAddressableStream(stream);
  return { branch, run, stream };
}

interface AddressPr {
  prNumber: number;
  repo: string;
  view: GhPullRequestView;
}

function assertArtifactMatchesPr(artifact: ReviewFindingsV1, pr: AddressPr): void {
  if (artifact.subject.repo !== pr.repo || artifact.subject.number !== pr.prNumber) {
    throw new AddressError(
      "findings-subject-mismatch",
      `findings target ${artifact.subject.repo}#${String(artifact.subject.number)} does not match ${pr.repo}#${String(pr.prNumber)}`,
    );
  }
  if (artifact.subject.head_sha !== pr.view.headRefOid.toLowerCase()) {
    throw new AddressError(
      "findings-stale-head",
      `findings head ${artifact.subject.head_sha} does not match live head ${pr.view.headRefOid}`,
    );
  }
}

function nextAddressCycle(
  store: Store,
  run: DriverRun,
  stream: DriverStream,
  maxCycles: number,
  clock: () => number,
): number {
  const current = stream.reviewCycles ?? 0;
  if (current >= maxCycles) {
    writeCycleExhaustedRow(store, run, stream, maxCycles, clock);
    throw new AddressError(
      "cycle-exhausted",
      `stream ${stream.id} has reached the review-cycle cap (${String(maxCycles)})`,
    );
  }
  return current + 1;
}

function consumePreparedAddress(params: {
  artifact: ReviewFindingsV1;
  canonicalSha256: string;
  clock: () => number;
  docPath: string;
  driverRunId: string;
  nextCycle: number;
  pr: AddressPr;
  store: Store;
  stream: DriverStream;
}): TierDispatchResult {
  const { artifact, canonicalSha256, clock, docPath, driverRunId, nextCycle, pr, store, stream } =
    params;
  const attempt: StreamAttempt = {
    dispatchedAt: new Date(clock()).toISOString(),
    docPath,
    terminal: false,
  };
  const provider = stream.provider ?? DEFAULT_DISPATCH_PROVIDER;
  const tierMapping = mapTierToDispatch(
    provider,
    stream.modelTier,
    stream.effortTier,
    stream.modelId,
  );
  const dispatchPatch = tierDispatchPatch(provider, tierMapping);
  try {
    store.consumeReviewArtifactAndPrepareDispatch({
      addressCycle: nextCycle,
      artifactId: artifact.artifact_id,
      attempts: [...stream.attempts, attempt],
      canonicalSha256,
      dispatchProvider: provider,
      docPath,
      driverRunId,
      expectedReviewCycle: nextCycle - 1,
      headSha: artifact.subject.head_sha,
      prNumber: pr.prNumber,
      repo: pr.repo,
      streamId: stream.id,
      ...(typeof dispatchPatch.dispatchModel === "string"
        ? { dispatchModel: dispatchPatch.dispatchModel }
        : {}),
      ...(Array.isArray(dispatchPatch.dispatchModelParams)
        ? { dispatchModelParams: dispatchPatch.dispatchModelParams }
        : {}),
      effortDegraded: dispatchPatch.effortDegraded ?? false,
      ...(typeof dispatchPatch.tierDegradeReason === "string"
        ? { tierDegradeReason: dispatchPatch.tierDegradeReason }
        : {}),
    });
  } catch (error: unknown) {
    if (error instanceof ReviewArtifactDuplicateError) {
      throw new AddressError("findings-duplicate", error.message);
    }
    if (error instanceof ReviewArtifactAddressRacedError) {
      throw new AddressError("address-raced", error.message);
    }
    throw error;
  }
  return tierMapping;
}

async function dispatchAddress(params: {
  branch: string;
  deps: { store: Store; ship: DriverShipPort; clock: () => number; gh: DriverGhPort };
  docPath: string;
  driverRunId: string;
  streamId: string;
  tierMapping: TierDispatchResult;
}): Promise<DriverRun> {
  const { branch, deps, docPath, driverRunId, streamId, tierMapping } = params;
  const { gh, store, ship, clock } = deps;
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
  // Re-validate the consumed head against the live PR before dispatching.
  // This guards the window between consumption and dispatch startup.
  const headOk = await checkAddressAttemptHead(
    store,
    gh,
    extractRepoUrl(refreshed),
    driverRunId,
    flipped,
  );
  if (!headOk) {
    store.updateDriverRunStatus(driverRunId, "awaiting_judgment");
    throw new PreconditionError(
      `address attempt blocked for stream ${streamId}: consumed head does not match live PR head — decide retry or skip`,
    );
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
  const input = buildShipInput({
    continuation: { startingRef: branch, workOnCurrentBranch: true },
    ctx,
    docPath,
    stream: flipped,
    tierMapping,
  });
  const dispatched = await dispatchStartShip({
    baseAttempts: flipped.attempts,
    clock,
    input,
    repoRoot: ctx.repoRoot,
    repoUrl: ctx.repoUrl,
    runId: driverRunId,
    ship,
    store,
    stream: flipped,
  });
  if (!dispatched) {
    // The failed launch left the stream `failed`; stamp the run awaiting_judgment
    // so the advertised recovery (`decide retry`) is legal immediately, without
    // an interposed tick to restamp the run.
    store.updateDriverRunStatus(driverRunId, "awaiting_judgment");
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

async function loadAddressPr(
  gh: DriverGhPort,
  run: DriverRun,
  stream: DriverStream,
): Promise<{ prNumber: number; repo: string; view: GhPullRequestView }> {
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
  const ghRepo = toGhRepo(repo);
  let view: Awaited<ReturnType<DriverGhPort["viewPullRequest"]>>;
  try {
    view = await gh.viewPullRequest(ghRepo, prNumber);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new AddressError("pr-not-open", `gh view failed for PR #${String(prNumber)}: ${detail}`);
  }
  if (view.state !== "OPEN") {
    throw new AddressError("pr-not-open", `PR #${String(prNumber)} is ${view.state}, not open`);
  }
  return { prNumber, repo: ghRepo.toLowerCase(), view };
}

function readFindings(files: AddressFilePort, findingsPath: string) {
  let content: string;
  try {
    content = files.read(findingsPath);
  } catch (error: unknown) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new AddressError(
      "findings-unreadable",
      `findings file not readable: ${findingsPath}${detail}`,
    );
  }
  if (content.trim() === "") {
    throw new AddressError("findings-unreadable", `findings file is empty: ${findingsPath}`);
  }
  try {
    return parseReviewFindings(content);
  } catch (error: unknown) {
    if (error instanceof ReviewFindingsValidationError) {
      throw new AddressError("findings-invalid", error.message);
    }
    throw error;
  }
}

/**
 * Write the synthesized address doc beside the run manifest so the exact
 * dispatched text is auditable, and return its absolute path (the dispatch
 * `docPath`).
 */
function writeAddressDoc(params: {
  canonicalSha256: string;
  cycle: number;
  files: AddressFilePort;
  findings: string;
  manifestPath: string;
  streamId: string;
}): string {
  const { canonicalSha256, cycle, files, findings, manifestPath, streamId } = params;
  const outPath = join(
    dirname(resolve(manifestPath)),
    `address-${streamId}-cycle${String(cycle)}-${canonicalSha256.slice(0, 12)}.md`,
  );
  // Structured like the read side (`findings-unreadable`) so a disk/permission
  // failure surfaces through the land/decide error formatter, not as a raw
  // throw. The store is untouched at this point — the state stays clean.
  try {
    files.write(outPath, `${ADDRESS_DOC_PREAMBLE}${findings}`);
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
  const tierMapping = mapTierToDispatch(
    provider,
    stream.modelTier,
    stream.effortTier,
    stream.modelId,
  );
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
  // `last_event_at` reflects real remote activity; `updated_at` is also bumped
  // by the event pump's freshness timer, so reading it here would make a silent
  // hung cloud run look perpetually live (#157 give-up neutered). Fall back to
  // `updated_at` for local runs / pre-migration rows that carry no event anchor.
  noteWorkflowRunProgress(ctx, liveness, wfId, wfRun.lastEventAt ?? wfRun.updatedAt);
  if (!isTerminal(wfRun.status)) return;

  if (wfRun.status === "succeeded") {
    await handleSucceededPoll(ctx, run, store, stream, wfRun);
    return;
  }

  await handleFailedPoll(ctx, run, store, stream, wfRun);
}

async function handleFailedPoll(
  ctx: TickContext,
  run: DriverRun,
  store: Store,
  stream: DriverStream,
  wfRun: GetWorkflowRunOutput,
): Promise<void> {
  const category = wfRun.failureCategory ?? "unknown";
  const failedAttempts = markLatestAttemptFailed(stream.attempts, category);
  const pollPrUrl = wfRun.branches?.[0]?.prUrl;
  await applyFallbackAfterFailure({
    category,
    clock: ctx.clock,
    errorMessage: pollFailureErrorMessage(wfRun),
    failedAttempts,
    repoRoot: resolveRepoRoot(run.manifestPath),
    repoUrl: extractRepoUrl(run),
    store,
    stream,
    ...(pollPrUrl !== undefined ? { pollPrUrl } : {}),
  });
}

/**
 * Prefer the implement phase's error text (where connect-timeout / 429 /
 * network flaps land) so the §4.7 shape sensor can classify async failures.
 * Fall back to category / status when no phase message was persisted.
 */
// Implement-phase first: its error carries the root failure the §4.7 shape
// sensor must classify; a later phase's message may be a follow-on symptom.
function firstPhaseErrorMessage(wfRun: GetWorkflowRunOutput): string | undefined {
  const implementMsg = wfRun.phases.find((p) => p.kind === "implement")?.errorMessage;
  if (implementMsg !== undefined && implementMsg !== "") return implementMsg;
  for (let i = wfRun.phases.length - 1; i >= 0; i--) {
    const msg = wfRun.phases[i]?.errorMessage;
    if (msg !== undefined && msg !== "") return msg;
  }
  return undefined;
}

function pollFailureErrorMessage(wfRun: GetWorkflowRunOutput): string {
  const phaseMsg = firstPhaseErrorMessage(wfRun);
  if (phaseMsg !== undefined) return phaseMsg;
  const detail = wfRun.observability?.failure?.detail;
  if (detail !== undefined && detail !== "") return detail;
  return wfRun.failureCategory ?? wfRun.status;
}

async function handleSucceededPoll(
  ctx: TickContext,
  run: DriverRun,
  store: Store,
  stream: DriverStream,
  wfRun: GetWorkflowRunOutput,
): Promise<void> {
  const prUrl = wfRun.branches?.[0]?.prUrl;
  // Skip the flip only for an address-shaped re-dispatch (prUrl + persisted
  // continuation): it works an already-open, already-ready PR — nothing to
  // flip. A prUrl alone is NOT enough to skip: a failed flip persists the
  // prUrl on the failure path below, and the `decide retry` of that stream
  // must re-run the (idempotent) flip or the draft PR never becomes ready.
  if (stream.runtime === "cloud" && prUrl !== undefined && !isAddressRedispatch(stream)) {
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
  await classifyLandedStreamTriage(ctx, run, store, stream.id);
}

interface TriageTarget {
  triage: TriageClassifier;
  gh: DriverGhPort;
  repoSlug: string;
  prNumber: number;
  stream: DriverStream;
}

// Resolve everything classification needs, or undefined when the stream can't
// be classified (no classifier/gh wired, no repo URL, no PR). Keeps the guard
// branches out of the async caller so its complexity stays in budget.
function resolveTriageTarget(
  ctx: TickContext,
  run: DriverRun,
  store: Store,
  streamId: string,
): TriageTarget | undefined {
  const triage = ctx.triage;
  const gh = ctx.gh;
  if (triage === undefined || gh === undefined) return undefined;
  const repoUrl = extractRepoUrl(run);
  if (repoUrl === undefined) return undefined;
  const stream = findStream(loadRun(store, run.id), streamId);
  if (stream?.prUrl === undefined) return undefined;
  const prNumber = prNumberFromUrl(stream.prUrl);
  if (prNumber === undefined) return undefined;
  // `-R` wants the full owner/name slug, never the bare store label.
  return { gh, prNumber, repoSlug: toGhRepo(repoUrl), stream, triage };
}

/**
 * Classify the stream's PR via `triage-floor` and persist the outcome. Keyed on
 * the live PR head SHA: a head already classified is left alone; a moved head
 * (fix commits from a later review cycle) re-classifies. A classifier failure
 * persists `classifier_error` with NO tier — never a fabricated one — and never
 * crashes or blocks the landing. No-op when no classifier / gh port is wired.
 */
async function classifyLandedStreamTriage(
  ctx: TickContext,
  run: DriverRun,
  store: Store,
  streamId: string,
): Promise<void> {
  const target = resolveTriageTarget(ctx, run, store, streamId);
  if (target === undefined) return;
  const { gh, prNumber, repoSlug, stream, triage } = target;

  try {
    const view = await gh.viewPullRequest(repoSlug, prNumber);
    const headSha = view.headRefOid.toLowerCase();
    // Skip only a head already *classified* — a prior `classifier_error` on the
    // same head is deliberately retried (the classifier may have been transiently
    // unavailable), so it must not match this guard.
    if (stream.triageHeadSha === headSha && stream.triageTierSource === "classified") return;
    const outcome = await triage.classify(repoSlug, prNumber);
    persistTriageOutcome(ctx, store, streamId, headSha, outcome);
  } catch (err: unknown) {
    // Telemetry, not load-bearing state: a failed head-SHA read or persist must
    // not abort the tick's landing. Log and move on.
    ctx.logger?.warn(
      { err: String(err), prNumber, streamId },
      "triage: classification step failed; continuing (telemetry only)",
    );
  }
}

function persistTriageOutcome(
  ctx: TickContext,
  store: Store,
  streamId: string,
  headSha: string,
  outcome: TriageOutcome,
): void {
  if (outcome.kind === "classified") {
    store.updateDriverStream(streamId, {
      triageHeadSha: headSha,
      triageTier: outcome.tier,
      triageTierSource: "classified",
    });
    return;
  }
  ctx.logger?.warn(
    { headSha, reason: outcome.reason, streamId },
    "triage: classifier error; persisting classifier_error with no tier",
  );
  // Clear any prior tier: a broken classifier must not leave a stale routable
  // tier standing for the current head.
  store.updateDriverStream(streamId, {
    triageHeadSha: headSha,
    triageTier: null,
    triageTierSource: "classifier_error",
  });
}

/**
 * An `address` re-dispatch (or a retry of one): the stream carries a prUrl AND
 * an engine-bumped review cycle — `address` is only legal from `landed`, so the
 * PR was already flipped ready when the stream first landed. `workOnCurrentBranch`
 * is NOT the discriminator: flip-cloud persists it too, and a flip-cloud stream
 * whose PR-creation flip failed must re-run the flip on retry.
 */
function isAddressRedispatch(stream: DriverStream): boolean {
  return stream.prUrl !== undefined && (stream.reviewCycles ?? 0) > 0;
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
    // Guard the write: markReady is a gh mutation, so a repo that pins its gh
    // identity must be authenticated as that login before the draft→ready flip —
    // the same assertion land() runs before merge. A mismatch surfaces as a flip
    // failure (fail-closed), marking the stream failed.
    await assertGhIdentity(gh, run);
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
  progressAt: string,
): void {
  const previous = liveness.lastSeenUpdatedAt.get(workflowRunId);
  liveness.lastSeenUpdatedAt.set(workflowRunId, progressAt);
  if (previous === undefined) return;
  if (previous === progressAt) return;
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

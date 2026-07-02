/**
 * Enforcement of `policy.maxRunDurationMs` over a cursor run. The runner
 * contract has no deadline of its own — a hung cloud agent can hold
 * `handle.result` open forever, and a stalled SDK start/attach call
 * (`Agent.create` / `agent.send` / `Agent.resume`) can hang before a handle
 * even exists — so `core` runs the whole start → terminal sequence under a
 * single cap window.
 *
 * Expiry with a live handle resolves a synthetic `failed` terminal carrying
 * `durationMs >= maxRunDurationMs` and no classification events, so
 * `classifyFailure` lands on `timeout-near-cap` deterministically. Expiry
 * before the handle exists rejects with `CursorRunStartTimedOutError`
 * instead — the SDK start call is what hung, not the agent run — which the
 * finalize path classifies `sdk-throw`.
 *
 * Local runs measure elapsed with a monotonic clock and re-validate on fire
 * (#165). Cloud / rooms runs additionally track a live server-anchored age
 * floor and consult bounded probes on suspend evidence.
 */

import type {
  AgentRunHandle,
  AgentRunLiveness,
  AgentRunProbeArgs,
  AgentRunProbeResult,
  AgentRunResult,
} from "@ship/agent-runner";
import type { Logger } from "@ship/logger";

import { CursorRunStartTimedOutError } from "../errors.js";

/**
 * Floor for the cap window when a run is resumed with most (or all) of its
 * budget already spent — an attach always gets a short grace window so a
 * run that is already terminal SDK-side can still deliver its real result.
 * Clamped to `maxRunDurationMs` itself, so the grace never grants a window
 * larger than the configured cap.
 */
export const MIN_RESUMED_CAP_WINDOW_MS = 60_000;

/**
 * Node clamps a `setTimeout` delay above the 32-bit signed max to 1ms, which
 * would misfire a multi-week cap instantly. We clamp each physical wait to this
 * ceiling instead: a cap beyond ~24.9 days is served as a sequence of clamped
 * segments, re-arming for the next segment until the full window elapses. That
 * healthy segmentation is distinct from a suspend misfire — it neither warns
 * nor counts against `MAX_CAP_REARMS`. The synthetic terminal still reports the
 * configured cap as the duration; the clamp only bounds each physical wait.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Absolute backstop on *misfire* re-arming. Each genuine misfire (a suspend /
 * clock jump firing the timer before its armed delay elapsed in real time)
 * re-arms once and counts against this budget; a healthy clock produces no
 * misfires. (A clamped segment of a cap beyond `MAX_TIMER_DELAY_MS` also
 * re-arms, but on a healthy clock — it is not a misfire and does not count
 * here.) This bounds re-arming against a pathological / frozen monotonic clock
 * that would otherwise never reach the window: once the count is exceeded, the
 * cap fires regardless. Sized far above any realistic suspend count.
 */
export const MAX_CAP_REARMS = 64;

/** Bounded network round-trip for a run-age probe. */
export const PROBE_TIMEOUT_MS = 10_000;

/** Consecutive unreachable probes before rule-5 fail-closed can fire. */
export const CAP_PROBE_FAIL_CLOSED_AFTER = 3;

/** Slack when classifying a timer fire as late (step-suspect). */
export const FIRE_CLASSIFIER_SLACK_MS = 60_000;

/** Wall-minus-mono delta across one pump interval that signals paused-clock suspend. */
export const DISCONTINUITY_THRESHOLD_MS = 60_000;

/** Attach retry cadence for broken-seed probe schedule (midpoint of 30–60s). */
export const ATTACH_PROBE_RETRY_MS = 45_000;

export type DurationCapKind = "fresh" | "attach";

export interface DurationCapSignals {
  readonly probeRun?: (args: AgentRunProbeArgs) => Promise<AgentRunProbeResult | undefined>;
  readonly getLiveness?: () => AgentRunLiveness | undefined;
}

/** Hooks the service wires into event taps and the event-pump cadence. */
export interface DurationCapHandle {
  readonly onProviderStreamEvent: (eventAtMs: number) => void;
  readonly onDiscontinuitySample: (wallMs: number, monoMs: number) => void;
}

export interface DurationCapRunArgs {
  /** Starts the run (fresh dispatch) or attach (resume); invoked once, immediately. */
  readonly start: () => Promise<AgentRunHandle>;
  /**
   * Registration hook (store rows, event pump, active-runs entry); invoked
   * once iff the handle arrives before the cap expires. A handle arriving
   * after expiry is cancelled and never registered, so no bookkeeping
   * outlives the already-finalized run.
   */
  readonly onHandle: (handle: AgentRunHandle) => void;
  /** `policy.maxRunDurationMs` for this run. */
  readonly maxRunDurationMs: number;
  /**
   * Wall time the run consumed before this await began. Zero for fresh
   * dispatches; positive on resume, so a restart doesn't re-grant the
   * full cap to a run that already spent most of it.
   */
  readonly elapsedMs?: number;
  readonly kind?: DurationCapKind;
  /**
   * Monotonic clock for the cap measurement; defaults to `performance.now`.
   * Injectable so tests can drive elapsed independently of `setTimeout` firing.
   */
  readonly monotonicClock?: () => number;
  /** Wall clock for rule-5 and the discontinuity detector; defaults to `Date.now`. */
  readonly wallClock?: () => number;
  /** Row creation wall time (epoch ms) for broken-seed anchor fallback. */
  readonly rowCreatedAtWallMs?: number;
  /** Persisted provider server-stamped run creation (epoch ms). */
  readonly serverCreatedAtMs?: number;
  readonly signals?: DurationCapSignals;
  /** Id-addressed probe targets on attach before a handle exists. */
  readonly probeAgentId?: string;
  readonly probeRunId?: string;
  /** Called synchronously once remote-cap hooks are ready. */
  readonly onCapReady?: (handle: DurationCapHandle) => void;
  readonly log?: Logger;
}

const defaultMonotonicClock = (): number => performance.now();
const defaultWallClock = (): number => Date.now();

interface FloorSample {
  readonly ageMs: number;
  readonly foldedAtMono: number;
}

type TimerFireKind = "served" | "early" | "late";

/**
 * Resolves with the runner's terminal result, or — once the remaining cap
 * window of real (monotonic) time expires — cancels the run (best-effort, not
 * awaited) and resolves with a synthetic `failed` terminal instead.
 */
export async function runWithDurationCap(args: DurationCapRunArgs): Promise<AgentRunResult> {
  if (!hasRemoteSignals(args)) {
    return runLocalDurationCap(args);
  }
  return runRemoteDurationCap(args);
}

function hasRemoteSignals(args: DurationCapRunArgs): boolean {
  return args.signals?.probeRun !== undefined || args.signals?.getLiveness !== undefined;
}

async function runLocalDurationCap(args: DurationCapRunArgs): Promise<AgentRunResult> {
  const elapsedMs = args.elapsedMs ?? 0;
  const windowMs = capWindowMs(args.maxRunDurationMs, elapsedMs);
  const monotonicNow = args.monotonicClock ?? defaultMonotonicClock;
  const startedMono = monotonicNow();
  let handle: AgentRunHandle | undefined;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rearms = 0;
  let armedAtMono = 0;
  let armedDelayMs = 0;

  try {
    const capExpiry = new Promise<AgentRunResult>((resolve, reject) => {
      const onCapTimer = (): void => {
        const nowMono = monotonicNow();
        const realElapsed = nowMono - startedMono;
        const windowRemainingMs = windowMs - realElapsed;

        if (windowRemainingMs > 0 && nowMono - armedAtMono >= armedDelayMs) {
          armedAtMono = nowMono;
          armedDelayMs = Math.min(windowRemainingMs, MAX_TIMER_DELAY_MS);
          timer = setTimeout(onCapTimer, armedDelayMs);
          return;
        }

        if (windowRemainingMs > 0 && rearms < MAX_CAP_REARMS) {
          rearms += 1;
          armedAtMono = nowMono;
          armedDelayMs = Math.min(windowRemainingMs, MAX_TIMER_DELAY_MS);
          args.log?.warn(
            { realElapsed, rearms, windowMs, windowRemainingMs },
            "cap timer fired before real elapsed reached the window (host suspend / clock jump); re-arming",
          );
          timer = setTimeout(onCapTimer, armedDelayMs);
          return;
        }

        expired = true;
        args.log?.warn(
          {
            elapsedMs,
            maxRunDurationMs: args.maxRunDurationMs,
            realElapsed,
            rearms,
            startResolved: handle !== undefined,
            windowMs,
          },
          "policy.maxRunDurationMs exceeded; cancelling run",
        );
        if (handle === undefined) {
          reject(new CursorRunStartTimedOutError(windowMs));
          return;
        }
        resolve(capExceededResult(elapsedMs + windowMs));
        cancelBestEffort(handle);
      };
      armedAtMono = monotonicNow();
      armedDelayMs = Math.min(windowMs, MAX_TIMER_DELAY_MS);
      timer = setTimeout(onCapTimer, armedDelayMs);
    });
    void capExpiry.catch(() => {
      /* swallow late loser rejection */
    });

    const terminal = args.start().then((h) => {
      if (expired) {
        cancelBestEffort(h);
        return capExceededResult(elapsedMs + windowMs);
      }
      handle = h;
      args.onHandle(h);
      return h.result;
    });
    void terminal.catch(() => {
      /* swallow late loser rejection */
    });

    return await Promise.race([terminal, capExpiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function runRemoteDurationCap(args: DurationCapRunArgs): Promise<AgentRunResult> {
  const cap = args.maxRunDurationMs;
  const seedMs = resolveSeedMs(args);
  const windowMs = resolveWindowMs(args, seedMs);
  const monotonicNow = args.monotonicClock ?? defaultMonotonicClock;
  const wallNow = args.wallClock ?? defaultWallClock;
  const startedMono = monotonicNow();
  const windowDeadlineMono = startedMono + windowMs;
  // Attach evidence shrinks the window to the grace floor, never below it: an
  // already-terminal run must get the grace to deliver its real result, even
  // when the very first probe/stream fold proves the run is over cap.
  const graceDeadlineMono =
    args.kind === "attach" ? startedMono + Math.min(MIN_RESUMED_CAP_WINDOW_MS, cap) : startedMono;
  const streamAnchorMs = args.serverCreatedAtMs;

  let handle: AgentRunHandle | undefined;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let armedAtMono = startedMono;
  let armedDelayMs = Math.min(windowMs, MAX_TIMER_DELAY_MS);
  let rearms = 0;
  let unreachableCount = 0;
  let attachProbeRetries = 0;
  let pendingStepSuspectMs = 0;
  let probeInFlight = false;
  let attachRetryTimer: ReturnType<typeof setTimeout> | undefined;
  const floorSamples: FloorSample[] = [];
  // Trusted-mono floor term — accumulated corroborated segments; never ages
  // (the in-flight segment stays uncounted until its fire classifies it).
  let trustedMonoAgeMs = 0;
  let lastWallSample = wallNow();
  let lastMonoSample = startedMono;
  let latestEventAtMs: number | undefined;

  const capHooks: DurationCapHandle = {
    onDiscontinuitySample: (wallMs, monoMs) => {
      if (settled) return;
      const wallDelta = wallMs - lastWallSample;
      const monoDelta = monoMs - lastMonoSample;
      lastWallSample = wallMs;
      lastMonoSample = monoMs;
      if (wallDelta - monoDelta <= DISCONTINUITY_THRESHOLD_MS) return;
      handleEarlyEvidence("discontinuity");
    },
    onProviderStreamEvent: (eventAtMs) => {
      if (settled) return;
      latestEventAtMs = eventAtMs;
      foldStreamSignals();
      evaluateDecisionPoint();
    },
  };
  args.onCapReady?.(capHooks);

  let resolveCap!: (result: AgentRunResult) => void;
  let rejectCap!: (err: unknown) => void;
  const capExpiry = new Promise<AgentRunResult>((resolve, reject) => {
    resolveCap = resolve;
    rejectCap = reject;
  });

  const settleExpired = (preHandle: boolean): void => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    const floor = floorNow(monotonicNow());
    const reportedMs = Math.max(cap, Math.max(seedMs + windowMs, floor));
    args.log?.warn(
      {
        floor,
        maxRunDurationMs: cap,
        preHandle,
        seedMs,
        windowMs,
      },
      "policy.maxRunDurationMs exceeded; cancelling run",
    );
    if (preHandle) {
      rejectCap(new CursorRunStartTimedOutError(windowMs));
      return;
    }
    resolveCap(capExceededResult(reportedMs, cap));
    if (handle !== undefined) cancelBestEffort(handle);
  };

  const evaluateDecisionPoint = (): boolean => {
    if (settled) return true;
    const nowMono = monotonicNow();
    if (floorNow(nowMono) >= cap && nowMono >= graceDeadlineMono) {
      settleExpired(handle === undefined);
      return true;
    }
    // Budget exhaustion expires only via a served timer fire (rule 2's
    // second condition) — never at a fold. A fold-time deadline check runs
    // on microtask boundaries and could beat a result that is already
    // resolving, turning a settled race into a synthetic failure.
    if (unreachableCount >= CAP_PROBE_FAIL_CLOSED_AFTER && wallAgeMs(args, wallNow()) >= cap) {
      settleExpired(handle === undefined);
      return true;
    }
    if (rearms >= MAX_CAP_REARMS) {
      settleExpired(handle === undefined);
      return true;
    }
    return settled;
  };

  const rederiveAndRearm = (): void => {
    if (settled) return;
    const nowMono = monotonicNow();
    const floor = floorNow(nowMono);
    const windowRemainingMs = windowDeadlineMono - nowMono;
    const capRemainderMs = Math.max(0, cap - floor);
    let nextDelay = Math.min(windowRemainingMs, capRemainderMs);
    // Over-cap evidence inside the attach grace shrinks to the grace
    // boundary rather than expiring — the result still gets its race.
    if (nextDelay <= 0 && nowMono < graceDeadlineMono) {
      nextDelay = graceDeadlineMono - nowMono;
    }
    if (nextDelay <= 0) {
      settleExpired(handle === undefined);
      return;
    }
    armedAtMono = nowMono;
    armedDelayMs = Math.min(nextDelay, MAX_TIMER_DELAY_MS);
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(onCapTimer, armedDelayMs);
  };

  const foldStreamSignals = (): void => {
    foldRemoteStreamAge({
      floorSamples,
      getLiveness: () => args.signals?.getLiveness?.() ?? readHandleLiveness(handle),
      monotonicNow,
      ...(streamAnchorMs !== undefined && { anchorMs: streamAnchorMs }),
      ...(latestEventAtMs !== undefined && { latestEventAtMs }),
    });
  };

  const foldProbeResult = (probe: AgentRunProbeResult): void => {
    const created = probe.createdAtMs;
    const updated = probe.updatedAtMs;
    if (created === undefined || updated === undefined || updated < created) return;
    const ageMs = updated - created;
    foldSample(ageMs, monotonicNow());
    if (ageMs < cap) {
      rearms = 0;
      unreachableCount = 0;
    }
  };

  const maybeRearm = (): void => {
    if (settled) return;
    rederiveAndRearm();
  };

  const noteProbeMiss = (
    shouldAdjudicate: boolean,
    suspectMs: number,
    attachProbe: boolean,
  ): void => {
    if (!attachProbe) unreachableCount += 1;
    if (shouldAdjudicate && suspectMs > 0) chargeStepSuspectAsServed();
    evaluateDecisionPoint();
  };

  const resolveProbeAnswer = (
    probe: AgentRunProbeResult | undefined,
    shouldAdjudicate: boolean,
    suspectMs: number,
    attachProbe: boolean,
  ): void => {
    if (settled) return;
    probeInFlight = false;
    if (probe === undefined) {
      noteProbeMiss(shouldAdjudicate, suspectMs, attachProbe);
      return;
    }
    const created = probe.createdAtMs;
    const updated = probe.updatedAtMs;
    if (created === undefined || updated === undefined) {
      noteProbeMiss(shouldAdjudicate, suspectMs, attachProbe);
      return;
    }
    pendingStepSuspectMs = 0;
    foldProbeResult(probe);
    if (evaluateDecisionPoint()) return;
    maybeRearm();
  };

  const probeTargets = ():
    | { agentId: string; runId: string; probeFn: NonNullable<DurationCapSignals["probeRun"]> }
    | undefined => {
    const probeFn = args.signals?.probeRun;
    const agentId = handle?.agentId ?? args.probeAgentId;
    const runId = handle?.runId ?? args.probeRunId;
    if (probeFn === undefined || agentId === undefined || runId === undefined) return undefined;
    return { agentId, probeFn, runId };
  };

  const dispatchProbe = (
    shouldAdjudicate: boolean,
    suspectMs: number,
    attachProbe: boolean,
  ): void => {
    const targets = probeTargets();
    if (targets === undefined) return;
    probeInFlight = true;
    void probeWithTimeout(targets.probeFn, {
      agentId: targets.agentId,
      runId: targets.runId,
    }).then(
      (probe) => {
        resolveProbeAnswer(probe, shouldAdjudicate, suspectMs, attachProbe);
      },
      () => {
        resolveProbeAnswer(undefined, shouldAdjudicate, suspectMs, attachProbe);
      },
    );
  };

  const fireProbe = (reason: string, adjudicateStepSuspect: boolean): void => {
    if (settled || probeInFlight) return;
    const suspectMs = pendingStepSuspectMs;
    const attachProbe = reason === "attach" || reason === "attach-retry";
    if (probeTargets() === undefined) {
      if (adjudicateStepSuspect && suspectMs > 0) chargeStepSuspectAsServed();
      return;
    }
    dispatchProbe(adjudicateStepSuspect, suspectMs, attachProbe);
  };

  const chargeStepSuspectAsServed = (): void => {
    if (pendingStepSuspectMs <= 0) return;
    foldMonoDelta(pendingStepSuspectMs);
    pendingStepSuspectMs = 0;
    evaluateDecisionPoint();
    maybeRearm();
  };

  const handleEarlyEvidence = (reason: string): void => {
    if (settled) return;
    foldMonoDelta(Math.max(0, monotonicNow() - armedAtMono));
    foldStreamSignals();
    if (evaluateDecisionPoint()) return;
    // Every early re-arm spends the backstop budget, probe or no probe —
    // otherwise a frozen monotonic clock during a hung start re-arms forever
    // and the workflow never reaches CursorRunStartTimedOutError.
    rearms += 1;
    if (probeTargets() !== undefined) fireProbe(reason, false);
    rederiveAndRearm();
  };

  const onServedFire = (nowMono: number, monoDelta: number, windowRemainingMs: number): void => {
    foldMonoDelta(monoDelta);
    foldStreamSignals();
    if (evaluateDecisionPoint()) return;
    if (windowRemainingMs <= 0) {
      settleExpired(handle === undefined);
      return;
    }
    const floor = floorNow(nowMono);
    if (floor >= cap && nowMono >= graceDeadlineMono) {
      settleExpired(handle === undefined);
      return;
    }
    armedAtMono = nowMono;
    const floorRemainder = floor >= cap ? graceDeadlineMono - nowMono : cap - floor;
    armedDelayMs = Math.min(windowRemainingMs, Math.max(1, floorRemainder), MAX_TIMER_DELAY_MS);
    timer = setTimeout(onCapTimer, armedDelayMs);
  };

  const onCapTimer = (): void => {
    if (settled) return;
    const nowMono = monotonicNow();
    const monoDelta = nowMono - armedAtMono;
    const windowRemainingMs = windowDeadlineMono - nowMono;
    const fireKind = classifyTimerFire(monoDelta, armedDelayMs);

    if (fireKind === "served") {
      onServedFire(nowMono, monoDelta, windowRemainingMs);
      return;
    }

    if (fireKind === "early") {
      handleEarlyEvidence("early-fire");
      return;
    }

    // Late / step-suspect
    pendingStepSuspectMs = armedDelayMs;
    foldStreamSignals();
    if (evaluateDecisionPoint()) return;
    rearms += 1;
    if (probeTargets() === undefined) {
      // No adjudicator at all: charge the suspect segment as served so
      // repeated stalls cannot defer the cap indefinitely. The charge
      // re-evaluates and re-arms internally.
      chargeStepSuspectAsServed();
      return;
    }
    fireProbe("late-fire", true);
    rederiveAndRearm();
  };

  function foldSample(ageMs: number, atMono: number): void {
    if (ageMs < 0) return;
    floorSamples.push({ ageMs, foldedAtMono: atMono });
  }

  // Trusted-mono time is its own non-aging floor term. Server-anchored
  // samples already age by mono-since-fold in `floorNow`; compounding the
  // mono delta into a new sample on top of `floorNow()` would double-count
  // the same interval and over-cancel young runs.
  function foldMonoDelta(deltaMs: number): void {
    if (deltaMs <= 0) return;
    trustedMonoAgeMs += deltaMs;
  }

  function floorNow(nowMono: number): number {
    let maxAge = trustedMonoAgeMs;
    for (const sample of floorSamples) {
      const aged = sample.ageMs + Math.max(0, nowMono - sample.foldedAtMono);
      if (aged > maxAge) maxAge = aged;
    }
    return maxAge;
  }

  const scheduleAttachProbeRetry = (): void => {
    if (settled || args.kind !== "attach") return;
    if (seedMs > 0 || args.rowCreatedAtWallMs !== undefined) return;
    if (attachProbeRetries >= CAP_PROBE_FAIL_CLOSED_AFTER) return;
    attachProbeRetries += 1;
    attachRetryTimer = setTimeout(() => {
      fireProbe("attach-retry", false);
      if (!settled) scheduleAttachProbeRetry();
    }, ATTACH_PROBE_RETRY_MS);
  };

  try {
    void capExpiry.catch(() => {
      /* swallow late loser rejection */
    });
    timer = setTimeout(onCapTimer, armedDelayMs);

    if (args.kind === "attach") {
      fireProbe("attach", false);
      scheduleAttachProbeRetry();
    }

    const terminal = args.start().then((h) => {
      if (settled) {
        cancelBestEffort(h);
        return capExceededResult(Math.max(cap, seedMs + windowMs), cap);
      }
      handle = h;
      args.onHandle(h);
      return h.result;
    });
    void terminal.catch(() => {
      /* swallow late loser rejection */
    });

    return await Promise.race([terminal, capExpiry]);
  } finally {
    // A settled race retires the cap entirely: late-arriving hooks
    // (discontinuity samples, stream folds, in-flight probe resolutions,
    // attach retries) must not re-arm timers or cancel a completed run.
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    if (attachRetryTimer !== undefined) clearTimeout(attachRetryTimer);
  }
}

function foldRemoteStreamAge(args: {
  readonly anchorMs?: number;
  readonly latestEventAtMs?: number;
  readonly getLiveness: () => AgentRunLiveness | undefined;
  readonly monotonicNow: () => number;
  readonly floorSamples: FloorSample[];
}): void {
  const liveness = args.getLiveness();
  const anchor = args.anchorMs ?? liveness?.createdAtMs ?? args.latestEventAtMs;
  const lastEvent = liveness?.lastEventAtMs ?? args.latestEventAtMs;
  if (anchor === undefined || lastEvent === undefined) return;
  if (lastEvent < anchor) return;
  args.floorSamples.push({ ageMs: lastEvent - anchor, foldedAtMono: args.monotonicNow() });
}

function classifyTimerFire(monoDelta: number, armedDelayMs: number): TimerFireKind {
  if (monoDelta + FIRE_CLASSIFIER_SLACK_MS < armedDelayMs) return "early";
  if (monoDelta > armedDelayMs + FIRE_CLASSIFIER_SLACK_MS) return "late";
  return "served";
}

function resolveSeedMs(args: DurationCapRunArgs): number {
  const elapsed = args.elapsedMs ?? 0;
  if (elapsed > 0) return elapsed;
  if (args.rowCreatedAtWallMs !== undefined) {
    const wall = args.wallClock ?? defaultWallClock;
    const derived = wall() - args.rowCreatedAtWallMs;
    if (Number.isFinite(derived) && derived > 0) return derived;
  }
  return 0;
}

function resolveWindowMs(args: DurationCapRunArgs, seedMs: number): number {
  const cap = args.maxRunDurationMs;
  const graceMs = Math.min(MIN_RESUMED_CAP_WINDOW_MS, cap);
  if (args.kind !== "attach") return cap;
  if (seedMs > 0) return Math.max(cap - seedMs, graceMs);
  if (args.rowCreatedAtWallMs !== undefined) {
    const wall = args.wallClock ?? defaultWallClock;
    const derived = wall() - args.rowCreatedAtWallMs;
    if (Number.isFinite(derived) && derived > 0) {
      return Math.max(cap - derived, graceMs);
    }
  }
  return graceMs;
}

function capWindowMs(maxRunDurationMs: number, elapsedMs: number): number {
  if (elapsedMs <= 0) return maxRunDurationMs;
  const graceMs = Math.min(MIN_RESUMED_CAP_WINDOW_MS, maxRunDurationMs);
  return Math.max(maxRunDurationMs - elapsedMs, graceMs);
}

function wallAgeMs(args: DurationCapRunArgs, wallMs: number): number {
  const startedWall = parseStartedWallMs(args);
  if (startedWall === undefined) return 0;
  return Math.max(0, wallMs - startedWall);
}

function parseStartedWallMs(args: DurationCapRunArgs): number | undefined {
  const elapsed = args.elapsedMs ?? 0;
  if (elapsed > 0) {
    const wall = args.wallClock ?? defaultWallClock;
    return wall() - elapsed;
  }
  return args.rowCreatedAtWallMs;
}

function readHandleLiveness(handle: AgentRunHandle | undefined): AgentRunLiveness | undefined {
  if (handle?.liveness === undefined) return undefined;
  return handle.liveness();
}

async function probeWithTimeout(
  probeRun: (args: AgentRunProbeArgs) => Promise<AgentRunProbeResult | undefined>,
  args: AgentRunProbeArgs,
): Promise<AgentRunProbeResult | undefined> {
  return await Promise.race([
    probeRun(args),
    new Promise<undefined>((resolve) => {
      setTimeout(() => {
        resolve(undefined);
      }, PROBE_TIMEOUT_MS);
    }),
  ]);
}

function cancelBestEffort(handle: AgentRunHandle): void {
  handle.cancel().catch(() => {
    /* swallow */
  });
}

function capExceededResult(durationMs: number, floorCapMs?: number): AgentRunResult {
  const reported = floorCapMs !== undefined ? Math.max(durationMs, floorCapMs) : durationMs;
  return {
    branches: [],
    durationMs: reported,
    errorMessage:
      "run exceeded policy.maxRunDurationMs; ship requested an SDK-run cancel (best-effort)",
    status: "failed",
  };
}

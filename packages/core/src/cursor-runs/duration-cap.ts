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
import type { FailureCategory } from "@ship/workflow";

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

/**
 * Fallback inactivity window when `policy.inactivityTimeoutMs` is absent
 * (a historical `policy_json` blob written before the field existed). Matches
 * `DEFAULT_WORKFLOW_POLICY.inactivityTimeoutMs`: 30 min of *zero* agent events
 * is a strong stall signal, while a healthy agent emits far more often and
 * never trips it regardless of total wall-clock.
 */
export const DEFAULT_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

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
  /**
   * `policy.maxRunDurationMs` for this run — the absolute wall-clock backstop
   * (measured monotonically). The primary liveness cap is
   * `inactivityTimeoutMs`; this only bounds a chatty-but-runaway agent.
   */
  readonly maxRunDurationMs: number;
  /**
   * `policy.inactivityTimeoutMs` — the primary liveness cap for local runs:
   * how long the run may go with *no agent events* before it is cancelled as a
   * stall. Reset on every `onProviderStreamEvent`. Absent → the local path
   * falls back to `DEFAULT_INACTIVITY_TIMEOUT_MS`. Ignored on the remote path,
   * which drives liveness off server-anchored probes / stream age instead.
   */
  readonly inactivityTimeoutMs?: number;
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
    return wholeMillisecondDuration(await runLocalDurationCap(args));
  }
  return wholeMillisecondDuration(await runRemoteDurationCap(args));
}

/**
 * Round the terminal result's durationMs to a whole millisecond. Every
 * dispatched runner (claude / cursor / codex, local + remote) resolves through
 * `runWithDurationCap` before service.ts writes `result.json` and persists
 * `cursor_runs.duration_ms`. SDKs report fractional wall time, but that value
 * flows into the integer `duration_ms` column AND the MCP `runDurationMs`
 * `.int()` diagnostics schema (read back from `result.json` for failed runs) —
 * a fraction fails both. Normalizing here, at the single choke point, keeps
 * every per-runner source honest without patching each terminal map. A negative
 * stays as-is so it still fails the store's nonnegative guard and rolls back.
 */
function wholeMillisecondDuration(result: AgentRunResult): AgentRunResult {
  if (result.durationMs === undefined || result.durationMs < 0) {
    return result;
  }
  const rounded = Math.round(result.durationMs);
  if (rounded === result.durationMs) {
    return result;
  }
  return { ...result, durationMs: rounded };
}

function hasRemoteSignals(args: DurationCapRunArgs): boolean {
  return args.signals?.probeRun !== undefined || args.signals?.getLiveness !== undefined;
}

// The stall verdict a fired inactivity watchdog carries. Reusing the
// running-tool collapse category (rather than minting a new literal) keeps the
// classifier's tombstone set stable while still reflecting a stall: a run that
// goes silent has almost always wedged on a never-completing tool_call, the
// exact failure `agent-collapse-on-running-tool` names (cross-ref
// `classify-failure.ts` `lastRunningToolCall`).
const INACTIVITY_STALL_CATEGORY: FailureCategory = "agent-collapse-on-running-tool";

async function runLocalDurationCap(args: DurationCapRunArgs): Promise<AgentRunResult> {
  const elapsedMs = args.elapsedMs ?? 0;
  const windowMs = capWindowMs(args.maxRunDurationMs, elapsedMs);
  const inactivityMs = args.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
  const monotonicNow = args.monotonicClock ?? defaultMonotonicClock;
  const startedMono = monotonicNow();
  const cap = new LocalCap({ args, elapsedMs, inactivityMs, monotonicNow, startedMono, windowMs });
  args.onCapReady?.(cap.hooks);

  try {
    void cap.expiry.catch(() => {
      /* swallow late loser rejection */
    });

    const terminal = args.start().then((h) => {
      if (cap.settled) {
        cancelBestEffort(h);
        return capExceededResult(elapsedMs + windowMs);
      }
      cap.attachHandle(h);
      args.onHandle(h);
      return h.result;
    });
    void terminal.catch(() => {
      /* swallow late loser rejection */
    });

    return await Promise.race([terminal, cap.expiry]);
  } finally {
    cap.dispose();
  }
}

interface LocalCapArgs {
  readonly args: DurationCapRunArgs;
  readonly elapsedMs: number;
  readonly inactivityMs: number;
  readonly monotonicNow: () => number;
  readonly startedMono: number;
  readonly windowMs: number;
}

/**
 * Local-run cap: an inactivity watchdog (primary) plus a wall-clock backstop,
 * both measured on the injected monotonic clock so a host suspend / clock jump
 * re-arms rather than false-cancelling.
 *
 * - Watchdog: reset on every `onProviderStreamEvent`; fires after
 *   `inactivityMs` of real (monotonic) silence and settles a stall verdict.
 * - Backstop: fires after `windowMs` of real elapsed and settles a
 *   `timeout-near-cap` verdict — the runaway-but-chatty ceiling.
 *
 * A fire before the handle exists rejects `CursorRunStartTimedOutError`
 * instead (the SDK start call is what hung); after it, the handle is cancelled
 * best-effort and a synthetic `failed` terminal resolves.
 */
class LocalCap {
  readonly expiry: Promise<AgentRunResult>;
  readonly hooks: DurationCapHandle;
  settled = false;

  private readonly c: LocalCapArgs;
  private handle: AgentRunHandle | undefined;
  private resolveExpiry!: (result: AgentRunResult) => void;
  private rejectExpiry!: (err: unknown) => void;

  // Backstop timer state — mirrors the standalone re-validation loop.
  private backstopTimer: ReturnType<typeof setTimeout> | undefined;
  private backstopArmedAtMono: number;
  private backstopArmedDelayMs: number;
  private backstopRearms = 0;

  // Watchdog timer state — armed off the last-event monotonic stamp.
  private watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  private lastEventMono: number;
  private watchdogRearms = 0;

  constructor(c: LocalCapArgs) {
    this.c = c;
    this.backstopArmedAtMono = c.startedMono;
    this.backstopArmedDelayMs = Math.min(c.windowMs, MAX_TIMER_DELAY_MS);
    this.lastEventMono = c.startedMono;
    this.expiry = new Promise<AgentRunResult>((resolve, reject) => {
      this.resolveExpiry = resolve;
      this.rejectExpiry = reject;
    });
    this.hooks = {
      onDiscontinuitySample: () => undefined,
      onProviderStreamEvent: () => {
        this.noteActivity();
      },
    };
    this.backstopTimer = setTimeout(() => {
      this.onBackstopFire();
    }, this.backstopArmedDelayMs);
    this.armWatchdog(c.inactivityMs);
  }

  attachHandle(handle: AgentRunHandle): void {
    this.handle = handle;
  }

  dispose(): void {
    this.settled = true;
    if (this.backstopTimer !== undefined) clearTimeout(this.backstopTimer);
    if (this.watchdogTimer !== undefined) clearTimeout(this.watchdogTimer);
  }

  // Every agent event resets the watchdog: an actively-emitting run never
  // trips the inactivity cap regardless of total wall-clock.
  private noteActivity(): void {
    if (this.settled) return;
    this.lastEventMono = this.c.monotonicNow();
    this.watchdogRearms = 0;
    this.armWatchdog(this.c.inactivityMs);
  }

  private armWatchdog(delayMs: number): void {
    if (this.watchdogTimer !== undefined) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(
      () => {
        this.onWatchdogFire();
      },
      Math.min(delayMs, MAX_TIMER_DELAY_MS),
    );
  }

  // Inactivity watchdog fire. Re-validate against real (monotonic) silence:
  // a timer that fired early (suspend / clock jump woke it before the window
  // truly elapsed) re-arms for the remainder rather than cancelling a run
  // whose events simply haven't resumed yet.
  private onWatchdogFire(): void {
    if (this.settled) return;
    const nowMono = this.c.monotonicNow();
    const silenceMs = nowMono - this.lastEventMono;
    const remainingMs = this.c.inactivityMs - silenceMs;
    if (remainingMs > 0 && this.watchdogRearms < MAX_CAP_REARMS) {
      this.watchdogRearms += 1;
      this.armWatchdog(remainingMs);
      return;
    }
    this.c.args.log?.warn(
      { inactivityMs: this.c.inactivityMs, silenceMs, startResolved: this.handle !== undefined },
      "policy.inactivityTimeoutMs exceeded (no agent events); cancelling run as a stall",
    );
    // Stamp the actual run duration at fire time, not the backstop window —
    // this value lands in result.json / cursor_runs.durationMs diagnostics.
    this.settleExpired(
      capExceededResult(this.c.elapsedMs + (nowMono - this.c.startedMono), undefined, {
        failureCategory: INACTIVITY_STALL_CATEGORY,
      }),
      this.c.inactivityMs,
    );
  }

  // Wall-clock backstop fire. Preserves the monotonic re-validation loop: a
  // served fire that hasn't reached the window re-arms silently (a clamped
  // segment of a huge cap), a genuine misfire re-arms and spends the rearm
  // budget, and only a real window-reach (or an exhausted budget) expires.
  private onBackstopFire(): void {
    if (this.settled) return;
    const nowMono = this.c.monotonicNow();
    const realElapsed = nowMono - this.c.startedMono;
    const windowRemainingMs = this.c.windowMs - realElapsed;

    if (windowRemainingMs > 0 && nowMono - this.backstopArmedAtMono >= this.backstopArmedDelayMs) {
      this.rearmBackstop(nowMono, windowRemainingMs);
      return;
    }
    if (windowRemainingMs > 0 && this.backstopRearms < MAX_CAP_REARMS) {
      this.backstopRearms += 1;
      this.rearmBackstop(nowMono, windowRemainingMs);
      this.c.args.log?.warn(
        { realElapsed, rearms: this.backstopRearms, windowRemainingMs, windowMs: this.c.windowMs },
        "cap timer fired before real elapsed reached the window (host suspend / clock jump); re-arming",
      );
      return;
    }

    this.c.args.log?.warn(
      {
        elapsedMs: this.c.elapsedMs,
        maxRunDurationMs: this.c.args.maxRunDurationMs,
        realElapsed,
        rearms: this.backstopRearms,
        startResolved: this.handle !== undefined,
        windowMs: this.c.windowMs,
      },
      "policy.maxRunDurationMs exceeded; cancelling run",
    );
    this.settleExpired(capExceededResult(this.c.elapsedMs + this.c.windowMs));
  }

  private rearmBackstop(nowMono: number, windowRemainingMs: number): void {
    this.backstopArmedAtMono = nowMono;
    this.backstopArmedDelayMs = Math.min(windowRemainingMs, MAX_TIMER_DELAY_MS);
    this.backstopTimer = setTimeout(() => {
      this.onBackstopFire();
    }, this.backstopArmedDelayMs);
  }

  // Shared settle for both timers. A fire before the handle exists rejects
  // (the start call hung); after it, resolve the synthetic terminal and cancel
  // the live run best-effort. Idempotent via `settled`. `triggerMs` names the
  // window that actually fired (inactivity vs backstop) for the error message.
  private settleExpired(result: AgentRunResult, triggerMs?: number): void {
    if (this.settled) return;
    this.settled = true;
    if (this.handle === undefined) {
      this.rejectExpiry(new CursorRunStartTimedOutError(triggerMs ?? this.c.windowMs));
      return;
    }
    this.resolveExpiry(result);
    cancelBestEffort(this.handle);
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
    // An inverted server pair is as unusable as a missing one — it must not
    // discard a pending step-suspect segment the fold then never charges.
    if (created === undefined || updated === undefined || updated < created) {
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

interface CapExceededOverrides {
  /**
   * Pre-set classification for a stall (inactivity-watchdog) expiry. When
   * present, `finalizeSuccess` honors it verbatim instead of running the
   * duration-based classifier — a silent run has no `durationMs >= cap`
   * signal for the classifier to land `timeout-near-cap` on, so the category
   * must be stamped here. Omitted for a backstop expiry, whose
   * `durationMs >= cap` classifies `timeout-near-cap` on its own.
   */
  readonly failureCategory?: FailureCategory;
}

function capExceededResult(
  durationMs: number,
  floorCapMs?: number,
  overrides?: CapExceededOverrides,
): AgentRunResult {
  const reported = floorCapMs !== undefined ? Math.max(durationMs, floorCapMs) : durationMs;
  const category = overrides?.failureCategory;
  if (category === undefined) {
    return {
      branches: [],
      durationMs: reported,
      errorMessage:
        "run exceeded policy.maxRunDurationMs; ship requested an SDK-run cancel (best-effort)",
      status: "failed",
    };
  }
  return {
    branches: [],
    durationMs: reported,
    errorMessage:
      "run exceeded policy.inactivityTimeoutMs (no agent events); ship requested an SDK-run cancel (best-effort)",
    failureCategory: category,
    status: "failed",
  };
}

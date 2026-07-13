/**
 * Per-run background heartbeat for unattended cloud cursor runs. Keeps
 * `workflow_runs.updated_at` fresh while the SDK stream is open even when
 * no MCP client is actively polling.
 *
 * Two distinct signals flow through here, and the split is load-bearing:
 *   - the timer bumps ONLY `updated_at` (freshness — `list_workflow_runs`
 *     stale filters, orphan-resume double-attach guard, prune);
 *   - `heartbeat()`, called from the run's `onEvent`, additionally bumps
 *     `last_event_at`, the driver tick's #157 progress signal.
 * A silent-but-live run keeps its `updated_at` fresh (the timer runs) while
 * `last_event_at` freezes — so the tick sees no progress and gives up, but
 * the freshness consumers still see the run as alive. See migration 0017.
 */

import type { Store } from "@ship/store";

/** Default heartbeat cadence — tuned for `list_workflow_runs` stale filters. */
export const DEFAULT_EVENT_PUMP_INTERVAL_MS = 30_000;

export interface EventPumpOptions {
  readonly workflowRunId: string;
  readonly store: Store;
  readonly intervalMs?: number;
}

export interface EventPumpHandle {
  /**
   * Record a real agent event: bump `updated_at` AND `last_event_at`. Call
   * from the run's `onEvent` — this is what moves the driver's progress signal.
   */
  heartbeat(): void;
  /** Clear the heartbeat timer. Idempotent. */
  stop(): void;
}

export function startEventPump(opts: EventPumpOptions): EventPumpHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_EVENT_PUMP_INTERVAL_MS;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const stopInternal = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  // A store touch must not leak exceptions into Node's uncaught-exception
  // handler. The touch throws `WorkflowRunNotFoundError` when the row is
  // gone (e.g., the run was cancelled and reaped, or the store was closed
  // between the moment `handle.result` resolved and `stop()` ran). On any
  // throw, silently self-stop — the pump's job is freshness, not error
  // reporting; the run's terminal state is owned elsewhere.
  const touch = (fn: (id: string) => void): void => {
    if (stopped) return;
    try {
      fn(opts.workflowRunId);
    } catch {
      stopInternal();
    }
  };

  // Timer path: freshness only. Must NOT move `last_event_at`, or a silent
  // remote run would look like it's making progress to the driver tick.
  const tick = (): void => {
    touch((id) => {
      opts.store.touchWorkflowRunUpdatedAt(id);
    });
  };
  // Event path: real remote activity — advances the driver's progress signal.
  const heartbeat = (): void => {
    touch((id) => {
      opts.store.touchWorkflowRunEvent(id);
    });
  };

  timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }

  // Baseline at start: a fresh `updated_at` (short runs still bump once) plus
  // an initial `last_event_at` anchor, so a remote run that emits zero events
  // has a frozen-from-dispatch progress signal the tick can time out against
  // rather than a NULL that falls back to the pump-fed `updated_at`.
  heartbeat();

  return {
    heartbeat,
    stop: stopInternal,
  };
}

export function stopEventPump(handle: EventPumpHandle): void {
  handle.stop();
}

/**
 * Per-run background heartbeat for unattended cloud cursor runs. Keeps
 * `workflow_runs.updated_at` fresh while the SDK stream is open even when
 * no MCP client is actively polling.
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
  /** Bump `workflow_runs.updated_at` immediately. */
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

  // Heartbeat must not leak exceptions into Node's uncaught-exception
  // handler. `touchWorkflowRunUpdatedAt` throws `WorkflowRunNotFoundError`
  // when the row is gone (e.g., the run was cancelled and reaped, or the
  // store was closed between the moment `handle.result` resolved and
  // `stop()` ran). On any throw, silently self-stop — the pump's job is
  // freshness, not error reporting; the run's terminal state is owned
  // elsewhere.
  const heartbeat = (): void => {
    if (stopped) return;
    try {
      opts.store.touchWorkflowRunUpdatedAt(opts.workflowRunId);
    } catch {
      stopInternal();
    }
  };

  timer = setInterval(heartbeat, intervalMs);

  // Initial heartbeat at start so short-lived runs (<intervalMs) still
  // bump `updated_at` at least once. Wrapped in the same try/catch path
  // as the timer-driven heartbeat (it shares the `heartbeat` closure).
  heartbeat();

  return {
    heartbeat,
    stop: stopInternal,
  };
}

export function stopEventPump(handle: EventPumpHandle): void {
  handle.stop();
}

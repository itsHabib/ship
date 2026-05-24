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

  const heartbeat = (): void => {
    if (stopped) return;
    opts.store.touchWorkflowRunUpdatedAt(opts.workflowRunId);
  };

  timer = setInterval(heartbeat, intervalMs);

  return {
    heartbeat,
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}

export function stopEventPump(handle: EventPumpHandle): void {
  handle.stop();
}

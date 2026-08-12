/**
 * Watch the client process that launched this per-client MCP server.
 *
 * Stdio normally closes when the client exits, but a dirty parent death on
 * Windows can leave the child alive with its database handle still open. A
 * sibling cannot safely clean that up with `process.kill(pid, "SIGTERM")`:
 * Windows implements that call as a hard termination, which can cut off an
 * active local continuation before its final state is persisted. The orphaned
 * server therefore detects its own dead client and enters the normal graceful
 * shutdown path instead.
 */

import type { ProcessInspector } from "./single-instance.js";

/** Polling cadence for the original client process. */
export const CLIENT_LIVENESS_POLL_MS = 5_000;

/**
 * Start watching `clientPid`. The callback fires at most once, after the
 * original client is no longer alive. The unref'ed timer never keeps an
 * otherwise-idle server running.
 */
export function startClientLivenessWatch(
  clientPid: number,
  clientIdentity: string | undefined,
  inspector: Pick<ProcessInspector, "identity" | "isAlive">,
  onClientGone: () => void,
  intervalMs = CLIENT_LIVENESS_POLL_MS,
): NodeJS.Timeout {
  let notified = false;
  const timer = setInterval(() => {
    if (notified) return;
    const alive = inspector.isAlive(clientPid);
    const currentIdentity = alive ? inspector.identity(clientPid) : undefined;
    const sameProcess =
      alive &&
      (clientIdentity === undefined ||
        currentIdentity === undefined ||
        currentIdentity === clientIdentity);
    if (sameProcess) return;
    notified = true;
    onClientGone();
  }, intervalMs);
  timer.unref();
  return timer;
}

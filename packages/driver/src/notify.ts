/**
 * Notify command spawn — bounded stdin delivery for page-tier escalations.
 */

import { spawn } from "node:child_process";

import type { EscalationPayload, NotifyConfig } from "./types.js";

const DEFAULT_NOTIFY_TIMEOUT_MS = 30_000;

/**
 * Exec seam — spawn `command` with payload JSON on stdin. Injectable for tests;
 * production uses `node:child_process` spawn.
 */
export type NotifyExec = (command: string, payloadJson: string, timeoutMs: number) => Promise<void>;

export interface NotifyPort {
  send(payload: EscalationPayload): Promise<void>;
}

function defaultNotifyExec(command: string, payloadJson: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // Operator-configured shell command; stdin carries the payload JSON.
    // eslint-disable-next-line sonarjs/os-command -- intentional notify-hook seam
    const child = spawn(command, [], {
      shell: true,
      stdio: ["pipe", "ignore", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`notify command timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`notify command exited ${String(code)}: ${stderr}`));
    });

    // A command that exits or closes stdin before reading the payload breaks the
    // pipe (EPIPE); treat it as a delivery failure rather than crashing the driver.
    child.stdin.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`notify command stdin error: ${err.message}`));
    });

    child.stdin.write(payloadJson);
    child.stdin.end();
  });
}

/** Build a notify port from driver config; undefined config yields a no-op port. */
export function createNotifyPort(
  config: NotifyConfig | undefined,
  exec: NotifyExec = defaultNotifyExec,
): NotifyPort | undefined {
  if (config === undefined) return undefined;
  const timeoutMs = config.timeoutMs ?? DEFAULT_NOTIFY_TIMEOUT_MS;
  return {
    send: async (payload) => {
      await exec(config.command, JSON.stringify(payload), timeoutMs);
    },
  };
}

export { DEFAULT_NOTIFY_TIMEOUT_MS };

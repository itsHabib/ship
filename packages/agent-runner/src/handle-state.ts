/**
 * Shared handle/promise/cancellation state machine for SDK-backed runners.
 * Guards `terminated` / `cancelInitiated`, attaches/detaches signal listeners,
 * and funnels cancel through a single `cancelInternal` with retry-on-transient.
 */

import type { AgentRunHandle, AgentRunLiveness, AgentRunResult } from "./runner.js";

export interface SdkRunHandleCallbacks {
  readonly finalizeOk: (terminal: AgentRunResult) => void;
  readonly finalizeError: (err: unknown) => void;
  readonly detachSignalListener: () => void;
}

export interface SdkRunHandleState {
  readonly result: Promise<AgentRunResult>;
  readonly cancelInternal: () => Promise<void>;
  readonly callbacks: SdkRunHandleCallbacks;
}

/** Builds the promise + cancel machinery shared by local and cloud SDK runners. */
export function createSdkRunHandleState(args: {
  readonly signal?: AbortSignal;
  readonly cancelRun: () => Promise<void>;
}): SdkRunHandleState {
  let terminated = false;
  let cancelInitiated = false;
  let resolveResult!: (value: AgentRunResult) => void;
  let rejectResult!: (reason: unknown) => void;
  const result = new Promise<AgentRunResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  let signalListener: (() => void) | undefined;
  const detachSignalListener = (): void => {
    if (signalListener !== undefined && args.signal !== undefined) {
      args.signal.removeEventListener("abort", signalListener);
    }
    signalListener = undefined;
  };

  const cancelInternal = async (): Promise<void> => {
    if (terminated || cancelInitiated) return;
    cancelInitiated = true;
    try {
      await args.cancelRun();
    } catch {
      cancelInitiated = false;
    }
  };

  if (args.signal !== undefined) {
    if (args.signal.aborted) {
      void cancelInternal();
    } else {
      signalListener = (): void => {
        void cancelInternal();
      };
      args.signal.addEventListener("abort", signalListener, { once: true });
    }
  }

  const callbacks: SdkRunHandleCallbacks = {
    detachSignalListener,
    finalizeError: (err) => {
      if (terminated) return;
      terminated = true;
      detachSignalListener();
      rejectResult(err);
    },
    finalizeOk: (terminal) => {
      if (terminated) return;
      terminated = true;
      detachSignalListener();
      resolveResult(terminal);
    },
  };

  return { callbacks, cancelInternal, result };
}

export function buildSdkRunHandle(args: {
  readonly agentId: string;
  readonly runId: string;
  readonly state: SdkRunHandleState;
  readonly liveness?: () => AgentRunLiveness;
}): AgentRunHandle {
  return {
    agentId: args.agentId,
    cancel: args.state.cancelInternal,
    ...(args.liveness !== undefined && { liveness: args.liveness }),
    result: args.state.result,
    runId: args.runId,
  };
}

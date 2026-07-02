/**
 * Service-layer wiring for remote duration-cap signals (provider-origin
 * event filter, probe/liveness delegation, discontinuity sampling).
 */

import type { AgentEvent, AgentRunLiveness, AgentRunner } from "@ship/agent-runner";
import type { EventProjection } from "@ship/agent-runner";
import type { AgentProvider } from "@ship/workflow";

import { claudeEventProjection } from "@ship/claude-runner";
import { codexEventProjection } from "@ship/codex-runner";
import { cursorEventProjection } from "@ship/cursor-runner";

import type { DurationCapHandle, DurationCapRunArgs, DurationCapSignals } from "./duration-cap.js";

import { DEFAULT_EVENT_PUMP_INTERVAL_MS } from "./event-pump.js";

const SHIP_SYNTHESIZED_KINDS = new Set(["ship.resumed"]);

function projectionForProvider(provider: AgentProvider): EventProjection {
  if (provider === "claude") return claudeEventProjection;
  if (provider === "codex") return codexEventProjection;
  return cursorEventProjection;
}

export function providerStreamEventTimestamp(
  provider: AgentProvider,
  event: AgentEvent,
): number | undefined {
  const projection = projectionForProvider(provider);
  const kind = projection.eventKind(event);
  if (kind !== undefined && SHIP_SYNTHESIZED_KINDS.has(kind)) return undefined;
  return projection.timestamp(event);
}

export interface RemoteCapWireInput {
  readonly provider: AgentProvider;
  readonly runner: AgentRunner;
  readonly runtime: "cloud" | "rooms";
  readonly getHandle: () => { liveness?: () => AgentRunLiveness } | undefined;
}

export function buildRemoteCapSignals(input: RemoteCapWireInput): DurationCapSignals {
  const probeRun = input.runner.probeRun?.bind(input.runner);
  return {
    ...(probeRun !== undefined && { probeRun }),
    getLiveness: () => input.getHandle()?.liveness?.(),
  };
}

export function wireCapStreamFold(
  provider: AgentProvider,
  capHandle: DurationCapHandle | undefined,
  event: AgentEvent,
): void {
  if (capHandle === undefined) return;
  const ts = providerStreamEventTimestamp(provider, event);
  if (ts === undefined) return;
  capHandle.onProviderStreamEvent(ts);
}

export function startCapDiscontinuitySampler(args: {
  readonly capHandle: DurationCapHandle | undefined;
  readonly intervalMs?: number;
  readonly wallClock?: () => number;
  readonly monotonicClock?: () => number;
}): () => void {
  const wall = args.wallClock ?? (() => Date.now());
  const mono = args.monotonicClock ?? (() => performance.now());
  const intervalMs = args.intervalMs ?? DEFAULT_EVENT_PUMP_INTERVAL_MS;
  const timer = setInterval(() => {
    if (args.capHandle === undefined) return;
    args.capHandle.onDiscontinuitySample(wall(), mono());
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => {
    clearInterval(timer);
  };
}

export function isRemoteCapRuntime(runtime: string): boolean {
  return runtime === "cloud" || runtime === "rooms";
}

export type PartialDurationCapArgs = Pick<
  DurationCapRunArgs,
  | "signals"
  | "kind"
  | "wallClock"
  | "rowCreatedAtWallMs"
  | "serverCreatedAtMs"
  | "probeAgentId"
  | "probeRunId"
  | "onCapReady"
>;

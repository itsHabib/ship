/**
 * `CloudCursorRunner` — drives a Cursor cloud agent via
 * `Agent.create({ cloud: { repos, ... } })`. Mirrors `LocalCursorRunner`'s
 * pipeline shape; see phase 04 design (`04-cursor-cloud-runner.md`).
 */

import type {
  AgentOptions,
  CloudAgentOptions,
  Run,
  RunResult,
  SDKAgent,
  SDKMessage,
} from "@cursor/sdk";
import type { AgentRunProbeArgs, AgentRunProbeResult } from "@ship/agent-runner";
import type { Logger } from "@ship/logger";
import type { ArtifactRef } from "@ship/workflow";

import {
  Agent,
  CursorSdkError,
  IntegrationNotConnectedError,
  UnknownAgentError,
} from "@cursor/sdk";
import {
  AgentRunFailedError,
  agentRunFailedError,
  buildSdkRunHandle,
  createSdkRunHandleState,
  MissingApiKeyError,
} from "@ship/agent-runner";
import { isAbsolute } from "node:path";
import { inspect } from "node:util";

import type { MapRunResultOptions } from "./_shared.js";
import type {
  AgentRunAttachInput,
  AgentRunHandle,
  AgentRunInput,
  AgentRunner,
  AgentRunRefreshInput,
  AgentRunResult,
  CloudRunSpec,
} from "./runner.js";

import {
  attachInputAsRunInput,
  mapRunResult,
  MAX_CLASSIFICATION_EVENTS,
  modelArgFromInput,
} from "./_shared.js";
import { captureListedArtifacts } from "./artifacts-capture.js";
import { probeCursorCloudRun } from "./cloud-run-probe.js";
import { cursorEventProjection } from "./cursor-event-projection.js";
import { cloudDebugLog } from "./debug.js";
import {
  CursorAgentNotFoundError,
  CursorCloudIntegrationError,
  InvalidCloudReposError,
  MissingCloudSpecError,
  WrongRunnerError,
} from "./errors.js";

const API_KEY_ENV = "CURSOR_API_KEY";
const PROBE_TIMEOUT_MS = 10_000;

function isShipSynthesizedEvent(ev: SDKMessage): boolean {
  const kind = (ev as { type?: unknown }).type;
  return kind === "ship.resumed";
}

function isUnsafeCloudArtifactPath(sdkPath: string): boolean {
  return isAbsolute(sdkPath) || sdkPath.replace(/\\/g, "/").split("/").includes("..");
}

function assertSingleCloudRepo(cloudSpec: CloudRunSpec | undefined): void {
  if (cloudSpec === undefined) return;
  // Cast to a structural shape with `repos?: unknown` (NOT `unknown[]`) so
  // TypeScript accepts the conversion from the stricter `CloudRunSpec`
  // (where `repos` is a typed tuple). Tightening to `unknown[]` triggers
  // TS2352 "neither type sufficiently overlaps". The `Array.isArray` guard
  // below proves array-ness at runtime, which is what we actually need.
  const repos = (cloudSpec as { repos?: unknown }).repos;
  if (!Array.isArray(repos) || repos.length !== 1) {
    throw new InvalidCloudReposError(Array.isArray(repos) ? repos.length : 0);
  }
}

function mapAgentNotFoundError(
  err: unknown,
  input: Pick<AgentRunAttachInput, "agentId" | "runId">,
): CursorAgentNotFoundError | undefined {
  if (err instanceof UnknownAgentError) {
    return new CursorAgentNotFoundError({
      agentId: input.agentId,
      runId: input.runId,
      runtime: "cloud",
      cause: err,
    });
  }
  if (err instanceof CursorSdkError && (err.status === 404 || err.status === 410)) {
    return new CursorAgentNotFoundError({
      agentId: input.agentId,
      runId: input.runId,
      runtime: "cloud",
      cause: err,
    });
  }
  return undefined;
}

function cloudAgentOptions(spec: CloudRunSpec): CloudAgentOptions {
  return {
    repos: spec.repos.map((r) => ({
      url: r.url,
      ...(r.startingRef !== undefined && { startingRef: r.startingRef }),
      ...(r.prUrl !== undefined && { prUrl: r.prUrl }),
    })),
    workOnCurrentBranch: spec.workOnCurrentBranch ?? false,
    autoCreatePR: spec.autoCreatePR ?? true,
    ...(spec.skipReviewerRequest !== undefined && {
      skipReviewerRequest: spec.skipReviewerRequest,
    }),
    ...(spec.envVars !== undefined && { envVars: spec.envVars }),
    ...(spec.env !== undefined && { env: spec.env }),
  };
}

// Redacts envVars VALUES (keeps KEYS for diagnostic visibility) and the env
// block entirely. apiKey is excluded by construction (built separately in
// the caller), but operator-supplied envVars / env may carry secrets.
function loggableCloudOptions(opts: CloudAgentOptions): unknown {
  return {
    ...opts,
    ...(opts.envVars !== undefined && {
      envVars: Object.fromEntries(Object.keys(opts.envVars).map((k) => [k, "[redacted]"])),
    }),
    ...(opts.env !== undefined && { env: "[redacted]" }),
  };
}

function mapCloudRunResult(
  result: RunResult,
  input: AgentRunInput,
  options?: MapRunResultOptions,
): AgentRunResult {
  // Cloud-only debug telemetry. Local runs go through mapRunResult directly
  // and never reach this wrapper, preserving the SHIP_CLOUD_DEBUG-only intent.
  cloudDebugLog(input.log, "mapTerminalResult result.git", result.git);
  const cloudSpec = input.cloud;
  return mapRunResult(result, input, cloudSpec, options);
}

/** Construct once, reuse across runs. The runner holds no per-run state. */
export class CloudCursorRunner implements AgentRunner {
  async probeRun(args: AgentRunProbeArgs): Promise<AgentRunProbeResult | undefined> {
    return probeCursorCloudRun({
      agentId: args.agentId,
      runId: args.runId,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
  }

  async downloadArtifact(agentId: string, path: string): Promise<Buffer> {
    const apiKey = process.env[API_KEY_ENV];
    if (apiKey === undefined || apiKey === "") {
      throw new MissingApiKeyError(`${API_KEY_ENV} environment variable is not set`);
    }
    let agent: SDKAgent | undefined;
    try {
      agent = await Agent.resume(agentId, { apiKey });
      return await agent.downloadArtifact(path);
    } catch (err) {
      const notFound = mapAgentNotFoundError(err, { agentId, runId: "" });
      if (notFound !== undefined) {
        throw notFound;
      }
      throw new AgentRunFailedError(`downloadArtifact failed for agentId=${agentId}`, {
        cause: err,
      });
    } finally {
      if (agent !== undefined) {
        try {
          await agent[Symbol.asyncDispose]();
        } catch {
          /* swallow */
        }
      }
    }
  }

  async run(input: AgentRunInput): Promise<AgentRunHandle> {
    if (input.runtime !== "cloud") {
      throw new WrongRunnerError('CloudCursorRunner requires input.runtime === "cloud"');
    }
    if (input.cloud === undefined) {
      throw new MissingCloudSpecError();
    }
    // Runtime guard for non-TS callers; `repos` is typed as a 1-tuple for normal TS usage.
    // Reject anything that isn't a single-element array — covers JSON callers passing
    // `{ cloud: {} }` (undefined), `{ cloud: { repos: null } }`, `{ repos: [] }`, and
    // multi-repo arrays. Reaching `.length` on a non-array would throw a generic
    // TypeError; we want the typed `InvalidCloudReposError` at every entry point.
    const repos = (input.cloud as { repos?: unknown }).repos;
    if (!Array.isArray(repos) || repos.length !== 1) {
      throw new InvalidCloudReposError(Array.isArray(repos) ? repos.length : 0);
    }
    const apiKey = process.env[API_KEY_ENV];
    if (apiKey === undefined || apiKey === "") {
      throw new MissingApiKeyError(`${API_KEY_ENV} environment variable is not set`);
    }
    const { agent, sdkRun } = await this.#startAgent(apiKey, input.cloud, input);
    return this.#buildHandle(agent, sdkRun, input);
  }

  async attach(input: AgentRunAttachInput): Promise<AgentRunHandle> {
    if (input.cloud === undefined) {
      throw new MissingCloudSpecError();
    }
    assertSingleCloudRepo(input.cloud);
    const apiKey = process.env[API_KEY_ENV];
    if (apiKey === undefined || apiKey === "") {
      throw new MissingApiKeyError(`${API_KEY_ENV} environment variable is not set`);
    }
    const runInput = attachInputAsRunInput(input, "cloud");
    let agent: SDKAgent | undefined;
    try {
      agent = await Agent.resume(input.agentId, {
        apiKey,
        model: modelArgFromInput(runInput),
        ...(input.agents !== undefined && {
          agents: input.agents as NonNullable<AgentOptions["agents"]>,
        }),
        ...(input.mcpServers !== undefined && {
          mcpServers: input.mcpServers as NonNullable<AgentOptions["mcpServers"]>,
        }),
      });
      const sdkRun = await Agent.getRun(input.runId, {
        agentId: input.agentId,
        apiKey,
        runtime: "cloud",
      });
      return this.#buildHandle(agent, sdkRun, runInput, {
        shipResumed: {
          agentId: input.agentId,
          runId: input.runId,
        },
      });
    } catch (err) {
      if (agent !== undefined) {
        try {
          await agent[Symbol.asyncDispose]();
        } catch {
          /* swallow secondary dispose error */
        }
      }
      const notFound = mapAgentNotFoundError(err, input);
      if (notFound !== undefined) {
        throw notFound;
      }
      throw new AgentRunFailedError("Agent.resume or Agent.getRun failed", { cause: err });
    }
  }

  /**
   * One-shot terminal-state read. Resumes the agent, reads the run via
   * `Agent.getRun`, and returns its terminal `AgentRunResult` iff the run has
   * already finished / errored / been cancelled. A still-running run resolves
   * `undefined` — the caller leaves the persisted row for a later refresh.
   *
   * No `sdkRun.stream()`, so nothing keeps an SDK socket / event pump open past
   * the read; the agent is disposed in `finally` either way. `sdkRun.wait()` on
   * an already-terminal run resolves immediately from the fetched state, so no
   * duration cap is needed. `AgentNotFoundError` propagates so the caller can
   * finalize a definitively-gone run.
   */
  async refreshRun(input: AgentRunRefreshInput): Promise<AgentRunResult | undefined> {
    const apiKey = process.env[API_KEY_ENV];
    if (apiKey === undefined || apiKey === "") {
      throw new MissingApiKeyError(`${API_KEY_ENV} environment variable is not set`);
    }
    let agent: SDKAgent | undefined;
    try {
      agent = await Agent.resume(input.agentId, { apiKey });
      const sdkRun = await Agent.getRun(input.runId, {
        agentId: input.agentId,
        apiKey,
        runtime: "cloud",
      });
      if (sdkRun.status === "running") return undefined;
      const waitResult = await sdkRun.wait();
      const terminal = mapCloudRunResult(waitResult, this.#refreshRunInput(input));
      // Mirror #finalizeOkWithArtifacts: a harvested orphan must carry its
      // artifact refs, or listArtifacts stays empty for refresh-recovered runs.
      const artifacts = await captureCloudArtifacts(agent, input.log);
      return artifacts !== undefined ? { ...terminal, artifacts } : terminal;
    } catch (err) {
      const notFound = mapAgentNotFoundError(err, { agentId: input.agentId, runId: input.runId });
      if (notFound !== undefined) {
        throw notFound;
      }
      throw new AgentRunFailedError("Agent.resume or Agent.getRun failed on refresh", {
        cause: err,
      });
    } finally {
      if (agent !== undefined) {
        try {
          await agent[Symbol.asyncDispose]();
        } catch {
          /* swallow secondary dispose error */
        }
      }
    }
  }

  // Minimal `AgentRunInput` for `mapCloudRunResult` on the refresh path. No
  // cloud spec (so no auto-create-PR / branch warnings are derived — the driver
  // reads branches straight off the terminal result), no prompt, no cwd; the
  // mapper only reads `model` (fallback for the error path) and `onEvent` isn't
  // invoked because there is no stream.
  #refreshRunInput(input: AgentRunRefreshInput): AgentRunInput {
    return {
      cwd: "",
      model: { id: "" },
      onEvent: () => undefined,
      prompt: "",
      runtime: "cloud",
      ...(input.log !== undefined && { log: input.log }),
    };
  }

  async #startAgent(
    apiKey: string,
    cloudSpec: CloudRunSpec,
    input: AgentRunInput,
  ): Promise<{ agent: SDKAgent; sdkRun: Run }> {
    let agent: SDKAgent | undefined;
    try {
      const cloudOpts = cloudAgentOptions(cloudSpec);
      const modelArg = modelArgFromInput(input);
      cloudDebugLog(input.log, "Agent.create payload", {
        cloud: loggableCloudOptions(cloudOpts),
        model: modelArg,
      });
      agent = await Agent.create({
        apiKey,
        cloud: cloudOpts,
        model: modelArg,
        ...(input.agents !== undefined && {
          agents: input.agents as NonNullable<AgentOptions["agents"]>,
        }),
        ...(input.mcpServers !== undefined && {
          mcpServers: input.mcpServers as NonNullable<AgentOptions["mcpServers"]>,
        }),
        ...(input.agentName !== undefined && { name: input.agentName }),
      });
      const sdkRun = await agent.send(input.prompt);
      return { agent, sdkRun };
    } catch (err) {
      if (agent !== undefined) {
        try {
          await agent[Symbol.asyncDispose]();
        } catch {
          /* swallow secondary dispose error */
        }
      }
      // Stderr-dump the raw SDK error chain so cloud failures aren't
      // opaque. cloudDebugLog gates on SHIP_CLOUD_DEBUG; this always
      // fires because the cause chain is exactly what an operator needs
      // when Agent.create or agent.send throws.
      logCloudStartFailure(input.log, err, agent !== undefined);
      if (err instanceof IntegrationNotConnectedError) {
        throw new CursorCloudIntegrationError(err.provider, err.helpUrl, { cause: err });
      }
      throw new AgentRunFailedError(
        agent === undefined ? "Agent.create failed" : "agent.send failed after Agent.create",
        { cause: err },
      );
    }
  }

  #buildHandle(
    agent: SDKAgent,
    sdkRun: Run,
    input: AgentRunInput,
    opts?: {
      readonly shipResumed?: { readonly agentId: string; readonly runId: string };
    },
  ): AgentRunHandle {
    const livenessState: { createdAtMs?: number; lastEventAtMs?: number } = {};
    const createdAtMs = sdkRun.createdAt;
    if (createdAtMs !== undefined && Number.isFinite(createdAtMs)) {
      livenessState.createdAtMs = createdAtMs;
    }

    const state = createSdkRunHandleState({
      cancelRun: () => sdkRun.cancel(),
      ...(input.signal !== undefined && { signal: input.signal }),
    });

    void this.#runPipeline(agent, sdkRun, input, {
      ...state.callbacks,
      ...(opts?.shipResumed !== undefined && { shipResumed: opts.shipResumed }),
      recordProviderEvent: (ev) => {
        if (isShipSynthesizedEvent(ev)) return;
        const ts = cursorEventProjection.timestamp(ev);
        if (ts === undefined) return;
        livenessState.lastEventAtMs = ts;
        livenessState.createdAtMs ??= ts;
      },
    });

    return buildSdkRunHandle({
      agentId: agent.agentId,
      liveness: () => ({ ...livenessState }),
      runId: sdkRun.id,
      state,
    });
  }

  async #runPipeline(
    agent: SDKAgent,
    sdkRun: Run,
    input: AgentRunInput,
    callbacks: {
      finalizeOk: (terminal: AgentRunResult) => void;
      finalizeError: (err: unknown) => void;
      detachSignalListener: () => void;
      shipResumed?: { readonly agentId: string; readonly runId: string };
      recordProviderEvent?: (ev: SDKMessage) => void;
    },
  ): Promise<void> {
    const safelyEmit = (ev: SDKMessage): void => {
      try {
        const maybePromise: unknown = input.onEvent(ev);
        if (isPromiseLike(maybePromise)) {
          maybePromise.then(undefined, () => {
            /* swallow */
          });
        }
      } catch {
        /* swallow */
      }
    };

    const capturedEvents: SDKMessage[] = [];
    const recordEvent = (ev: SDKMessage): void => {
      capturedEvents.push(ev);
      if (capturedEvents.length > MAX_CLASSIFICATION_EVENTS) capturedEvents.shift();
    };
    const mapOpts = (): MapRunResultOptions => ({ events: capturedEvents });

    try {
      if (callbacks.shipResumed !== undefined) {
        const resumed = {
          type: "ship.resumed",
          ts: new Date().toISOString(),
          agentId: callbacks.shipResumed.agentId,
          runId: callbacks.shipResumed.runId,
        } as unknown as SDKMessage;
        recordEvent(resumed);
        safelyEmit(resumed);
      }
      try {
        for await (const ev of sdkRun.stream()) {
          recordEvent(ev);
          callbacks.recordProviderEvent?.(ev);
          safelyEmit(ev);
        }
      } catch (streamErr) {
        const wr = await this.#tryWait(sdkRun);
        if (wr !== undefined) {
          await this.#finalizeOkWithArtifacts(
            agent,
            mapCloudRunResult(wr, input, mapOpts()),
            input,
            callbacks,
          );
          return;
        }
        callbacks.finalizeError(
          agentRunFailedError("stream errored without a terminal RunResult", streamErr),
        );
        return;
      }

      let waitResult: RunResult;
      try {
        waitResult = await sdkRun.wait();
      } catch (waitErr) {
        callbacks.finalizeError(
          agentRunFailedError("run.wait() rejected after a clean stream", waitErr),
        );
        return;
      }
      await this.#finalizeOkWithArtifacts(
        agent,
        mapCloudRunResult(waitResult, input, mapOpts()),
        input,
        callbacks,
      );
    } finally {
      try {
        await agent[Symbol.asyncDispose]();
      } catch {
        /* swallow */
      }
      callbacks.detachSignalListener();
    }
  }

  async #tryWait(sdkRun: Run): Promise<RunResult | undefined> {
    try {
      return await sdkRun.wait();
    } catch {
      return undefined;
    }
  }

  async #finalizeOkWithArtifacts(
    agent: SDKAgent,
    terminal: AgentRunResult,
    input: AgentRunInput,
    callbacks: { finalizeOk: (terminal: AgentRunResult) => void },
  ): Promise<void> {
    const artifacts = await captureCloudArtifacts(agent, input.log);
    callbacks.finalizeOk(artifacts !== undefined ? { ...terminal, artifacts } : terminal);
  }
}

async function captureCloudArtifacts(
  agent: SDKAgent,
  log?: Logger,
): Promise<readonly ArtifactRef[] | undefined> {
  const listed = await captureListedArtifacts(() => agent.listArtifacts(), log);
  return listed.flatMap((a) => {
    if (isUnsafeCloudArtifactPath(a.path)) return [];
    return [a];
  });
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

// Stderr-dump the raw cause chain when Agent.create or agent.send
// throws. Uses util.inspect which natively traverses `Error.cause`
// chains and renders non-enumerable SDK error fields (status, code,
// endpoint) — so an operator running an L3 dry-run sees the actual
// cursor failure without spelunking. Best-effort; never throws.
function logCloudStartFailure(log: Logger | undefined, err: unknown, agentCreated: boolean): void {
  try {
    if (log === undefined) return;
    const stage = agentCreated ? "agent.send" : "Agent.create";
    // `showHidden: true` is required to render non-enumerable own
    // properties — SDK error classes commonly set fields like `status`
    // / `code` / `endpoint` via `Object.defineProperty(..., { enumerable: false })`,
    // and the whole point of this dump is exposing them.
    const dump = inspect(err, { depth: 10, showHidden: true, breakLength: 100 });
    log.error({ stage, failureCategory: "sdk-throw", err: dump }, `${stage} failed`);
  } catch {
    // swallow — diagnostic logging must never affect control flow
  }
}

/**
 * `CloudCursorRunner` — drives a Cursor cloud agent via
 * `Agent.create({ cloud: { repos, ... } })`. Mirrors `LocalCursorRunner`'s
 * pipeline shape; see phase 04 design (`04-cursor-cloud-runner.md`).
 */

import type { CloudAgentOptions, Run, RunResult, SDKAgent, SDKMessage } from "@cursor/sdk";
import type { Logger } from "@ship/logger";
import type { ArtifactRef } from "@ship/workflow";

import {
  Agent,
  CursorSdkError,
  IntegrationNotConnectedError,
  UnknownAgentError,
} from "@cursor/sdk";
import { isAbsolute } from "node:path";
import { inspect } from "node:util";

import type { MapRunResultOptions } from "./_shared.js";
import type {
  CloudRunSpec,
  CursorRunAttachInput,
  CursorRunHandle,
  CursorRunInput,
  CursorRunner,
  CursorRunResult,
} from "./runner.js";

import {
  attachInputAsRunInput,
  mapRunResult,
  MAX_CLASSIFICATION_EVENTS,
  modelArgFromInput,
} from "./_shared.js";
import { captureListedArtifacts } from "./artifacts-capture.js";
import { cloudDebugLog } from "./debug.js";
import {
  CursorAgentNotFoundError,
  CursorCloudIntegrationError,
  CursorRunFailedError,
  InvalidCloudReposError,
  MissingApiKeyError,
  MissingCloudSpecError,
  WrongRunnerError,
} from "./errors.js";

const API_KEY_ENV = "CURSOR_API_KEY";

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
  input: Pick<CursorRunAttachInput, "agentId" | "runId">,
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
  input: CursorRunInput,
  options?: MapRunResultOptions,
): CursorRunResult {
  // Cloud-only debug telemetry. Local runs go through mapRunResult directly
  // and never reach this wrapper, preserving the SHIP_CLOUD_DEBUG-only intent.
  cloudDebugLog(input.log, "mapTerminalResult result.git", result.git);
  const cloudSpec = input.cloud;
  return mapRunResult(result, input, cloudSpec, options);
}

/** Construct once, reuse across runs. The runner holds no per-run state. */
export class CloudCursorRunner implements CursorRunner {
  async downloadArtifact(agentId: string, path: string): Promise<Buffer> {
    const apiKey = process.env[API_KEY_ENV];
    if (apiKey === undefined || apiKey === "") {
      throw new MissingApiKeyError();
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
      throw new CursorRunFailedError(`downloadArtifact failed for agentId=${agentId}`, {
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

  async run(input: CursorRunInput): Promise<CursorRunHandle> {
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
      throw new MissingApiKeyError();
    }
    const { agent, sdkRun } = await this.#startAgent(apiKey, input.cloud, input);
    return this.#buildHandle(agent, sdkRun, input);
  }

  async attach(input: CursorRunAttachInput): Promise<CursorRunHandle> {
    if (input.cloud === undefined) {
      throw new MissingCloudSpecError();
    }
    assertSingleCloudRepo(input.cloud);
    const apiKey = process.env[API_KEY_ENV];
    if (apiKey === undefined || apiKey === "") {
      throw new MissingApiKeyError();
    }
    const runInput = attachInputAsRunInput(input, "cloud");
    let agent: SDKAgent | undefined;
    try {
      agent = await Agent.resume(input.agentId, {
        apiKey,
        model: modelArgFromInput(runInput),
        ...(input.agents !== undefined && { agents: input.agents }),
        ...(input.mcpServers !== undefined && { mcpServers: input.mcpServers }),
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
      throw new CursorRunFailedError("Agent.resume or Agent.getRun failed", { cause: err });
    }
  }

  async #startAgent(
    apiKey: string,
    cloudSpec: CloudRunSpec,
    input: CursorRunInput,
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
        ...(input.agents !== undefined && { agents: input.agents }),
        ...(input.mcpServers !== undefined && { mcpServers: input.mcpServers }),
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
      throw new CursorRunFailedError(
        agent === undefined ? "Agent.create failed" : "agent.send failed after Agent.create",
        { cause: err },
      );
    }
  }

  #buildHandle(
    agent: SDKAgent,
    sdkRun: Run,
    input: CursorRunInput,
    opts?: {
      readonly shipResumed?: { readonly agentId: string; readonly runId: string };
    },
  ): CursorRunHandle {
    let terminated = false;
    let cancelInitiated = false;
    let resolveResult!: (value: CursorRunResult) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<CursorRunResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    let signalListener: (() => void) | undefined;
    const detachSignalListener = (): void => {
      if (signalListener !== undefined && input.signal !== undefined) {
        input.signal.removeEventListener("abort", signalListener);
      }
      signalListener = undefined;
    };

    const cancelInternal = async (): Promise<void> => {
      if (terminated || cancelInitiated) return;
      cancelInitiated = true;
      try {
        await sdkRun.cancel();
      } catch {
        // Allow retries: a transient SDK-side failure shouldn't
        // permanently disable cancel while the run is still live.
        // Especially relevant for cloud where cancel() round-trips to the VM.
        cancelInitiated = false;
      }
    };

    if (input.signal !== undefined) {
      if (input.signal.aborted) {
        void cancelInternal();
      } else {
        signalListener = (): void => {
          void cancelInternal();
        };
        input.signal.addEventListener("abort", signalListener, { once: true });
      }
    }

    void this.#runPipeline(agent, sdkRun, input, {
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
      ...(opts?.shipResumed !== undefined && { shipResumed: opts.shipResumed }),
    });

    return {
      agentId: agent.agentId,
      cancel: cancelInternal,
      result,
      runId: sdkRun.id,
    };
  }

  async #runPipeline(
    agent: SDKAgent,
    sdkRun: Run,
    input: CursorRunInput,
    callbacks: {
      finalizeOk: (terminal: CursorRunResult) => void;
      finalizeError: (err: unknown) => void;
      detachSignalListener: () => void;
      shipResumed?: { readonly agentId: string; readonly runId: string };
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
          new CursorRunFailedError("stream errored without a terminal RunResult", {
            cause: streamErr,
          }),
        );
        return;
      }

      let waitResult: RunResult;
      try {
        waitResult = await sdkRun.wait();
      } catch (waitErr) {
        callbacks.finalizeError(
          new CursorRunFailedError("run.wait() rejected after a clean stream", {
            cause: waitErr,
          }),
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
    terminal: CursorRunResult,
    input: CursorRunInput,
    callbacks: { finalizeOk: (terminal: CursorRunResult) => void },
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

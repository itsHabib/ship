/**
 * `CloudCursorRunner` — drives a Cursor cloud agent via
 * `Agent.create({ cloud: { repos, ... } })`. Mirrors `LocalCursorRunner`'s
 * pipeline shape; see phase 04 design (`04-cursor-cloud-runner.md`).
 */

import type {
  CloudAgentOptions,
  Run,
  RunResult,
  SDKAgent,
  SDKMessage,
  ModelSelection as SdkModelSelection,
} from "@cursor/sdk";

import {
  Agent,
  CursorSdkError,
  IntegrationNotConnectedError,
  UnknownAgentError,
} from "@cursor/sdk";
import { inspect } from "node:util";

import type {
  CloudRunSpec,
  CursorRunAttachInput,
  CursorRunHandle,
  CursorRunInput,
  CursorRunner,
  CursorRunResult,
} from "./runner.js";

import { attachInputAsRunInput, mapRunResult, mapTerminalResult } from "./_shared.js";
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

function modelArgFromInput(input: CursorRunInput): SdkModelSelection {
  // Cast needed because workflow's ModelSelection accepts both string and
  // boolean param values, but the SDK's SdkModelSelection narrows to its
  // own ModelParameter shape. Empirically Cursor's cloud API REJECTS
  // boolean values with a 400 "[validation_error] Expected string,
  // received boolean" — so coerce booleans to their string form before
  // calling the SDK. The structural overlap is asserted by
  // model-selection-compat.test.ts.
  const params = input.model.params?.map((p) => ({
    id: p.id,
    value: typeof p.value === "boolean" ? String(p.value) : p.value,
  }));
  const out: SdkModelSelection = { id: input.model.id };
  if (params !== undefined) out.params = params;
  return out;
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

function mapCloudRunResult(result: RunResult, input: CursorRunInput): CursorRunResult {
  // Cloud-only debug telemetry. Local runs go through mapRunResult directly
  // and never reach this wrapper, preserving the SHIP_CLOUD_DEBUG-only intent.
  cloudDebugLog("mapTerminalResult result.git", result.git);
  const cloudSpec = input.cloud;
  // `@cursor/sdk` RunResult typings omit "expired" as of 1.0.x; cloud may still surface it.
  if (((result.status as string | undefined) ?? "").toLowerCase() === "expired") {
    return mapTerminalResult(result, "cancelled", cloudSpec);
  }
  return mapRunResult(result, input, cloudSpec);
}

/** Construct once, reuse across runs. The runner holds no per-run state. */
export class CloudCursorRunner implements CursorRunner {
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
      cloudDebugLog("Agent.create payload", {
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
      logCloudStartFailure(err, agent !== undefined);
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

    try {
      if (callbacks.shipResumed !== undefined) {
        safelyEmit({
          type: "ship.resumed",
          ts: new Date().toISOString(),
          agentId: callbacks.shipResumed.agentId,
          runId: callbacks.shipResumed.runId,
        } as unknown as SDKMessage);
      }
      try {
        for await (const ev of sdkRun.stream()) {
          safelyEmit(ev);
        }
      } catch (streamErr) {
        const wr = await this.#tryWait(sdkRun);
        if (wr !== undefined) {
          callbacks.finalizeOk(mapCloudRunResult(wr, input));
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
      callbacks.finalizeOk(mapCloudRunResult(waitResult, input));
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
function logCloudStartFailure(err: unknown, agentCreated: boolean): void {
  try {
    const stage = agentCreated ? "agent.send" : "Agent.create";
    const dump = inspect(err, { depth: 10, showHidden: false, breakLength: 100 });
    process.stderr.write(`[ship-cloud-error] ${stage} failed:\n${dump}\n`);
  } catch {
    // swallow — diagnostic logging must never affect control flow
  }
}

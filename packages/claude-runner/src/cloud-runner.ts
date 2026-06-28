/**
 * `CloudClaudeRunner` — drives a Managed Agents session via
 * `client.beta.sessions.*`. Mirrors `CloudCursorRunner`'s pipeline shape;
 * see phase 3a design (`cloud-claude-runner.md`).
 */

import type { SdkRunHandleCallbacks } from "@ship/agent-runner";

import {
  attachInputAsRunInput,
  buildSdkRunHandle,
  createSdkRunHandleState,
  MAX_CLASSIFICATION_EVENTS,
  MissingApiKeyError,
} from "@ship/agent-runner";
import { randomUUID } from "node:crypto";
import { inspect } from "node:util";

import type {
  CloudClient,
  CloudListedEvent,
  CloudStreamEvent,
  EnsureResult,
} from "./cloud-session.js";
import type { CloudTerminalState } from "./cloud-terminal-map.js";
import type {
  AgentRunAttachInput,
  AgentRunHandle,
  AgentRunInput,
  AgentRunner,
  AgentRunResult,
} from "./runner.js";

import {
  archiveOwned,
  buildClient,
  createSession,
  dispatch,
  ensureAgent,
  ensureEnvironment,
  interruptAndArchive,
  listEvents,
  openStream,
  readGitHubToken,
} from "./cloud-session.js";
import {
  detectTerminal,
  mapCloudStreamEnded,
  mapCloudStreamThrow,
  newCloudTerminalState,
} from "./cloud-terminal-map.js";
import {
  AgentRunFailedError,
  CloudSessionError,
  InvalidCloudReposError,
  MissingCloudSpecError,
  WrongRunnerError,
} from "./errors.js";

const API_KEY_ENV = "ANTHROPIC_API_KEY";
const BASE_URL_ENV = "ANTHROPIC_BASE_URL";

// The session + the agent/env this run owns (undefined on the attach path, where
// the agent/env were created by the original run and aren't re-created here).
// Bundled so the pipeline methods stay within the parameter budget.
interface SessionResources {
  readonly client: CloudClient;
  readonly sessionId: string;
  readonly agentResult?: EnsureResult | undefined;
  readonly envResult?: EnsureResult | undefined;
}

interface PipelineOpts {
  // Prior session events (attach path). Replayed through the reducer to rebuild
  // terminal state + recover a session that finished while Ship was offline,
  // and to dedup the live stream by event id. Not re-emitted to `onEvent`.
  readonly history?: readonly CloudListedEvent[];
  readonly shipResumed?: { readonly agentId: string; readonly runId: string };
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function eventId(ev: unknown): string | undefined {
  const id = (ev as { id?: string }).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function recordEvent(capturedEvents: CloudStreamEvent[], ev: CloudStreamEvent): void {
  capturedEvents.push(ev);
  if (capturedEvents.length > MAX_CLASSIFICATION_EVENTS) capturedEvents.shift();
}

// Returns true (skip) when the event id was already seen; records new ids.
function isDuplicate(seenIds: Set<string>, ev: unknown): boolean {
  const id = eventId(ev);
  if (id === undefined) return false;
  if (seenIds.has(id)) return true;
  seenIds.add(id);
  return false;
}

// Attach path: replay prior history through the reducer (rebuilding state + seeding
// dedup; not re-emitted). Returns the terminal if the session already finished
// offline, else undefined so the live stream continues from where it left off.
function replayHistory(
  history: readonly CloudListedEvent[],
  terminalState: CloudTerminalState,
  seenIds: Set<string>,
  capturedEvents: CloudStreamEvent[],
  startMs: number,
): AgentRunResult | undefined {
  for (const past of history) {
    const id = eventId(past);
    if (id !== undefined) seenIds.add(id);
    recordEvent(capturedEvents, past);
    const terminal = detectTerminal(terminalState, past, Date.now() - startMs, capturedEvents);
    if (terminal !== undefined) return terminal;
  }
  return undefined;
}

// Stderr-dump the raw cause chain when session setup fails. Best-effort; never throws.
function logCloudStartFailure(log: AgentRunInput["log"], err: unknown): void {
  try {
    if (log === undefined) return;
    const dump = inspect(err, { depth: 10, showHidden: true, breakLength: 100 });
    log.error({ failureCategory: "sdk-throw", err: dump }, "cloud session setup failed");
  } catch {
    // swallow — diagnostic logging must never affect control flow
  }
}

/** Construct once, reuse across runs. The runner holds no per-run state. */
export class CloudClaudeRunner implements AgentRunner {
  async run(input: AgentRunInput): Promise<AgentRunHandle> {
    if (input.runtime !== "cloud") {
      throw new WrongRunnerError('CloudClaudeRunner requires input.runtime === "cloud"');
    }
    if (input.cloud === undefined) {
      throw new MissingCloudSpecError();
    }
    // Runtime guard for non-TS callers: repos must be a single-element array.
    const repos = (input.cloud as { repos?: unknown }).repos;
    if (!Array.isArray(repos) || repos.length !== 1) {
      throw new InvalidCloudReposError(Array.isArray(repos) ? repos.length : 0);
    }
    const apiKey = process.env[API_KEY_ENV];
    if (apiKey === undefined || apiKey === "") {
      throw new MissingApiKeyError(`${API_KEY_ENV} environment variable is not set`);
    }

    // The UUID is only a unique suffix for the agent/env resource names; the
    // handle's runId is the session id (ED-5), set in #buildHandle.
    const runName = randomUUID();
    const resources = await this.#startSession(apiKey, input, runName);
    return this.#buildHandle(resources, input);
  }

  async attach(input: AgentRunAttachInput): Promise<AgentRunHandle> {
    const apiKey = process.env[API_KEY_ENV];
    if (apiKey === undefined || apiKey === "") {
      throw new MissingApiKeyError(`${API_KEY_ENV} environment variable is not set`);
    }

    // ED-5: the session id is the single id used for both agentId and runId.
    const sessionId = input.agentId;
    const client = buildClient(apiKey, process.env[BASE_URL_ENV]);

    let history: readonly CloudListedEvent[];
    try {
      history = await listEvents(client, sessionId);
    } catch (err) {
      throw new AgentRunFailedError(`attach: events.list failed for session ${sessionId}`, {
        cause: err,
      });
    }

    const runInput = attachInputAsRunInput(input, "cloud");
    const state = createSdkRunHandleState({
      cancelRun: () => interruptAndArchive(client, sessionId),
      ...(runInput.signal !== undefined && { signal: runInput.signal }),
    });

    void this.#runPipeline({ client, sessionId }, runInput, state.callbacks, {
      history,
      shipResumed: { agentId: sessionId, runId: input.runId },
    });

    return buildSdkRunHandle({ agentId: sessionId, runId: sessionId, state });
  }

  async #startSession(
    apiKey: string,
    input: AgentRunInput,
    runName: string,
  ): Promise<SessionResources> {
    const client = buildClient(apiKey, process.env[BASE_URL_ENV]);
    let envResult: EnsureResult | undefined;
    let agentResult: EnsureResult | undefined;
    let sessionId: string | undefined;

    try {
      envResult = await ensureEnvironment(client, { runId: runName });
      agentResult = await ensureAgent(client, { runId: runName, modelId: input.model.id });

      const pat = readGitHubToken();
      if (pat === undefined) {
        throw new Error("GH_TOKEN or GITHUB_TOKEN environment variable is not set");
      }

      const repo = input.cloud?.repos[0];
      if (repo === undefined) {
        throw new MissingCloudSpecError();
      }
      sessionId = await createSession(client, {
        agentId: agentResult.id,
        environmentId: envResult.id,
        repoUrl: repo.url,
        ...(repo.startingRef !== undefined && { startingRef: repo.startingRef }),
        pat,
      });

      await dispatch(client, sessionId, input.prompt);
    } catch (err) {
      logCloudStartFailure(input.log, err);
      await this.#cleanup({ client, sessionId: sessionId ?? "", agentResult, envResult });
      throw new CloudSessionError("cloud session setup failed", { cause: err });
    }

    return { client, sessionId, agentResult, envResult };
  }

  #buildHandle(resources: SessionResources, input: AgentRunInput): AgentRunHandle {
    const state = createSdkRunHandleState({
      cancelRun: () => interruptAndArchive(resources.client, resources.sessionId),
      ...(input.signal !== undefined && { signal: input.signal }),
    });

    void this.#runPipeline(resources, input, state.callbacks);

    // ED-5: agentId and runId are both the session id.
    return buildSdkRunHandle({
      agentId: resources.sessionId,
      runId: resources.sessionId,
      state,
    });
  }

  async #runPipeline(
    resources: SessionResources,
    input: AgentRunInput,
    callbacks: SdkRunHandleCallbacks,
    opts?: PipelineOpts,
  ): Promise<void> {
    const startMs = Date.now();
    const capturedEvents: CloudStreamEvent[] = [];
    try {
      let stream: AsyncIterable<CloudStreamEvent>;
      try {
        stream = await openStream(resources.client, resources.sessionId);
      } catch (err) {
        callbacks.finalizeOk(mapCloudStreamThrow(err, Date.now() - startMs, capturedEvents));
        return;
      }
      const terminal = await this.#consumeStream(stream, capturedEvents, input, startMs, opts);
      callbacks.finalizeOk(terminal);
    } finally {
      await this.#cleanup(resources);
      callbacks.detachSignalListener();
    }
  }

  // Consume the SSE stream to the first terminal session-status signal. Pass-through
  // every event to `onEvent` opaquely; on attach, replay history first to rebuild
  // reducer state (recovering an offline-completed session) and dedup by event id.
  async #consumeStream(
    stream: AsyncIterable<CloudStreamEvent>,
    capturedEvents: CloudStreamEvent[],
    input: AgentRunInput,
    startMs: number,
    opts?: PipelineOpts,
  ): Promise<AgentRunResult> {
    const terminalState = newCloudTerminalState();
    const seenIds = new Set<string>();
    const safelyEmit = (ev: CloudStreamEvent): void => {
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

    if (opts?.history !== undefined) {
      const fromHistory = replayHistory(
        opts.history,
        terminalState,
        seenIds,
        capturedEvents,
        startMs,
      );
      if (fromHistory !== undefined) return fromHistory;
    }

    if (opts?.shipResumed !== undefined) {
      const resumed = {
        type: "ship.resumed",
        ts: new Date().toISOString(),
        agentId: opts.shipResumed.agentId,
        runId: opts.shipResumed.runId,
      } as unknown as CloudStreamEvent;
      recordEvent(capturedEvents, resumed);
      safelyEmit(resumed);
    }

    try {
      for await (const ev of stream) {
        if (isDuplicate(seenIds, ev)) continue;
        recordEvent(capturedEvents, ev);
        safelyEmit(ev);
        const terminal = detectTerminal(terminalState, ev, Date.now() - startMs, capturedEvents);
        if (terminal !== undefined) return terminal;
      }
    } catch (streamErr) {
      return mapCloudStreamThrow(streamErr, Date.now() - startMs, capturedEvents);
    }
    return mapCloudStreamEnded(terminalState, Date.now() - startMs, capturedEvents);
  }

  // Best-effort teardown: archive the session + any agent/env this run created.
  async #cleanup(resources: SessionResources): Promise<void> {
    await archiveOwned(resources.client, {
      sessionId: resources.sessionId,
      ...(resources.agentResult !== undefined && { agentId: resources.agentResult.id }),
      ...(resources.envResult !== undefined && { environmentId: resources.envResult.id }),
      ownedAgent: resources.agentResult?.owned ?? false,
      ownedEnv: resources.envResult?.owned ?? false,
    });
  }
}

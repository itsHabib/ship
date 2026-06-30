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

import type { BranchReconstructState, GhRunner } from "./cloud-branch-reconstruct.js";
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
  branchNotFoundResult,
  buildDispatchPrompt,
  defaultGhRunner,
  newBranchReconstructState,
  reconstructBranches,
} from "./cloud-branch-reconstruct.js";
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
  readGitHubMcpUrl,
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
  // True only when this handle created the session via `run()`. Attach adopts an
  // existing session it must NOT archive on teardown — it may still be resumable.
  readonly ownsSession: boolean;
}

// Outcome of opening the live event stream. On attach a failed open is not fatal:
// the already-fetched history may carry a terminal (offline completion), so the
// open error rides along into `#consumeStream` rather than short-circuiting replay.
type StreamOpenResult =
  | { readonly stream: AsyncIterable<CloudStreamEvent> }
  | { readonly openError: unknown };

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

// Per-run accumulators threaded through the pipeline as one bag, so the consume
// helpers stay within the parameter budget. Both are fed every event (live +
// replayed history): `capturedEvents` is the bounded classification window;
// `branchState` captures the PR-create tool result for reconstruction.
interface RunAccumulators {
  readonly capturedEvents: CloudStreamEvent[];
  readonly branchState: BranchReconstructState;
}

// Attach path: replay prior history through the reducer (rebuilding state + seeding
// dedup; not re-emitted). Returns the terminal if the session already finished
// offline, else undefined so the live stream continues from where it left off.
function replayHistory(
  history: readonly CloudListedEvent[],
  terminalState: CloudTerminalState,
  seenIds: Set<string>,
  acc: RunAccumulators,
  startMs: number,
): AgentRunResult | undefined {
  for (const past of history) {
    const id = eventId(past);
    if (id !== undefined) seenIds.add(id);
    recordEvent(acc.capturedEvents, past);
    acc.branchState.observe(past);
    const terminal = detectTerminal(terminalState, past, Date.now() - startMs, acc.capturedEvents);
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
  readonly #gh: GhRunner;

  // `gh` is injectable so tests drive the fallback without shelling the host
  // binary; production omits it and gets `defaultGhRunner`.
  constructor(gh: GhRunner = defaultGhRunner) {
    this.#gh = gh;
  }

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

    void this.#runPipeline({ client, sessionId, ownsSession: false }, runInput, state.callbacks, {
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
      const githubMcpUrl = readGitHubMcpUrl();
      envResult = await ensureEnvironment(client, { runId: runName });
      agentResult = await ensureAgent(client, {
        runId: runName,
        modelId: input.model.id,
        ...(githubMcpUrl !== undefined && { githubMcpUrl }),
      });

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

      const prompt = buildDispatchPrompt(input.prompt, {
        ...(repo.prBranch !== undefined && { prBranch: repo.prBranch }),
        ...(repo.startingRef !== undefined && { baseRef: repo.startingRef }),
        githubMcpAvailable: githubMcpUrl !== undefined,
      });
      await dispatch(client, sessionId, prompt);
    } catch (err) {
      logCloudStartFailure(input.log, err);
      // run() owns what it created; archive it on setup failure (archiveSession
      // skips the empty-sessionId case where the session was never created).
      await this.#cleanup({
        client,
        sessionId: sessionId ?? "",
        agentResult,
        envResult,
        ownsSession: true,
      });
      throw new CloudSessionError("cloud session setup failed", { cause: err });
    }

    return { client, sessionId, agentResult, envResult, ownsSession: true };
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
    const acc: RunAccumulators = { capturedEvents: [], branchState: newBranchReconstructState() };
    try {
      // Capture the open outcome rather than bailing here: on attach the session
      // may have finished while Ship was offline, so `#consumeStream` must still
      // replay history (a terminal there resolves the attach as success) even when
      // the live stream failed to open.
      let open: StreamOpenResult;
      try {
        open = { stream: await openStream(resources.client, resources.sessionId) };
      } catch (err) {
        open = { openError: err };
      }
      const terminal = await this.#consumeStream(open, acc, input, startMs, opts);
      const finalResult = await this.#reconstruct(terminal, input, acc);
      callbacks.finalizeOk(finalResult);
    } finally {
      await this.#cleanup(resources);
      callbacks.detachSignalListener();
    }
  }

  // Post-terminal branch/PR reconstruction. Only an `end_turn` success with a
  // prescribed `prBranch` reconstructs `branches[]` (PRIMARY stream parse, else
  // `gh` FALLBACK); a missing branch flips the success to branch-not-found
  // FAILED. Non-success terminals and runs with no `prBranch` (the 3a / cursor
  // cloud shape) pass through unchanged.
  async #reconstruct(
    terminal: AgentRunResult,
    input: AgentRunInput,
    acc: RunAccumulators,
  ): Promise<AgentRunResult> {
    if (terminal.status !== "succeeded") return terminal;
    const repo = input.cloud?.repos[0];
    const prBranch = repo?.prBranch;
    if (repo === undefined || prBranch === undefined) return terminal;

    const reconstructed = await reconstructBranches({
      parsed: acc.branchState.result(),
      repoUrl: repo.url,
      prBranch,
      gh: this.#gh,
    });
    if (reconstructed === undefined) {
      return branchNotFoundResult(prBranch, terminal.durationMs, acc.capturedEvents);
    }
    return { ...terminal, branches: [reconstructed] };
  }

  // Drive the run to its first terminal signal. On attach: emit the synthetic
  // `ship.resumed`, then replay prior history through the reducer — a terminal there
  // recovers a session that finished offline, even if the live stream never opened.
  // Otherwise pass every live event through to `onEvent` opaquely, deduped by id.
  async #consumeStream(
    open: StreamOpenResult,
    acc: RunAccumulators,
    input: AgentRunInput,
    startMs: number,
    opts?: PipelineOpts,
  ): Promise<AgentRunResult> {
    const { capturedEvents, branchState } = acc;
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
    // Destructure once (instead of `opts?.` at each use) to keep this method's
    // branch budget; an absent `opts` (the run path) yields all-undefined fields.
    const { history, shipResumed }: PipelineOpts = opts ?? {};

    // Emit the resume signal before replaying history so downstream consumers see
    // it even on the offline-completed path (the history-terminal return is below).
    if (shipResumed !== undefined) {
      const resumed = {
        type: "ship.resumed",
        ts: new Date().toISOString(),
        agentId: shipResumed.agentId,
        runId: shipResumed.runId,
      } as unknown as CloudStreamEvent;
      recordEvent(capturedEvents, resumed);
      safelyEmit(resumed);
    }

    if (history !== undefined) {
      const fromHistory = replayHistory(history, terminalState, seenIds, acc, startMs);
      if (fromHistory !== undefined) return fromHistory;
    }

    // History held no terminal; if the live stream never opened, surface that error.
    if (!("stream" in open)) {
      return mapCloudStreamThrow(open.openError, Date.now() - startMs, capturedEvents);
    }

    try {
      for await (const ev of open.stream) {
        if (isDuplicate(seenIds, ev)) continue;
        recordEvent(capturedEvents, ev);
        branchState.observe(ev);
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
  // Attach adopts a session it doesn't own (and creates no agent/env), so it skips
  // archival entirely — a failed attach must not destroy a still-resumable session.
  async #cleanup(resources: SessionResources): Promise<void> {
    if (!resources.ownsSession) return;
    await archiveOwned(resources.client, {
      sessionId: resources.sessionId,
      ...(resources.agentResult !== undefined && { agentId: resources.agentResult.id }),
      ...(resources.envResult !== undefined && { environmentId: resources.envResult.id }),
      ownedAgent: resources.agentResult?.owned ?? false,
      ownedEnv: resources.envResult?.owned ?? false,
    });
  }
}

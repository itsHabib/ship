/**
 * `ShipService` — the workflow brain. Owns the state machine, drives
 * the cursor runner, persists artifacts, and exposes the five public
 * methods MCP server / CLI consume. Constructed via `createShipService`
 * with all collaborators DI'd (store / cursor / fs / clock / config).
 */

import type {
  AgentDefinition,
  AgentRunAttachInput,
  AgentRunHandle,
  AgentRunInput,
  AgentRunner,
  AgentRunResult,
  CloudRunSpec,
  McpServerConfig,
  RoomRunSpec,
} from "@ship/agent-runner";
import type {
  GetWorkflowRunOutput,
  RunBranchRef,
  ShipInput,
  ShipOutput,
  ShipStartOutput,
} from "@ship/mcp";
import type { ListRunsFilter, ResumableCloudCursorRun, Store } from "@ship/store";
import type {
  AgentProvider,
  ArtifactRef,
  CursorRunRef,
  CursorRunRuntime,
  FailureCategory,
  ModelSelection,
  TerminalCursorRunStatus,
  TerminalWorkflowStatus,
  WorkflowRun,
  WorkflowStatus,
  WorktreeRef,
} from "@ship/workflow";

import { AgentNotFoundError } from "@ship/agent-runner";
import {
  buildFailureDetail,
  classifyFailure,
  formatClassifiedErrorMessage,
} from "@ship/cursor-runner";
import { createLogger, type LogFields, type Logger } from "@ship/logger";
import { StoreContentionError, WorkflowRunNotFoundError } from "@ship/store";
import {
  agentNotCreatedSentinel,
  agentWatchUrl,
  CLOUD_WORKTREE_SENTINEL,
  DEFAULT_WORKFLOW_POLICY,
  isTerminal,
  newCursorRunId,
  newPhaseId,
  newWorkflowRunId,
} from "@ship/workflow";
import { basename, resolve as resolvePathAbs } from "node:path";

import type { EventWriter } from "./artifacts/ndjson.js";
import type { DurationCapHandle } from "./cursor-runs/duration-cap.js";
import type { DocSource } from "./doc-source/doc-source.js";
import type { ShipFs } from "./fs/shape.js";
import type { ValidatedDoc } from "./validate.js";
import type { CloudDocResolveOptions } from "./validate.js";

import { createNdjsonEventWriter } from "./artifacts/ndjson.js";
import {
  assertSafeCloudArtifactPath,
  DEFAULT_ARTIFACT_MAX_BYTES,
  resolveContainedCloudArtifactDest,
  resolveContainedCloudArtifactDestUnderRoot,
  resolveRunArtifactPaths,
  resolveWorktreeScratchTaskDocPath,
  type RunArtifactPaths,
} from "./artifacts/paths.js";
import { renderImplementationPrompt } from "./artifacts/prompt-template.js";
import {
  buildRemoteCapSignals,
  isRemoteCapRuntime,
  startCapDiscontinuitySampler,
  wireCapStreamFold,
} from "./cursor-runs/duration-cap-wire.js";
import { runWithDurationCap } from "./cursor-runs/duration-cap.js";
import { type EventPumpHandle, startEventPump } from "./cursor-runs/event-pump.js";
import { selectStaleOrphanResumeCandidates } from "./cursor-runs/orphan-resume.js";
import { parseGitHubRepoSlug } from "./doc-source/parse-github-url.js";
import {
  ArtifactGoneError,
  ArtifactNotInManifestError,
  ArtifactsUnavailableLocalError,
  ArtifactTooLargeError,
  ArtifactWriteFailedError,
  CloudRunnerNotConfiguredError,
  CursorRunStartTimedOutError,
  IllegalProviderRuntimeError,
  MissingRepoError,
  RoomRunnerNotConfiguredError,
  RunnerNotConfiguredError,
  WorkdirNotFoundError,
} from "./errors.js";
import { executePruneRuns, type PruneRunsInput, type PruneRunsOutput } from "./prune/prune.js";
import { resolveValidatedDoc, resolveValidatedDocForCloud } from "./validate.js";

/** Construction-time configuration for the service. */
export interface ShipServiceConfig {
  /** Absolute path of the artifacts directory (`<UserConfigDir>/ship/runs/`). */
  readonly runsDir: string;
  /** Default model when `input.model` is omitted. */
  readonly defaultModel: ModelSelection;
  /**
   * Default model for `provider: "claude"` runs when `input.model` is omitted.
   * A Cursor model id (e.g. `composer-2.5`) is not a valid Claude SDK model, so
   * claude runs resolve against this instead of `defaultModel`. Optional — the
   * production wiring sets it; a config that omits it falls back to `defaultModel`.
   */
  readonly claudeDefaultModel?: ModelSelection;
  /**
   * Default model for `provider: "codex"` runs when `input.model` is omitted.
   * A Cursor model id (e.g. `composer-2.5`) is not a valid Codex SDK model, so
   * codex runs resolve against this instead of `defaultModel`. Optional — the
   * production wiring always sets it (to `DEFAULT_CODEX_MODEL`); a raw config that
   * omits it intentionally falls back to `defaultModel`, whose id must then be
   * Codex-compatible.
   */
  readonly codexDefaultModel?: ModelSelection;
  /** Optional MCP servers passed through to every `cursor.run()` call. */
  readonly mcpServers?: Record<string, McpServerConfig>;
  /** Optional inline subagents re-passed on cloud resume per ED-5. */
  readonly agents?: Record<string, AgentDefinition>;
  /** Local/desktop runner; used when `input.runtime` is `"local"` or omitted. */
  readonly cursor: AgentRunner;
  /** Optional cloud runner; required at dispatch time only for `runtime: "cloud"`. */
  readonly cloudCursor?: AgentRunner;
  /** Optional rooms runner; required at dispatch time only for `runtime: "rooms"`. */
  readonly roomCursor?: AgentRunner;
  /** Optional claude runner; required at dispatch time only for `provider: "claude"` + `runtime: "local"`. */
  readonly claude?: AgentRunner;
  /** Optional cloud claude runner; required at dispatch time only for `provider: "claude"` + `runtime: "cloud"`. */
  readonly cloudClaude?: AgentRunner;
  /** Optional codex runner; required at dispatch time only for `provider: "codex"`. */
  readonly codex?: AgentRunner;
  /** Preflight cap for `downloadArtifact` (ED-5). Default: 100 MiB. */
  readonly artifactMaxBytes?: number;
}

/** All collaborators the service needs. Injected at construction time. */
export interface ShipServiceDeps {
  readonly store: Store;
  readonly fs: ShipFs;
  readonly clock: () => string;
  readonly config: ShipServiceConfig;
  /** Optional ID factories for deterministic tests. Default: real ULID factories. */
  readonly ids?: {
    workflowRun: () => string;
    phase: () => string;
    cursorRun: () => string;
  };
  // Shared `activeRuns` registry. When provided, the same Map is used
  // across factory constructions against the same dbPath. Omitted →
  // service creates its own private map.
  readonly activeRuns?: ActiveRunsRegistry;
  /** Remote doc source for cloud runs (local-miss path). */
  readonly docSource?: DocSource;
  /** Structured diagnostics logger; defaults to stderr JSON when omitted. */
  readonly logger?: Logger;
  /**
   * When `true`, construction eagerly runs `resumeOrphanedRuns` (mcp-server
   * boot crash recovery). Default `false` — CLI read paths must not adopt
   * sibling-process live runs.
   */
  readonly resumeOrphans?: boolean;
}

// Registry of in-flight runs. Each entry carries an `AbortController`
// whose `signal` the running service observes; `handle` is set after
// the cursor SDK call resolves so `cancelRun` can abort the in-flight
// run. Exported so default wiring can construct a single Map and
// share it across factory constructions.
export type ActiveRunsRegistry = Map<string, ActiveRun>;

/** Public service surface. CLI + MCP server code against this. */
export interface ShipService {
  ship(input: ShipInput): Promise<ShipOutput>;
  // Async kickoff for the MCP `ship` tool — persists the row, transitions
  // to `running`, schedules the cursor continuation on the next tick, and
  // resolves with `{ workflowRunId, status: "running" }`. Callers poll
  // `getRun` for terminal state. CLI keeps using `ship` (blocking).
  startShip(input: ShipInput): Promise<ShipStartOutput>;
  getRun(workflowRunId: string): Promise<GetWorkflowRunOutput | null>;
  listRuns(filter: ListRunsFilter): Promise<WorkflowRun[]>;
  cancelRun(workflowRunId: string): Promise<{ workflowRunId: string; status: WorkflowStatus }>;
  // Awaits every in-flight `startShip` background continuation to fully
  // settle (success, failure, or safety-net stderr log). Use this before
  // closing the store in tests / long-lived host processes — otherwise
  // a setImmediate continuation can race past `store.close()` and crash
  // with "database connection is not open" against the closed handle.
  // Resolves immediately if nothing is in flight.
  drainBackground(): Promise<void>;
  /**
   * Resolves once the eager startup `resumeOrphanedRuns` sweep has
   * settled — every orphaned cloud cursor row has either been re-attached
   * AND finalized (terminal state reached), short-circuited (workflow
   * was already terminal), or finalized as a resume-failure. Useful for
   * tests that want determinism + for hosts that need `listRuns` /
   * `getRun` to reflect post-resume state at t0. The sweep itself is
   * fire-and-forget at construction; this is the await handle.
   */
  resumeReady(): Promise<void>;
  /**
   * Re-attaches every orphaned cloud cursor run (`status IN ('running','pending')`)
   * left from a prior process. Idempotent via `activeRuns`. Also invoked
   * eagerly at service construction.
   */
  resumeOrphanedRuns(): Promise<void>;
  /** Returns the persisted cloud artifact manifest (DB only). */
  listArtifacts(workflowRunId: string): Promise<readonly ArtifactRef[]>;
  /** Downloads one cloud artifact to `<runsDir>/<wf>/artifacts/<path>`. */
  downloadArtifact(
    workflowRunId: string,
    path: string,
    opts?: { readonly force?: boolean; readonly outDir?: string },
  ): Promise<{ localPath: string; sizeBytes: number }>;
  /** Delete terminal runs older than `--before` plus orphan artifact dirs. */
  pruneRuns(input: PruneRunsInput): Promise<PruneRunsOutput>;
}

// Per-run entry stored in the `ActiveRunsRegistry`. `handle` is set
// after the cursor SDK call resolves and lets `cancelRun` abort the
// in-flight run.
export interface ActiveRun {
  readonly controller: AbortController;
  handle?: AgentRunHandle;
}

/** Latest cloud agent run linked from the run's phases (by `startedAt`). */
function resolveLatestCloudAgentRun(
  store: Store,
  run: WorkflowRun,
): { readonly agentId: string; readonly provider: AgentProvider } | undefined {
  let latest: CursorRunRef | undefined;
  for (const phase of run.phases) {
    const cursorRunId = phase.cursorRunId;
    if (cursorRunId === undefined) continue;
    const cursorRun = store.getCursorRun(cursorRunId);
    if (cursorRun?.runtime !== "cloud") continue;
    // Date.parse, not lexicographic >: the isoDateTime schema permits
    // non-UTC offsets, where lexical order diverges from chronological.
    if (latest === undefined || Date.parse(cursorRun.startedAt) > Date.parse(latest.startedAt)) {
      latest = cursorRun;
    }
  }
  if (latest === undefined) return undefined;
  return { agentId: latest.agentId, provider: latest.provider };
}

const DIAGNOSTIC_RECENT_EVENTS_LIMIT = 20;

interface RunDiagnosticsFields {
  readonly runDurationMs?: number;
  readonly maxRunDurationMs?: number;
  readonly sdkTerminalStatus?: string;
  readonly recentEvents?: readonly Record<string, unknown>[];
}

function parseResultJsonDiagnostics(raw: string): {
  runDurationMs?: number;
  sdkTerminalStatus?: string;
} {
  const parsed = JSON.parse(raw) as { durationMs?: number; sdkTerminalStatus?: string };
  const out: { runDurationMs?: number; sdkTerminalStatus?: string } = {};
  if (typeof parsed.durationMs === "number" && parsed.durationMs >= 0) {
    out.runDurationMs = parsed.durationMs;
  }
  if (typeof parsed.sdkTerminalStatus === "string" && parsed.sdkTerminalStatus.length > 0) {
    out.sdkTerminalStatus = parsed.sdkTerminalStatus;
  }
  return out;
}

async function readEventsDiagnostics(
  fs: ShipFs,
  eventsPath: string,
): Promise<{ recentEvents?: Record<string, unknown>[] }> {
  try {
    const recentEvents = parseRecentEventsNdjson(await fs.readFile(eventsPath, "utf-8"));
    if (recentEvents.length === 0) return {};
    return { recentEvents };
  } catch {
    return {};
  }
}

function durationMsFromImplementPhase(run: WorkflowRun): number | undefined {
  const phase = run.phases.find((p) => p.kind === "implement");
  if (phase === undefined) return undefined;
  if (phase.startedAt === undefined || phase.endedAt === undefined) return undefined;
  const ms = Date.parse(phase.endedAt) - Date.parse(phase.startedAt);
  return ms >= 0 ? ms : undefined;
}

function failureCategoryFromImplementPhase(run: WorkflowRun): FailureCategory | undefined {
  if (run.status !== "failed") return undefined;
  const phase = run.phases.find((p) => p.kind === "implement");
  return phase?.failureCategory;
}

function parseRecentEventsNdjson(ndjson: string): Record<string, unknown>[] {
  const lines = ndjson.split("\n").filter((line) => line.trim().length > 0);
  const tail = lines.slice(-DIAGNOSTIC_RECENT_EVENTS_LIMIT);
  const recentEvents: Record<string, unknown>[] = [];
  for (const line of tail) {
    try {
      recentEvents.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* skip malformed lines */
    }
  }
  return recentEvents;
}

async function readResultJsonDiagnostics(
  fs: ShipFs,
  resultPath: string,
): Promise<{ runDurationMs?: number; sdkTerminalStatus?: string }> {
  try {
    return parseResultJsonDiagnostics(await fs.readFile(resultPath, "utf-8"));
  } catch {
    return {}; // result.json may be missing on early failures
  }
}

// runDurationMs fallback when result.json didn't carry it: the persisted cursor
// run first, then the implement-phase wall time.
function fallbackRunDurationMs(store: Store, run: WorkflowRun): number | undefined {
  const cursorRunId = run.phases.find((p) => p.kind === "implement")?.cursorRunId;
  const fromStore =
    cursorRunId === undefined ? undefined : store.getCursorRun(cursorRunId)?.durationMs;
  return fromStore ?? durationMsFromImplementPhase(run);
}

async function loadRunDiagnostics(
  store: Store,
  fs: ShipFs,
  runsDir: string,
  run: WorkflowRun,
): Promise<RunDiagnosticsFields | undefined> {
  if (run.status !== "failed") return undefined;
  const paths = resolveRunArtifactPaths(runsDir, run.id);
  const out: {
    runDurationMs?: number;
    maxRunDurationMs?: number;
    sdkTerminalStatus?: string;
    recentEvents?: Record<string, unknown>[];
  } = { maxRunDurationMs: run.policy.maxRunDurationMs };

  Object.assign(out, await readResultJsonDiagnostics(fs, paths.result));

  const events = await readEventsDiagnostics(fs, paths.events);
  if (events.recentEvents !== undefined) out.recentEvents = events.recentEvents;

  if (out.runDurationMs === undefined) {
    const fallback = fallbackRunDurationMs(store, run);
    if (fallback !== undefined) out.runDurationMs = fallback;
  }

  return out;
}

/** Cloud agent identity fields derived from the latest cloud cursor_runs row. */
function enrichCloudAgentFields(
  view: GetWorkflowRunOutput,
  latestCloud: { readonly agentId: string; readonly provider: AgentProvider },
): GetWorkflowRunOutput {
  let enriched: GetWorkflowRunOutput = {
    ...view,
    agentId: latestCloud.agentId,
    provider: latestCloud.provider,
  };
  if (latestCloud.provider === "cursor") {
    enriched = { ...enriched, cursorAgentId: latestCloud.agentId };
  }
  const watchUrl = agentWatchUrl(latestCloud.provider, latestCloud.agentId);
  if (watchUrl !== undefined) {
    enriched = { ...enriched, watchUrl };
  }
  return enriched;
}

/** MCP `get_workflow_run` view: domain run plus derived cloud watch + failure diagnostics. */
async function enrichWorkflowRunView(
  deps: { readonly store: Store; readonly fs: ShipFs; readonly runsDir: string },
  run: WorkflowRun | null,
): Promise<GetWorkflowRunOutput | null> {
  if (run === null) return null;
  let view: GetWorkflowRunOutput = { ...run };
  const latestCloud = resolveLatestCloudAgentRun(deps.store, run);
  if (latestCloud !== undefined) {
    view = enrichCloudAgentFields(view, latestCloud);
  }
  const diagnostics = await loadRunDiagnostics(deps.store, deps.fs, deps.runsDir, run);
  if (diagnostics !== undefined) {
    view = {
      ...view,
      ...(diagnostics.runDurationMs !== undefined && {
        runDurationMs: diagnostics.runDurationMs,
      }),
      ...(diagnostics.maxRunDurationMs !== undefined && {
        maxRunDurationMs: diagnostics.maxRunDurationMs,
      }),
      ...(diagnostics.sdkTerminalStatus !== undefined && {
        sdkTerminalStatus: diagnostics.sdkTerminalStatus,
      }),
      ...(diagnostics.recentEvents !== undefined && {
        recentEvents: [...diagnostics.recentEvents],
      }),
    };
  }
  const branches = await loadRunBranches(deps.fs, deps.runsDir, run);
  if (branches !== undefined) {
    view = { ...view, branches };
  }
  const failureCategory = failureCategoryFromImplementPhase(run);
  if (failureCategory !== undefined) {
    view = { ...view, failureCategory };
  }
  return view;
}

// Branches a terminal run pushed (cloud + rooms), read from the persisted
// `result.json`. The runner already validated them; we re-validate the shape
// defensively since `result.json` is read from disk. Returns undefined for
// non-terminal runs and runs with no branches (e.g. local).
async function loadRunBranches(
  fs: ShipFs,
  runsDir: string,
  run: WorkflowRun,
): Promise<RunBranchRef[] | undefined> {
  if (!isTerminal(run.status)) return undefined;
  const paths = resolveRunArtifactPaths(runsDir, run.id);
  try {
    const parsed = JSON.parse(await fs.readFile(paths.result, "utf-8")) as { branches?: unknown };
    const branches = sanitizeBranches(parsed.branches);
    return branches.length > 0 ? branches : undefined;
  } catch {
    return undefined; // result.json missing / unparseable / no branches
  }
}

function sanitizeBranches(raw: unknown): RunBranchRef[] {
  if (!Array.isArray(raw)) return [];
  const out: RunBranchRef[] = [];
  for (const entry of raw) {
    const branch = toRunBranchRef(entry);
    if (branch !== undefined) out.push(branch);
  }
  return out;
}

function toRunBranchRef(entry: unknown): RunBranchRef | undefined {
  if (entry === null || typeof entry !== "object") return undefined;
  const e = entry as { repoUrl?: unknown; branch?: unknown; prUrl?: unknown };
  if (typeof e.repoUrl !== "string" || e.repoUrl === "") return undefined;
  const out: { repoUrl: string; branch?: string; prUrl?: string } = { repoUrl: e.repoUrl };
  if (typeof e.branch === "string" && e.branch !== "") out.branch = e.branch;
  if (typeof e.prUrl === "string" && e.prUrl !== "") out.prUrl = e.prUrl;
  return out;
}

export function createShipService(deps: ShipServiceDeps): ShipService {
  const { clock, config, fs, store } = deps;
  const docSource = deps.docSource;
  const logger = deps.logger ?? createLogger({ stream: process.stderr });
  const ids = deps.ids ?? {
    workflowRun: newWorkflowRunId,
    phase: newPhaseId,
    cursorRun: newCursorRunId,
  };
  const activeRuns: ActiveRunsRegistry = deps.activeRuns ?? new Map<string, ActiveRun>();
  // Tracks the un-awaited `setImmediate`-wrapped continuation Promise
  // from each `runShipStart` call. Distinct from `activeRuns`, which is
  // cleared in `runToTerminal`'s `finally` BEFORE the outer Promise
  // resolves — so `activeRuns.size` reaching 0 doesn't mean the
  // continuation is safe from a closing store. Entries auto-remove on
  // settle so a long-lived service doesn't grow this set unbounded.
  // `bgPending` stays per-`ShipService`: only `startShip` schedules
  // these un-awaited continuations, so it doesn't need to be shared
  // across services.
  const bgPending = new Set<Promise<void>>();
  const resumeBgPending = new Set<Promise<void>>();
  const makeCtx = (input: ShipInput): ShipContext => {
    const provider = input.provider ?? "cursor";
    const resolvedCursorRuntime = resolvePersistedRuntime(input);
    return {
      activeRuns,
      clock,
      config,
      fs,
      ids,
      input,
      logger,
      provider,
      resolvedCursorRuntime,
      runner: selectRunner(config, provider, resolvedCursorRuntime),
      store,
      ...(docSource !== undefined ? { docSource } : {}),
    };
  };

  const resumeCtx: ResumeContext = {
    activeRuns,
    clock,
    config,
    fs,
    logger,
    resumeBgPending,
    store,
  };

  const resumeOrphans = deps.resumeOrphans === true;
  const initialResume = resumeOrphans
    ? resumeOrphanedRunsTracked(resumeCtx).catch((err: unknown) => {
        logResumeFailure(logger, err);
      })
    : Promise.resolve();

  const service: ShipService = {
    ship: (input) => runShip(makeCtx(input)),
    startShip: (input) => runShipStart(makeCtx(input), bgPending),
    getRun: (id) => enrichWorkflowRunView({ store, fs, runsDir: config.runsDir }, store.getRun(id)),
    listRuns: (filter) => Promise.resolve(store.listRuns(filter)),
    cancelRun: (id) => {
      try {
        const active = activeRuns.get(id);
        if (active !== undefined) {
          active.controller.abort();
        }
        const row = store.cancelRun(id);
        return Promise.resolve({ status: row.status, workflowRunId: id });
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },
    drainBackground: async () => {
      // Snapshot first — a continuation that completes while we await
      // can call into `bgPending.delete`, which is fine, but iterating
      // a mutating Set isn't. `allSettled` because we don't want one
      // rejection to mask the rest still in flight.
      await Promise.allSettled([...bgPending, ...resumeBgPending]);
    },
    resumeOrphanedRuns: () => resumeOrphanedRunsTracked(resumeCtx),
    resumeReady: () => initialResume,
    // Promise.resolve().then() defers the sync call into a microtask so any
    // throw from listArtifactsFromStore becomes a rejection, not a sync throw.
    listArtifacts: (workflowRunId) =>
      Promise.resolve().then(() => listArtifactsFromStore(store, workflowRunId)),
    downloadArtifact: (workflowRunId, path, opts) =>
      downloadArtifactImpl({ config, fs, store }, workflowRunId, path, opts),
    pruneRuns: (input) =>
      executePruneRuns({
        before: input.before,
        runsDir: config.runsDir,
        store,
        ...(input.dryRun === true ? { dryRun: true } : {}),
      }),
  };

  return service;
}

interface ResumeContext {
  readonly activeRuns: ActiveRunsRegistry;
  readonly clock: () => string;
  readonly config: ShipServiceConfig;
  readonly fs: ShipFs;
  readonly logger: Logger;
  readonly resumeBgPending: Set<Promise<void>>;
  readonly store: Store;
}

function logResumeFailure(logger: Logger, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ err: message }, "resumeOrphanedRuns failed");
}

interface ShipContext {
  readonly activeRuns: ActiveRunsRegistry;
  readonly clock: () => string;
  readonly config: ShipServiceConfig;
  readonly docSource?: DocSource;
  readonly fs: ShipFs;
  readonly ids: NonNullable<ShipServiceDeps["ids"]>;
  readonly input: ShipInput;
  readonly logger: Logger;
  /** Agent backend selected for this invocation (`cursor` default). */
  readonly provider: AgentProvider;
  /** Value persisted to `cursor_runs.runtime` for this invocation. */
  readonly resolvedCursorRuntime: CursorRunRuntime;
  readonly runner: AgentRunner;
  readonly store: Store;
}

// Drift assertion: keys of `ShipInput["cloud"]` (inferred from `cloudRunSpecSchema`
// in `@ship/mcp`) must match keys of `CloudRunSpec` (in `@ship/cursor-runner`).
// Catches renames or removed fields at compile time. A deeper structural check
// is blocked by readonly variance between Zod's tuple infer and the runner's
// interface; the runtime guard in `CloudCursorRunner` catches field-type drift
// at run time. mcp can't depend on cursor-runner (sibling packages); the drift
// check lives in core, which already imports both.
type _CloudKeysMatch = keyof NonNullable<ShipInput["cloud"]> extends keyof CloudRunSpec
  ? keyof CloudRunSpec extends keyof NonNullable<ShipInput["cloud"]>
    ? true
    : false
  : false;
const _cloudKeysMatch: _CloudKeysMatch = true;

// Same drift assertion for `room`: keys of `ShipInput["room"]` (inferred from
// `roomRunSpecSchema`) must match keys of `RoomRunSpec` (cursor-runner).
type _RoomKeysMatch = keyof NonNullable<ShipInput["room"]> extends keyof RoomRunSpec
  ? keyof RoomRunSpec extends keyof NonNullable<ShipInput["room"]>
    ? true
    : false
  : false;
const _roomKeysMatch: _RoomKeysMatch = true;

function resolvePersistedRuntime(input: ShipInput): CursorRunRuntime {
  if (input.runtime === "cloud") return "cloud";
  if (input.runtime === "rooms") return "rooms";
  return "local";
}

function resolveBaseDefaultModel(
  config: ShipServiceConfig,
  provider: AgentProvider,
): ModelSelection {
  const providerDefaultOverrides: Partial<Record<AgentProvider, ModelSelection | undefined>> = {
    claude: config.claudeDefaultModel,
    codex: config.codexDefaultModel,
  };
  return providerDefaultOverrides[provider] ?? config.defaultModel;
}

function selectRunner(
  config: ShipServiceConfig,
  provider: AgentProvider,
  runtime: CursorRunRuntime,
): AgentRunner {
  const matrix: Record<
    AgentProvider,
    Partial<Record<CursorRunRuntime, AgentRunner | undefined>>
  > = {
    cursor: {
      local: config.cursor,
      cloud: config.cloudCursor,
      rooms: config.roomCursor,
    },
    claude: {
      local: config.claude,
      cloud: config.cloudClaude,
    },
    codex: {
      local: config.codex,
    },
  };

  const providerRow = matrix[provider];
  const runner = providerRow[runtime];
  if (runner !== undefined) return runner;

  // A runtime key absent from the provider's row is an illegal cell (e.g.
  // claude × cloud); a present-but-undefined key is a legal cell with no runner
  // wired. Keying off presence is self-documenting and removes the ordered-guard
  // dependency the two `provider === "claude"` checks would otherwise carry.
  if (!(runtime in providerRow)) {
    throw new IllegalProviderRuntimeError(provider, runtime);
  }
  if (runtime === "cloud") {
    throw new CloudRunnerNotConfiguredError();
  }
  if (runtime === "rooms") {
    throw new RoomRunnerNotConfiguredError();
  }
  throw new RunnerNotConfiguredError(provider, runtime);
}

interface BuildAgentRunInputArgs {
  readonly ctx: ShipContext;
  readonly prep: PreparedRun;
  readonly prompt: string;
  readonly model: ModelSelection;
  readonly controller: AbortController;
  readonly onEvent: AgentRunInput["onEvent"];
  readonly runLog: Logger;
}

function buildShipAgentRunInput(args: BuildAgentRunInputArgs): AgentRunInput {
  const { ctx, prep, prompt, model, controller, onEvent, runLog } = args;
  const policy = ctx.store.getRun(prep.workflowRunId)?.policy ?? DEFAULT_WORKFLOW_POLICY;
  const base = {
    cwd: prep.effectiveWorkdir,
    prompt,
    model,
    maxRunDurationMs: policy.maxRunDurationMs,
    ...(ctx.config.mcpServers !== undefined && { mcpServers: ctx.config.mcpServers }),
    ...(ctx.config.agents !== undefined && { agents: ctx.config.agents }),
    agentName: `ship/${prep.workflowRunId}`,
    signal: controller.signal,
    onEvent,
    log: runLog,
  } as const;
  if (ctx.input.runtime === "cloud") {
    return {
      ...base,
      runtime: "cloud",
      ...(ctx.input.cloud !== undefined && {
        cloud: ctx.input.cloud as NonNullable<AgentRunInput["cloud"]>,
      }),
    };
  }
  if (ctx.input.runtime === "rooms") {
    return {
      ...base,
      runtime: "rooms",
      ...(ctx.input.room !== undefined && {
        room: ctx.input.room as NonNullable<AgentRunInput["room"]>,
      }),
    };
  }
  // Forward `runtime` through unconditionally when set; LocalCursorRunner's
  // guard rejects malformed values (e.g. "Cloud", "remote", null) at the
  // runner boundary. Dropping the field for non-"local" values would silently
  // promote a malformed input to local execution — the opposite of intent.
  if (ctx.input.runtime !== undefined) {
    return { ...base, runtime: ctx.input.runtime };
  }
  return base;
}

interface PreparedRun {
  readonly workflowRunId: string;
  readonly phaseId: string;
  readonly paths: RunArtifactPaths;
  readonly worktree: WorktreeRef;
  readonly baseRef: string;
  readonly validated: ValidatedDoc;
  readonly effectiveWorkdir: string;
  readonly repo: string;
  /** Exact scratch task-doc path ship wrote for local runs; undefined for remote. */
  readonly scratchTaskDocPath?: string;
}

// Sync `ship` body — drives the run end-to-end, blocking the caller
// until terminal state. Shares the prepareRun → markRunStarted →
// activeRuns.set scaffolding with `runShipStart`; the only difference
// is awaiting the continuation through a deferred Promise rather than
// fire-and-forgetting it. Routing both paths through the same
// `setImmediate` keeps timing semantics identical, so a future tweak
// to the kickoff window only has to land in one place.
async function runShip(ctx: ShipContext): Promise<ShipOutput> {
  const prep = await prepareRun(ctx);
  markRunStarted(ctx, prep);
  const controller = new AbortController();
  ctx.activeRuns.set(prep.workflowRunId, { controller });
  return new Promise<ShipOutput>((resolve, reject) => {
    setImmediate(() => {
      runToTerminal(ctx, prep, controller).then(resolve, reject);
    });
  });
}

// Async kickoff body for the MCP `ship` tool — same scaffolding as
// `runShip` but the continuation is un-awaited. The safety-net
// `.catch()` only fires if `finalizeFailure` itself threw (e.g. lost
// SQLite handle, unwritable artifacts dir). Under normal failures
// `runToTerminal` already routes through `finalizeFailure` and
// resolves cleanly. See `docs/features/ship-v2/phases/01-async-ship-tool.md` § ED-2.
//
// The continuation is wrapped in a tracked `bg` Promise stored in
// `bgPending` so callers can `drainBackground()` before disposing the
// store. The `bg` resolves AFTER the catch fires, which means a
// drainer's await still completes cleanly even if the safety net
// triggered — drain semantics are "settled," not "succeeded."
async function runShipStart(
  ctx: ShipContext,
  bgPending: Set<Promise<void>>,
): Promise<ShipStartOutput> {
  const prep = await prepareRun(ctx);
  markRunStarted(ctx, prep);
  const controller = new AbortController();
  // Registration happens AFTER `markRunStarted` so a failed transition
  // can't leave a stale active-runs entry behind. No concurrency
  // window opens because these three lines are on the same sync stack.
  ctx.activeRuns.set(prep.workflowRunId, { controller });
  const bg = new Promise<void>((resolve) => {
    setImmediate(() => {
      runToTerminal(ctx, prep, controller)
        .catch((err: unknown) => {
          logBackgroundFailure(ctx.logger, prep.workflowRunId, err);
        })
        .finally(() => {
          resolve();
        });
    });
  });
  bgPending.add(bg);
  void bg.finally(() => {
    bgPending.delete(bg);
  });
  return { workflowRunId: prep.workflowRunId, status: "running" };
}

async function prepareRun(ctx: ShipContext): Promise<PreparedRun> {
  // Cloud + rooms share the remote-capable doc path: no host worktree
  // required, doc resolved local-first / remote-fallback.
  if (isRemoteRuntime(ctx.input)) {
    const validated = await resolveValidatedDocForCloud(
      ctx.fs,
      ctx.input.docPath,
      buildRemoteDocResolveOptions(ctx),
    );
    return persistInitialState(ctx, validated);
  }
  if (ctx.input.workdir === undefined) {
    throw new WorkdirNotFoundError("(missing)");
  }
  const validated = await resolveValidatedDoc(ctx.fs, ctx.input.workdir, ctx.input.docPath);
  return persistInitialState(ctx, validated);
}

// Cloud and rooms both run off a remote repo URL rather than a local worktree.
function isRemoteRuntime(input: ShipInput): boolean {
  return input.runtime === "cloud" || input.runtime === "rooms";
}

// The single repo spec a remote (cloud/rooms) run targets, chosen by
// `runtime` so an allowed-but-ignored sibling field (e.g. a stray `cloud` on a
// rooms request) can't redirect doc resolution / persisted repo to the wrong
// repository. `prUrl` is cloud-only; the typed-loose return lets the rooms
// repo element (no `prUrl`) flow through the same accessor.
function remoteRepoSpec(
  input: ShipInput,
): { url: string; startingRef?: string | undefined; prUrl?: string | undefined } | undefined {
  if (input.runtime === "rooms") return input.room?.repos[0];
  return input.cloud?.repos[0];
}

function resolveRepo(input: ShipInput): string {
  if (input.repo !== undefined) return input.repo;
  const url = remoteRepoSpec(input)?.url;
  if (url !== undefined) {
    const derived = parseGitHubRepoSlug(url);
    if (derived !== undefined) return derived;
  }
  throw new MissingRepoError();
}

/** Repo slug for remote doc fetch — derived from the cloud/rooms repo URL per F3. */
function resolveDocRepoSlug(input: ShipInput): string {
  const url = remoteRepoSpec(input)?.url;
  if (url !== undefined) {
    const derived = parseGitHubRepoSlug(url);
    if (derived !== undefined) return derived;
  }
  if (input.repo !== undefined) return input.repo;
  throw new MissingRepoError();
}

function buildRemoteDocResolveOptions(ctx: ShipContext): CloudDocResolveOptions {
  const repo = remoteRepoSpec(ctx.input);
  return {
    repoSlug: resolveDocRepoSlug(ctx.input),
    ...(ctx.input.workdir !== undefined ? { workdir: ctx.input.workdir } : {}),
    ...(repo?.startingRef !== undefined ? { startingRef: repo.startingRef } : {}),
    ...(repo?.prUrl !== undefined ? { prUrl: repo.prUrl } : {}),
    ...(ctx.docSource !== undefined ? { docSource: ctx.docSource } : {}),
  };
}

// Atomic `pending → running` transition for the workflow row + initial
// phase. Called by both `runShip` and `runShipStart` after `prepareRun`
// resolves. The store-side method wraps both writes in a single SQLite
// transaction, so a failure between the two updates rolls back rather
// than leaving the run wedged at `phase=running, workflow=pending`
// with no continuation scheduled to repair it. If either write throws,
// the caller rejects and the rows stay at `pending` — which the next
// `cancelRun` / startup-sweep call can clean up cleanly.
function markRunStarted(ctx: ShipContext, prep: PreparedRun): void {
  ctx.store.markRunStarted(prep.workflowRunId, prep.phaseId, ctx.clock());
}

// Safety-net logger for `runShipStart`'s un-awaited continuation.
// Only invoked when `finalizeFailure` itself threw — durable state at
// that point is whatever finalizeFailure managed to persist before
// throwing, observable via `getRun`. stderr is the right channel: MCP
// stdio framing uses stdout for JSON-RPC, so diagnostics belong on
// stderr to avoid corrupting the wire.
interface LogRunFailedArgs {
  readonly ctx: ShipContext;
  readonly workflowRunId: string;
  readonly phase: string;
  readonly cursorRunId?: string;
  readonly terminal: TerminalWorkflowStatus;
  readonly classified?: ClassifiedFailure;
  readonly durationMs?: number;
}

function logRunFailedIfNeeded(args: LogRunFailedArgs): void {
  const { ctx, workflowRunId, phase, cursorRunId, terminal, classified, durationMs } = args;
  if (terminal !== "failed" || classified === undefined) return;
  // Carry the run-scoped fields (workflowRunId + phase) so operators can query
  // terminal failures by phase — matches the structured-field contract used by
  // the run-scoped child logger.
  ctx.logger.error(
    {
      workflowRunId,
      phase,
      ...(cursorRunId !== undefined && { cursorRunId }),
      failureCategory: classified.category,
      ...(durationMs !== undefined && { durationMs }),
    },
    "run failed",
  );
}

function logBackgroundFailure(logger: Logger, workflowRunId: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ workflowRunId, err: message }, "background continuation rejected after finalize");
}

// Guards Logger.child at the public DI boundary: a diagnostics call must never
// affect control flow. The default logger never throws here, but a custom
// injected Logger might — falling back to the root logger keeps a throwing
// child() from stranding a run in `running` before runToTerminal's guard.
function runScopedLogger(logger: Logger, fields: LogFields): Logger {
  try {
    return logger.child(fields);
  } catch {
    return logger;
  }
}

// The implement phase's `input_json`, persisted for forensics. The cloud
// spec is also read back on resume; rooms has no resume path.
function buildImplementInputJson(input: ShipInput): string {
  if (input.runtime === "cloud" && input.cloud !== undefined) {
    return JSON.stringify({ cloud: input.cloud, docPath: input.docPath });
  }
  if (input.runtime === "rooms" && input.room !== undefined) {
    return JSON.stringify({ room: input.room, docPath: input.docPath });
  }
  return JSON.stringify({ docPath: input.docPath });
}

function persistInitialState(ctx: ShipContext, validated: ValidatedDoc): PreparedRun {
  const workflowRunId = ctx.ids.workflowRun();
  const phaseId = ctx.ids.phase();
  const paths = resolveRunArtifactPaths(ctx.config.runsDir, workflowRunId);

  const repo = resolveRepo(ctx.input);
  const baseRef = ctx.input.baseRef ?? DEFAULT_WORKFLOW_POLICY.baseRef;
  // Cloud + rooms with no local checkout use the cloud-worktree sentinel.
  const remoteNoWorkdir = isRemoteRuntime(ctx.input) && ctx.input.workdir === undefined;
  const effectiveWorkdir = ctx.input.workdir ?? paths.dir;
  const worktree: WorktreeRef = remoteNoWorkdir
    ? {
        repo,
        name: CLOUD_WORKTREE_SENTINEL,
        branch: CLOUD_WORKTREE_SENTINEL,
        path: CLOUD_WORKTREE_SENTINEL,
        baseRef,
      }
    : {
        repo,
        name: ctx.input.worktreeName ?? (basename(effectiveWorkdir) || "workdir"),
        branch: ctx.input.branch ?? "(unknown)",
        path: effectiveWorkdir,
        baseRef,
      };

  // Row exists from this point — fs and runner failures resolve with
  // a persisted `failed` ShipOutput rather than throwing past `ship()`.
  ctx.store.createWorkflowRun({
    id: workflowRunId,
    repo,
    docPath: ctx.input.docPath,
    baseRef,
    worktree,
    policy: DEFAULT_WORKFLOW_POLICY,
  });
  ctx.store.appendPhase({
    id: phaseId,
    workflowRunId,
    kind: "implement",
    inputJson: buildImplementInputJson(ctx.input),
  });

  return {
    workflowRunId,
    phaseId,
    paths,
    worktree,
    baseRef,
    validated,
    effectiveWorkdir,
    repo,
    ...resolveScratchTaskDocFields(ctx.input, effectiveWorkdir, validated.absoluteDocPath),
  };
}

function resolveScratchTaskDocFields(
  input: ShipInput,
  effectiveWorkdir: string,
  absoluteDocPath: string,
): { readonly scratchTaskDocPath?: string } {
  if (isRemoteRuntime(input)) return {};
  const scratchPath = resolveWorktreeScratchTaskDocPath(effectiveWorkdir);
  // The user's docPath may already BE the scratch path — writing then deleting
  // it at cleanup would destroy their source file. No scratch copy is needed:
  // the doc is already in the worktree where the agent reads it.
  if (resolvePathAbs(scratchPath) === resolvePathAbs(absoluteDocPath)) return {};
  return { scratchTaskDocPath: scratchPath };
}

async function runToTerminal(
  ctx: ShipContext,
  prep: PreparedRun,
  controller: AbortController,
): Promise<ShipOutput> {
  // The controller is registered in `activeRuns` by the caller
  // (`runShip` / `runShipStart`) BEFORE this runs, so an early
  // `cancelRun()` arriving during `cursor.run()` startup observes the
  // entry and aborts the pre-aborted signal. `markRunStarted` has
  // already flipped the row + phase from `pending → running`; this
  // function handles fs prep, the cursor call, and finalization.

  const runLog = runScopedLogger(ctx.logger, {
    workflowRunId: prep.workflowRunId,
    phase: prep.phaseId,
  });
  let cursorRunId: string | undefined;
  let ndjson: EventWriter | undefined;
  let eventPump: EventPumpHandle | undefined;
  let stopDiscontinuitySampler: (() => void) | undefined;
  let capHandle: DurationCapHandle | undefined;
  let scratchOwned = false;

  try {
    const artifacts = await prepareArtifacts(ctx, prep);
    const prompt = artifacts.prompt;
    scratchOwned = artifacts.scratchOwned;

    // Concurrent `cancelRun()` may have flipped the workflow + phase
    // rows to `cancelled` while we were doing fs work. Bail before
    // invoking the runner — its terminal status would otherwise
    // silently overwrite the cancellation.
    if (ctx.store.getRun(prep.workflowRunId)?.status === "cancelled") {
      return finalizeAlreadyCancelled(ctx, prep);
    }

    const baseDefaultModel = resolveBaseDefaultModel(ctx.config, ctx.provider);
    const model: ModelSelection = resolveModelSelection(ctx.input, baseDefaultModel);
    ndjson = createNdjsonEventWriter(ctx.fs, prep.paths.events);
    const ndjsonRef = ndjson;

    const onEvent: AgentRunInput["onEvent"] = (ev) => {
      ndjsonRef.write(ev);
      eventPump?.heartbeat();
      wireCapStreamFold(ctx.provider, capHandle, ev);
    };

    const runInput = buildShipAgentRunInput({
      ctx,
      prep,
      prompt,
      model,
      controller,
      onEvent,
      runLog,
    });

    // The cap window opens before the runner is invoked: a stalled SDK start
    // call must not hold the workflow open past the policy cap any more than
    // a hung agent run.
    const remoteCap = isRemoteCapRuntime(ctx.resolvedCursorRuntime);
    let capHandleRef: AgentRunHandle | undefined;
    const result = await runWithDurationCap({
      log: runLog,
      maxRunDurationMs: resolveMaxRunDurationMs(ctx.store, prep.workflowRunId),
      ...(remoteCap && {
        kind: "fresh" as const,
        onCapReady: (handle) => {
          capHandle = handle;
        },
        signals: buildRemoteCapSignals({
          getHandle: () => capHandleRef,
          provider: ctx.provider,
          runner: ctx.runner,
          runtime: ctx.resolvedCursorRuntime as "cloud" | "rooms",
        }),
        wallClock: () => Date.parse(ctx.clock()),
      }),
      onHandle: (handle) => {
        capHandleRef = handle;
        // Cloud + rooms both run unattended off the async path; the timer-based
        // pump keeps `workflow_runs.updated_at` fresh while a long run is live.
        if (ctx.resolvedCursorRuntime === "cloud" || ctx.resolvedCursorRuntime === "rooms") {
          eventPump = startEventPump({ store: ctx.store, workflowRunId: prep.workflowRunId });
          stopDiscontinuitySampler = startCapDiscontinuitySampler({ capHandle });
        }
        cursorRunId = ctx.ids.cursorRun();
        const serverCreatedAtMs = handle.liveness?.().createdAtMs;
        ctx.store.recordCursorRun({
          id: cursorRunId,
          workflowRunId: prep.workflowRunId,
          agentId: handle.agentId,
          runId: handle.runId,
          runtime: ctx.resolvedCursorRuntime,
          provider: ctx.provider,
          model,
          artifactsDir: prep.paths.dir,
          ...(serverCreatedAtMs !== undefined && { createdAtMs: serverCreatedAtMs }),
        });
        // Link the phase to the cursor-run so `getRun()` consumers can
        // join phase rows back to their `cursor_runs` metadata after
        // process restart.
        ctx.store.updatePhase(prep.phaseId, { cursorRunId });
        ctx.activeRuns.set(prep.workflowRunId, { controller, handle });
      },
      start: () => ctx.runner.run(runInput),
    });
    return await finalizeSuccess({
      ctx,
      cursorRunId: assertCursorRunRecorded(cursorRunId),
      paths: prep.paths,
      phaseId: prep.phaseId,
      result,
      worktree: prep.worktree,
      workflowRunId: prep.workflowRunId,
    });
  } catch (err) {
    return await finalizeFailure({
      ctx,
      cursorRunId,
      err,
      paths: prep.paths,
      phaseId: prep.phaseId,
      worktree: prep.worktree,
      workflowRunId: prep.workflowRunId,
    });
  } finally {
    ctx.activeRuns.delete(prep.workflowRunId);
    stopDiscontinuitySampler?.();
    eventPump?.stop();
    if (ndjson !== undefined) {
      try {
        await ndjson.close();
      } catch {
        /* swallow — close errors after terminal don't change outcome */
      }
    }
    await cleanupScratchTaskDocIfTerminal(ctx, prep, scratchOwned);
  }
}

async function cleanupScratchTaskDocIfTerminal(
  ctx: ShipContext,
  prep: PreparedRun,
  scratchOwned: boolean,
): Promise<void> {
  if (prep.scratchTaskDocPath === undefined) return;
  // Only delete a scratch file ship itself wrote — a pre-existing file at the
  // scratch path belongs to the user and must survive the run.
  if (!scratchOwned) return;
  if (ctx.resolvedCursorRuntime !== "local") return;
  if (!isRunTerminalSafe(ctx, prep.workflowRunId)) return;
  try {
    await ctx.fs.unlink(prep.scratchTaskDocPath);
  } catch {
    /* best-effort — missing scratch must not change terminal outcome */
  }
}

function isRunTerminalSafe(ctx: ShipContext, workflowRunId: string): boolean {
  // Called from a finally block: a store read that throws (e.g. schema error
  // on a malformed row) must not override the run's outcome. No row / unreadable
  // row / non-terminal all mean "leave the scratch file alone".
  try {
    const row = ctx.store.getRun(workflowRunId);
    return row !== null && isTerminal(row.status);
  } catch {
    return false;
  }
}

// `runWithDurationCap` can only RESOLVE after `onHandle` ran (a pre-handle
// expiry rejects instead), so a resolved result implies the cursor-run row
// was recorded. Encodes that invariant for the type system; a violation
// routes through `finalizeFailure` like any other thrown error.
function assertCursorRunRecorded(id: string | undefined): string {
  if (id === undefined) {
    throw new Error("invariant violated: run resolved without a recorded cursor run");
  }
  return id;
}

async function prepareArtifacts(
  ctx: ShipContext,
  prep: PreparedRun,
): Promise<{ prompt: string; scratchOwned: boolean }> {
  await ctx.fs.mkdir(prep.paths.dir, { recursive: true });
  const taskDoc =
    prep.validated.content ?? (await ctx.fs.readFile(prep.validated.absoluteDocPath, "utf-8"));
  await ctx.fs.writeFile(prep.paths.taskDoc, taskDoc);
  let scratchOwned = false;
  if (prep.scratchTaskDocPath !== undefined) {
    // A file already present at the scratch path is the user's, not ours —
    // never overwrite it, and cleanup must not delete it.
    const preexisting = await fileExists(ctx, prep.scratchTaskDocPath);
    if (!preexisting) {
      await ctx.fs.writeFile(prep.scratchTaskDocPath, taskDoc);
      scratchOwned = true;
    }
  }

  const prompt = renderImplementationPrompt({
    taskDoc,
    repo: prep.repo,
    provider: ctx.provider,
    worktreePath:
      prep.worktree.path === CLOUD_WORKTREE_SENTINEL
        ? CLOUD_WORKTREE_SENTINEL
        : prep.effectiveWorkdir,
    ...(ctx.input.branch !== undefined && { branch: ctx.input.branch }),
    baseRef: prep.baseRef,
  });
  await ctx.fs.writeFile(prep.paths.prompt, prompt);
  return { prompt, scratchOwned };
}

async function fileExists(ctx: ShipContext, path: string): Promise<boolean> {
  try {
    await ctx.fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

interface FinalizeSuccessArgs {
  readonly ctx: ShipContext;
  readonly cursorRunId: string;
  readonly paths: RunArtifactPaths;
  readonly phaseId: string;
  readonly result: AgentRunResult;
  readonly worktree: WorktreeRef;
  readonly workflowRunId: string;
}

// When the runner reports a non-cancelled failure, classify it and fold the
// category/detail into the result; otherwise pass the result through untouched.
function classifyFinalizedResult(
  ctx: ShipContext,
  args: FinalizeSuccessArgs,
  isCancelled: boolean,
  terminal: TerminalWorkflowStatus,
): { readonly result: AgentRunResult; readonly classified?: ClassifiedFailure } {
  if (terminal !== "failed" || isCancelled) return { result: args.result };
  const classified = classifyFailedRun(ctx, args.workflowRunId, args.result);
  return {
    classified,
    result: {
      ...args.result,
      errorMessage: classified.errorMessage,
      failureCategory: classified.category,
      failureDetail: classified.detail,
    },
  };
}

interface FinalizeSuccessPersistArgs {
  readonly ctx: ShipContext;
  readonly args: FinalizeSuccessArgs;
  readonly endedAt: string;
  readonly terminal: TerminalWorkflowStatus;
  readonly result: AgentRunResult;
  readonly classified?: ClassifiedFailure;
}

function finalizeSuccessPersistAndLog(p: FinalizeSuccessPersistArgs): TerminalWorkflowStatus {
  const { ctx, args, endedAt, terminal, result, classified } = p;
  const cancelledNow = ctx.store.getRun(args.workflowRunId)?.status === "cancelled";
  const effectiveTerminal: TerminalWorkflowStatus = cancelledNow ? "cancelled" : terminal;
  persistSuccessRows({
    ctx,
    args,
    terminal: effectiveTerminal,
    endedAt,
    isCancelled: cancelledNow,
    result,
    ...(classified !== undefined && !cancelledNow && { failureCategory: classified.category }),
  });
  logRunFailedIfNeeded({
    ctx,
    workflowRunId: args.workflowRunId,
    phase: args.phaseId,
    cursorRunId: args.cursorRunId,
    terminal: effectiveTerminal,
    durationMs: result.durationMs,
    ...(classified !== undefined ? { classified } : {}),
  });
  return effectiveTerminal;
}

async function finalizeSuccess(args: FinalizeSuccessArgs): Promise<ShipOutput> {
  const { ctx, paths } = args;
  const endedAt = ctx.clock();

  const isCancelled = ctx.store.getRun(args.workflowRunId)?.status === "cancelled";
  const terminal: TerminalWorkflowStatus = isCancelled ? "cancelled" : args.result.status;
  const { result, classified } = classifyFinalizedResult(ctx, args, isCancelled, terminal);

  const writeOutcome = await tryWriteSuccessArtifacts(ctx, paths, result);
  if (!writeOutcome.ok) {
    return finalizeFailure({
      ctx: args.ctx,
      cursorRunId: args.cursorRunId,
      err: new ArtifactWriteFailedError("failed to persist run artifacts", {
        cause: writeOutcome.err,
      }),
      paths: args.paths,
      phaseId: args.phaseId,
      worktree: args.worktree,
      workflowRunId: args.workflowRunId,
    });
  }

  const effectiveTerminal = finalizeSuccessPersistAndLog({
    ctx,
    args,
    endedAt,
    terminal,
    result,
    ...(classified !== undefined ? { classified } : {}),
  });

  const updatedRun = ctx.store.getRun(args.workflowRunId);
  const cursorRunRef = ctx.store.getCursorRun(args.cursorRunId);
  return buildShipOutput({
    workflowRunId: args.workflowRunId,
    status: effectiveTerminal,
    worktree: updatedRun?.worktree ?? args.worktree,
    cursorRun: assertTerminalCursorRunRef(cursorRunRef, effectiveTerminal),
    paths,
    summary: result.summary,
  });
}

// Discriminated outcome — using a tagged success flag (rather than
// `Error | undefined`) keeps `tryWriteSuccessArtifacts` correct even
// when a `ShipFs` adapter rejects with `undefined` or another falsy
// value, which would otherwise alias success.
type WriteOutcome = { ok: true } | { ok: false; err: unknown };

// Writes `result.json` and `summary.md`. Returns a tagged outcome so the
// caller can route to `finalizeFailure` without a try block at this
// layer, and without ambiguity over what counts as "success."
function cursorRunResultForPersistence(result: AgentRunResult): AgentRunResult {
  if (result.classificationEvents === undefined) return result;
  const rest = { ...result };
  Reflect.deleteProperty(rest, "classificationEvents");
  return rest;
}

async function tryWriteSuccessArtifacts(
  ctx: ShipContext,
  paths: RunArtifactPaths,
  result: AgentRunResult,
): Promise<WriteOutcome> {
  try {
    const persisted = cursorRunResultForPersistence(result);
    await ctx.fs.writeFile(paths.result, `${JSON.stringify(persisted, null, 2)}\n`);
    if (result.summary !== undefined && result.summary !== "") {
      await ctx.fs.writeFile(paths.summary, result.summary);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, err };
  }
}

interface ClassifiedFailure {
  readonly category: FailureCategory;
  readonly detail: string;
  readonly errorMessage: string;
}

function resolveMaxRunDurationMs(store: Store, workflowRunId: string): number {
  return (
    store.getRun(workflowRunId)?.policy.maxRunDurationMs ?? DEFAULT_WORKFLOW_POLICY.maxRunDurationMs
  );
}

function classifyFailedRun(
  ctx: ShipContext,
  workflowRunId: string,
  result: AgentRunResult,
): ClassifiedFailure {
  if (result.failureCategory !== undefined) {
    const category = result.failureCategory;
    const detail = result.failureDetail ?? "";
    return {
      category,
      detail,
      errorMessage: formatClassifiedErrorMessage(category, detail),
    };
  }

  const events = result.classificationEvents ?? [];
  const maxRunDurationMs = resolveMaxRunDurationMs(ctx.store, workflowRunId);
  const category = classifyFailure({
    durationMs: result.durationMs,
    events,
    maxRunDurationMs,
    ...(result.sdkTerminalStatus !== undefined && {
      sdkTerminalStatus: result.sdkTerminalStatus,
    }),
  });
  const detail = buildFailureDetail({
    category,
    durationMs: result.durationMs,
    events,
    maxRunDurationMs,
    ...(result.sdkTerminalStatus !== undefined && {
      sdkTerminalStatus: result.sdkTerminalStatus,
    }),
    ...(result.errorMessage !== undefined && { rawErrorMessage: result.errorMessage }),
  });
  return {
    category,
    detail,
    errorMessage: formatClassifiedErrorMessage(category, detail),
  };
}

function errorMessageFromUnknown(err: unknown): string | undefined {
  if (err instanceof Error && err.message.length > 0) return err.message;
  if (typeof err === "string" && err.length > 0) return err;
  return undefined;
}

// `sdk-throw` is the default bucket for a thrown error that isn't a known
// ship-internal type. Errors ship raises while finalizing (store contention, a
// failed artifact write routed in via finalizeSuccess) are excluded here and
// classify as `unknown` instead of being attributed to the SDK; every other
// thrown error is treated as SDK-origin. An explicit `infra` category can split
// the internal ones out later (tombstone discipline: add, never repurpose).
function isSdkThrow(err: unknown): boolean {
  if (err instanceof StoreContentionError) return false;
  if (err instanceof ArtifactWriteFailedError) return false;
  return true;
}

function classifyThrownFailure(err: unknown): ClassifiedFailure {
  const isStoreContention = err instanceof StoreContentionError;
  const category = classifyFailure({
    events: [],
    isStoreContention,
    thrownError: isSdkThrow(err),
  });
  const rawMessage = errorMessageFromUnknown(err);
  const detail = buildFailureDetail({
    category,
    events: [],
    thrownErr: err,
    ...(rawMessage !== undefined && { rawErrorMessage: rawMessage }),
  });
  return {
    category,
    detail,
    errorMessage: formatClassifiedErrorMessage(category, detail),
  };
}

// Phase + cursor-run + workflow-run row updates on the success path.
// `isCancelled` is true when a concurrent `cancelRun()` already flipped
// the workflow row mid-flight; we keep the cursor + phase rows aligned
// with the runner's actual outcome but leave the workflow row at
// `cancelled` so the user's cancel intent isn't silently overwritten.
interface PersistSuccessRowsArgs {
  readonly ctx: ShipContext;
  readonly args: FinalizeSuccessArgs;
  readonly terminal: TerminalWorkflowStatus;
  readonly endedAt: string;
  readonly isCancelled: boolean;
  readonly result: AgentRunResult;
  readonly failureCategory?: FailureCategory;
}

function persistSuccessRows(p: PersistSuccessRowsArgs): void {
  const { ctx, args, terminal, endedAt, isCancelled, result, failureCategory } = p;
  const phasePatch: {
    status: TerminalWorkflowStatus;
    endedAt: string;
    errorMessage?: string;
    failureCategory?: FailureCategory;
  } = {
    status: terminal,
    endedAt,
  };
  // Suppress the failure errorMessage on a cancel (mirrors failureCategory): a
  // cancel landing during the artifact write must not leave stale failure text
  // on a cancelled phase.
  if (result.errorMessage !== undefined && !isCancelled) {
    phasePatch.errorMessage = result.errorMessage;
  }
  if (failureCategory !== undefined) phasePatch.failureCategory = failureCategory;
  ctx.store.updatePhase(args.phaseId, phasePatch);
  ctx.store.updateCursorRunStatus(args.cursorRunId, {
    status: terminal,
    endedAt,
    durationMs: result.durationMs,
    ...(result.artifacts !== undefined && { artifacts: [...result.artifacts] }),
  });
  if (!isCancelled) ctx.store.updateWorkflowRunStatus(args.workflowRunId, result.status);
}

function resolveImplementCursorRunId(run: WorkflowRun): string | undefined {
  const phase = run.phases.find((p) => p.kind === "implement" && p.cursorRunId !== undefined);
  return phase?.cursorRunId;
}

function listArtifactsFromStore(store: Store, workflowRunId: string): readonly ArtifactRef[] {
  const run = store.getRun(workflowRunId);
  if (run === null) {
    throw new WorkflowRunNotFoundError(workflowRunId);
  }
  const cursorRunId = resolveImplementCursorRunId(run);
  if (cursorRunId === undefined) {
    return [];
  }
  const cursorRun = store.getCursorRun(cursorRunId);
  return cursorRun?.artifacts ?? [];
}

function resolveCloudCursorRunForDownload(
  store: Store,
  workflowRunId: string,
  sdkPath: string,
): CursorRunRef {
  const run = store.getRun(workflowRunId);
  if (run === null) {
    throw new WorkflowRunNotFoundError(workflowRunId);
  }
  const cursorRunId = resolveImplementCursorRunId(run);
  if (cursorRunId === undefined) {
    throw new ArtifactNotInManifestError(workflowRunId, sdkPath);
  }
  const cursorRun = store.getCursorRun(cursorRunId);
  if (cursorRun === null) {
    throw new ArtifactNotInManifestError(workflowRunId, sdkPath);
  }
  if (cursorRun.runtime !== "cloud") {
    throw new ArtifactsUnavailableLocalError(workflowRunId);
  }
  return cursorRun;
}

function manifestRefForPath(
  manifest: readonly ArtifactRef[],
  workflowRunId: string,
  sdkPath: string,
): ArtifactRef {
  const ref = manifest.find((a) => a.path === sdkPath);
  if (ref === undefined) {
    throw new ArtifactNotInManifestError(workflowRunId, sdkPath);
  }
  return ref;
}

function assertArtifactSizePreflight(
  ref: ArtifactRef,
  workflowRunId: string,
  sdkPath: string,
  maxBytes: number,
  force: boolean | undefined,
): void {
  if (!force && ref.sizeBytes > maxBytes) {
    throw new ArtifactTooLargeError({
      maxBytes,
      path: sdkPath,
      sizeBytes: ref.sizeBytes,
      workflowRunId,
    });
  }
}

function assertDownloadedArtifactSize(
  bytes: Buffer,
  workflowRunId: string,
  sdkPath: string,
  maxBytes: number,
  force: boolean | undefined,
): void {
  if (!force && bytes.length > maxBytes) {
    throw new ArtifactTooLargeError({
      maxBytes,
      path: sdkPath,
      sizeBytes: bytes.length,
      workflowRunId,
    });
  }
}

async function fetchCloudArtifactBytes(
  runner: AgentRunner,
  agentId: string,
  workflowRunId: string,
  sdkPath: string,
): Promise<Buffer> {
  if (runner.downloadArtifact === undefined) {
    throw new CloudRunnerNotConfiguredError();
  }
  try {
    return await runner.downloadArtifact(agentId, sdkPath);
  } catch (err) {
    if (err instanceof AgentNotFoundError) {
      throw new ArtifactGoneError(workflowRunId, sdkPath);
    }
    throw err;
  }
}

async function downloadArtifactImpl(
  deps: Pick<ShipServiceDeps, "store" | "fs" | "config">,
  workflowRunId: string,
  sdkPath: string,
  opts?: { readonly force?: boolean; readonly outDir?: string },
): Promise<{ localPath: string; sizeBytes: number }> {
  const { config, fs, store } = deps;
  assertSafeCloudArtifactPath(sdkPath);
  const cursorRun = resolveCloudCursorRunForDownload(store, workflowRunId, sdkPath);
  const ref = manifestRefForPath(cursorRun.artifacts ?? [], workflowRunId, sdkPath);
  const maxBytes = config.artifactMaxBytes ?? DEFAULT_ARTIFACT_MAX_BYTES;
  assertArtifactSizePreflight(ref, workflowRunId, sdkPath, maxBytes, opts?.force);
  const runner = config.cloudCursor;
  if (runner === undefined) {
    throw new CloudRunnerNotConfiguredError();
  }
  const bytes = await fetchCloudArtifactBytes(runner, cursorRun.agentId, workflowRunId, sdkPath);
  assertDownloadedArtifactSize(bytes, workflowRunId, sdkPath, maxBytes, opts?.force);
  const dest =
    opts?.outDir !== undefined
      ? await resolveContainedCloudArtifactDestForOutDir(fs, opts.outDir, sdkPath)
      : await resolveContainedCloudArtifactDest(fs, config.runsDir, workflowRunId, sdkPath);
  const parent = parentDirOf(dest);
  if (parent !== "") {
    await fs.mkdir(parent, { recursive: true });
  }
  await fs.writeFileBytes(dest, bytes);
  return { localPath: dest, sizeBytes: bytes.length };
}

function parentDirOf(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (idx <= 0) return "";
  return filePath.slice(0, idx);
}

async function resolveContainedCloudArtifactDestForOutDir(
  fs: ShipFs,
  outDir: string,
  sdkPath: string,
): Promise<string> {
  return resolveContainedCloudArtifactDestUnderRoot(fs, outDir, sdkPath);
}

/**
 * Path for "row was cancelled before the runner started" — fs prep is
 * already on disk but `cursor.run()` hasn't been invoked, so there's
 * no cursor-run row to record. Marks the phase as cancelled and
 * returns a ShipOutput whose `cursorRun` is synthesized with status
 * `cancelled`.
 */
function finalizeAlreadyCancelled(ctx: ShipContext, prep: PreparedRun): ShipOutput {
  const endedAt = ctx.clock();
  ctx.store.updatePhase(prep.phaseId, { status: "cancelled", endedAt });
  const updatedRun = ctx.store.getRun(prep.workflowRunId);
  return buildShipOutput({
    workflowRunId: prep.workflowRunId,
    status: "cancelled",
    worktree: updatedRun?.worktree ?? prep.worktree,
    cursorRun: synthesizeFailedCursorRun({
      workflowRunId: prep.workflowRunId,
      artifactsDir: prep.paths.dir,
      endedAt,
      status: "cancelled",
      runtime: ctx.resolvedCursorRuntime,
      provider: ctx.provider,
    }),
    paths: prep.paths,
    summary: undefined,
  });
}

interface FinalizeFailureArgs {
  readonly ctx: ShipContext;
  readonly cursorRunId: string | undefined;
  readonly err: unknown;
  readonly paths: RunArtifactPaths;
  readonly phaseId: string;
  readonly worktree: WorktreeRef;
  readonly workflowRunId: string;
}

function resolveFailureMessage(
  err: unknown,
  isCancelled: boolean,
): { errorMessage: string; classified?: ClassifiedFailure } {
  const errorChain = flattenErrorChain(err);
  const rawErrorMessage =
    errorChain.length <= 1
      ? (errorChain[0]?.message ?? stringifyUnknown(err))
      : errorChain.map((e, i) => `L${String(i)}: ${e.message}`).join(" | ");
  if (isCancelled) return { errorMessage: rawErrorMessage };
  const classified = classifyThrownFailure(err);
  return { classified, errorMessage: classified.errorMessage };
}

async function finalizeFailure(args: FinalizeFailureArgs): Promise<ShipOutput> {
  const { ctx } = args;
  const endedAt = ctx.clock();
  const errorChain = flattenErrorChain(args.err);

  const isCancelled = ctx.store.getRun(args.workflowRunId)?.status === "cancelled";
  const terminal: TerminalWorkflowStatus = isCancelled ? "cancelled" : "failed";

  const { errorMessage, classified } = resolveFailureMessage(args.err, isCancelled);

  persistFailureRows({
    ctx,
    args,
    terminal,
    endedAt,
    errorMessage,
    isCancelled,
    ...(classified !== undefined && { failureCategory: classified.category }),
  });

  logRunFailedIfNeeded({
    ctx,
    workflowRunId: args.workflowRunId,
    phase: args.phaseId,
    terminal,
    ...(args.cursorRunId !== undefined ? { cursorRunId: args.cursorRunId } : {}),
    ...(classified !== undefined ? { classified } : {}),
  });

  await tryWriteFailureResult({
    ctx,
    path: args.paths.result,
    status: terminal,
    errorMessage,
    errorChain,
    ...(classified !== undefined && { classified }),
  });

  const updatedRun = ctx.store.getRun(args.workflowRunId);
  return buildShipOutput({
    workflowRunId: args.workflowRunId,
    status: terminal,
    worktree: updatedRun?.worktree ?? args.worktree,
    cursorRun: resolveFailureCursorRunRef(ctx, args, terminal),
    paths: args.paths,
    summary: undefined,
  });
}

interface PersistFailureRowsArgs {
  readonly ctx: ShipContext;
  readonly args: FinalizeFailureArgs;
  readonly terminal: TerminalWorkflowStatus;
  readonly endedAt: string;
  readonly errorMessage: string;
  readonly isCancelled: boolean;
  readonly failureCategory?: FailureCategory;
}

// Phase + (optional) cursor-run + workflow-run row updates on failure.
// `isCancelled` keeps the workflow row at `cancelled` if the user
// already cancelled mid-flight; phase + cursor-run rows align with the
// actual failure for internal consistency.
function persistFailureRows(p: PersistFailureRowsArgs): void {
  const { ctx, args, terminal, endedAt, errorMessage, isCancelled, failureCategory } = p;
  const phasePatch: {
    status: TerminalWorkflowStatus;
    endedAt: string;
    errorMessage?: string;
    failureCategory?: FailureCategory;
  } = {
    status: terminal,
    endedAt,
  };
  if (!isCancelled) {
    phasePatch.errorMessage = errorMessage;
    if (failureCategory !== undefined) phasePatch.failureCategory = failureCategory;
  }
  ctx.store.updatePhase(args.phaseId, phasePatch);
  if (args.cursorRunId !== undefined) {
    try {
      ctx.store.updateCursorRunStatus(args.cursorRunId, { status: terminal, endedAt });
    } catch {
      // swallow — best-effort cleanup
    }
  }
  if (!isCancelled) ctx.store.updateWorkflowRunStatus(args.workflowRunId, "failed");
}

// Shape of one level in the flattened error chain.
interface ErrorChainEntry {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly extra?: Record<string, unknown>;
}

// Walk `err.cause` chain into a flat list. Top-level Error is L0, then
// each successive `.cause` is L1, L2, ... Captures `name` and `message`
// plus any SDK-side extras (status/code/response body) that aren't on
// the standard Error shape. Bounded at 10 levels to avoid pathological
// cycles.
function flattenErrorChain(err: unknown): ErrorChainEntry[] {
  const out: ErrorChainEntry[] = [];
  let cur: unknown = err;
  const seen = new Set<unknown>();
  while (cur !== undefined && cur !== null && out.length < 10 && !seen.has(cur)) {
    seen.add(cur);
    if (cur instanceof Error) {
      const entry: {
        name: string;
        message: string;
        stack?: string;
        extra?: Record<string, unknown>;
      } = {
        name: cur.name,
        message: cur.message,
      };
      if (cur.stack !== undefined) entry.stack = cur.stack;
      const extra = collectExtraErrorFields(cur);
      if (Object.keys(extra).length > 0) entry.extra = extra;
      out.push(entry);
      cur = (cur as { cause?: unknown }).cause;
    } else {
      out.push({ name: "NonError", message: stringifyUnknown(cur) });
      break;
    }
  }
  return out;
}

// Safe stringification for `unknown` values that may not be plain
// strings/numbers (e.g. plain objects). Returns a useful representation
// instead of `[object Object]`. Used by the error-chain walker for the
// non-Error tail.
function stringifyUnknown(val: unknown): string {
  if (typeof val === "string") return val;
  if (val === null || val === undefined) return String(val);
  if (typeof val === "object") {
    try {
      return JSON.stringify(val);
    } catch {
      return Object.prototype.toString.call(val);
    }
  }
  if (typeof val === "number" || typeof val === "boolean" || typeof val === "bigint") {
    return String(val);
  }
  // Function / symbol — last-resort safe representation.
  return Object.prototype.toString.call(val);
}

// Pluck non-standard fields off an Error (SDK errors often carry
// `status`, `code`, `response`, `body`, etc.). Skips standard Error
// keys + `cause` (walked separately) + `stack` (captured separately).
// Uses `getOwnPropertyNames` rather than `Object.keys` so SDK errors
// that define their extras as non-enumerable own properties (a common
// class-field pattern) still surface in the chain.
function collectExtraErrorFields(err: Error): Record<string, unknown> {
  const skip = new Set(["name", "message", "stack", "cause"]);
  const extra: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(err)) {
    if (skip.has(key)) continue;
    const val = (err as unknown as Record<string, unknown>)[key];
    if (val === undefined) continue;
    extra[key] = val;
  }
  return extra;
}

// Best-effort `result.json` write so the archive carries some forensics
// even on the failure path. Never propagates — errors are swallowed
// internally. `errorChain` preserves the full cause chain; `errorMessage`
// is the joined-string form kept for back-compat with single-field readers.
// SDK-side `extra` payloads can contain JSON-hostile values (BigInt,
// circular refs) — `safeStringifyFailureResult` handles those so a bad
// extra never loses the whole `result.json` (which would also drop
// `status` / `errorMessage`).
interface WriteFailureResultArgs {
  readonly ctx: ShipContext;
  readonly path: string;
  readonly status: TerminalWorkflowStatus;
  readonly errorMessage: string;
  readonly errorChain: readonly ErrorChainEntry[];
  readonly classified?: ClassifiedFailure;
}

async function tryWriteFailureResult(args: WriteFailureResultArgs): Promise<void> {
  const { ctx, path, status, errorMessage, errorChain, classified } = args;
  try {
    const body = safeStringifyFailureResult({
      status,
      errorMessage,
      errorChain,
      ...(classified !== undefined && {
        failureCategory: classified.category,
        failureDetail: classified.detail,
      }),
    });
    await ctx.fs.writeFile(path, `${body}\n`);
  } catch {
    // swallow
  }
}

interface FailureResultPayload {
  readonly status: string;
  readonly errorMessage: string;
  readonly errorChain: readonly ErrorChainEntry[];
  readonly failureCategory?: FailureCategory;
  readonly failureDetail?: string;
}

// JSON-stringify wrapper that survives common SDK-error payload hazards:
// BigInt (default-throws), circular references (default-throws), and
// functions / symbols (silently dropped → swapped for sentinel strings).
// On any remaining failure, falls back to a minimal `{status, errorMessage}`
// payload — better to lose forensic detail than the whole `result.json`.
function safeStringifyFailureResult(payload: FailureResultPayload): string {
  try {
    return JSON.stringify(payload, jsonSafeReplacer(), 2);
  } catch {
    return JSON.stringify(
      { status: payload.status, errorMessage: payload.errorMessage, errorChain: [] },
      null,
      2,
    );
  }
}

// JSON.stringify replacer factory: BigInt → `"<n>n"`, cycles → `"[Circular]"`,
// functions → `"[Function]"`, symbols → `"[Symbol]"`. Closure-scoped
// `seen` tracks visited objects within a single stringify call.
function jsonSafeReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet();
  return (_key, value) => {
    if (typeof value === "bigint") return `${value.toString()}n`;
    if (typeof value === "function") return "[Function]";
    if (typeof value === "symbol") return "[Symbol]";
    if (value !== null && typeof value === "object") {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
    }
    return value;
  };
}

// Picks the cursor-run ref for `ShipOutput`: the persisted row when
// available, a synthesized one when we never recorded the cursor run
// (e.g. cursor.run() rejected before returning a handle).
function resolveFailureCursorRunRef(
  ctx: ShipContext,
  args: FinalizeFailureArgs,
  terminal: TerminalCursorRunStatus,
): CursorRunRef & { status: TerminalCursorRunStatus } {
  const ref = args.cursorRunId !== undefined ? ctx.store.getCursorRun(args.cursorRunId) : null;
  if (ref !== null) return assertTerminalCursorRunRef(ref, terminal);
  return synthesizeFailedCursorRun({
    workflowRunId: args.workflowRunId,
    artifactsDir: args.paths.dir,
    endedAt: ctx.clock(),
    status: terminal,
    runtime: ctx.resolvedCursorRuntime,
    provider: ctx.provider,
  });
}

interface BuildShipOutputArgs {
  readonly workflowRunId: string;
  readonly status: TerminalWorkflowStatus;
  readonly worktree: WorktreeRef;
  readonly cursorRun: CursorRunRef & { status: TerminalCursorRunStatus };
  readonly paths: RunArtifactPaths;
  readonly summary: string | undefined;
}

function buildShipOutput(args: BuildShipOutputArgs): ShipOutput {
  const out: ShipOutput = {
    workflowRunId: args.workflowRunId,
    status: args.status,
    worktree: args.worktree,
    cursorRun: args.cursorRun,
    artifacts: {
      promptPath: args.paths.prompt,
      eventsPath: args.paths.events,
      resultPath: args.paths.result,
    },
    ...(args.summary !== undefined && args.summary !== "" && { summary: args.summary }),
  };
  return out;
}

function assertTerminalCursorRunRef(
  ref: CursorRunRef | null,
  fallbackStatus: TerminalCursorRunStatus,
): CursorRunRef & { status: TerminalCursorRunStatus } {
  if (ref === null) throw new Error("ShipService: cursor run row vanished after recording");
  if (ref.status === "running") {
    return { ...ref, status: fallbackStatus };
  }
  return ref as CursorRunRef & { status: TerminalCursorRunStatus };
}

/**
 * Resolves the per-run `ModelSelection` from `input` over the wiring default:
 *
 * - `input.model` set → fresh id plus optional `input.modelParams`; wiring params
 *   are never grafted onto an explicit override id.
 * - `input.modelParams` without `model` → wiring model id plus the given params.
 * - Neither set → wiring default verbatim.
 */
function resolveModelSelection(input: ShipInput, defaultModel: ModelSelection): ModelSelection {
  const { model, modelParams } = input;

  if (model !== undefined) {
    return {
      id: model,
      ...(modelParams !== undefined && { params: modelParams }),
    };
  }

  if (modelParams !== undefined) {
    return { id: defaultModel.id, params: modelParams };
  }

  return defaultModel;
}

/**
 * Builds a synthetic failed/cancelled cursor-run ref when we never got
 * far enough to record one (e.g. cursor.run() rejected before returning
 * a handle). Used to produce a coherent ShipOutput in those edge cases.
 */
interface SynthesizeFailedCursorRunInput {
  readonly workflowRunId: string;
  readonly artifactsDir: string;
  readonly endedAt: string;
  readonly status: TerminalCursorRunStatus;
  readonly runtime: CursorRunRuntime;
  readonly provider?: AgentProvider;
}

function synthesizeFailedCursorRun(input: SynthesizeFailedCursorRunInput): CursorRunRef & {
  status: TerminalCursorRunStatus;
} {
  const provider = input.provider ?? "cursor";
  return {
    id: `cr_synthetic_${input.workflowRunId}`,
    agentId: agentNotCreatedSentinel(provider),
    provider,
    runtime: input.runtime,
    status: input.status,
    startedAt: input.endedAt,
    endedAt: input.endedAt,
    artifactsDir: input.artifactsDir,
  };
}

// The cloud runner a resumed row routes to, by the row's persisted provider.
// Undefined when that provider has no cloud runner wired — the caller then skips
// the resume rather than attaching with the wrong SDK (FR7). codex has no cloud.
function resumeCloudRunner(
  config: ShipServiceConfig,
  provider: AgentProvider,
): AgentRunner | undefined {
  if (provider === "claude") return config.cloudClaude;
  if (provider === "cursor") return config.cloudCursor;
  return undefined;
}

async function resumeOrphanedRuns(ctx: ResumeContext): Promise<void> {
  if (ctx.config.cloudCursor === undefined && ctx.config.cloudClaude === undefined) return;
  const rows = ctx.store.listResumableCloudCursorRuns();
  if (rows.length === 0) return;

  // The staleness guard applies to attach-resume only: a fresh heartbeat
  // means a sibling process is streaming that run. Rows whose parent
  // workflow is already terminal carry no such risk — reconciling them
  // (resumeOneOrphanedCloudRun closes the row, no attach) is safe at any
  // freshness, and gating them would strand e.g. a cancel that bumped
  // `updated_at` right before this process booted.
  const nowMs = Date.parse(ctx.clock());
  const eligible = collectOrphanResumeRows(ctx, rows);
  const staleIds = new Set(
    selectStaleOrphanResumeCandidates(
      eligible.live.map(({ row, updatedAt }) => ({ workflowRunId: row.workflowRunId, updatedAt })),
      nowMs,
    ).map((candidate) => candidate.workflowRunId),
  );
  for (const { row, updatedAt } of eligible.live) {
    if (staleIds.has(row.workflowRunId)) continue;
    ctx.logger.debug(
      { updatedAt, workflowRunId: row.workflowRunId },
      "skipping fresh orphan resume candidate",
    );
  }

  const resumable = [
    ...eligible.terminalParent,
    ...eligible.live.filter(({ row }) => staleIds.has(row.workflowRunId)).map(({ row }) => row),
  ];
  await Promise.allSettled(resumable.map((row) => resumeOneOrphanedCloudRun(ctx, row)));
}

interface OrphanResumeRows {
  /** Parent workflow still pending/running — staleness-guarded attach candidates. */
  live: { row: ResumableCloudCursorRun; updatedAt: string }[];
  /** Parent workflow already terminal — reconcile-only, exempt from staleness. */
  terminalParent: ResumableCloudCursorRun[];
}

function collectOrphanResumeRows(
  ctx: ResumeContext,
  rows: readonly ResumableCloudCursorRun[],
): OrphanResumeRows {
  const out: OrphanResumeRows = { live: [], terminalParent: [] };
  for (const row of rows) {
    const workflowRun = ctx.store.getRun(row.workflowRunId);
    if (workflowRun === null) {
      ctx.logger.warn(
        { cursorRunId: row.id, workflowRunId: row.workflowRunId },
        "orphan cursor run has no workflow row — skipping",
      );
      continue;
    }
    if (workflowRun.status !== "pending" && workflowRun.status !== "running") {
      out.terminalParent.push(row);
      continue;
    }
    out.live.push({ row, updatedAt: workflowRun.updatedAt });
  }
  return out;
}

function resumeOrphanedRunsTracked(ctx: ResumeContext): Promise<void> {
  const bg = resumeOrphanedRuns(ctx);
  ctx.resumeBgPending.add(bg);
  void bg.finally(() => {
    ctx.resumeBgPending.delete(bg);
  });
  return bg;
}

interface ResumeAttachContext {
  readonly cloudSpec: CloudRunSpec;
  readonly controller: AbortController;
  readonly ndjson: EventWriter;
  readonly paths: RunArtifactPaths;
  readonly phaseId: string;
  readonly row: ResumableCloudCursorRun;
  readonly runner: AgentRunner;
  readonly shipCtx: ShipContext;
  readonly worktree: WorktreeRef;
}

function buildResumeAttachContext(args: {
  ctx: ResumeContext;
  row: ResumableCloudCursorRun;
  phaseId: string;
  cloudSpec: CloudRunSpec;
  runner: AgentRunner;
  worktree: WorktreeRef;
  controller: AbortController;
}): ResumeAttachContext {
  const { ctx, row, phaseId, cloudSpec, runner, worktree, controller } = args;
  const paths = resolveRunArtifactPaths(ctx.config.runsDir, row.workflowRunId);
  return {
    cloudSpec,
    controller,
    ndjson: createNdjsonEventWriter(ctx.fs, paths.events),
    paths,
    phaseId,
    row,
    runner,
    shipCtx: resumeCtxAsShipContext(ctx, row.workflowRunId, row.provider),
    worktree,
  };
}

async function resumeOneOrphanedCloudRun(
  ctx: ResumeContext,
  row: ResumableCloudCursorRun,
): Promise<void> {
  if (ctx.activeRuns.has(row.workflowRunId)) return;

  const controller = new AbortController();
  ctx.activeRuns.set(row.workflowRunId, { controller });

  const workflowRun = ctx.store.getRun(row.workflowRunId);
  if (workflowRun === null) {
    ctx.activeRuns.delete(row.workflowRunId);
    return;
  }

  // If the parent workflow already reached a terminal state before the
  // process crashed (e.g. the user called cancelRun, which updates
  // workflow + phase rows but leaves cursor_runs marked running), the
  // cursor row is a stale revivor. Re-attaching would override the
  // user's cancel intent and continue cloud-side mutations / cost.
  if (workflowRun.status !== "pending" && workflowRun.status !== "running") {
    ctx.activeRuns.delete(row.workflowRunId);
    closeOrphanedCursorRowToMatchTerminalWorkflow(ctx, row, workflowRun.status);
    return;
  }

  const phase = workflowRun.phases.find((p) => p.kind === "implement" && p.cursorRunId === row.id);
  if (phase === undefined) {
    ctx.activeRuns.delete(row.workflowRunId);
    return;
  }

  const cloudSpec = parseImplementPhaseCloudSpec(phase.inputJson);
  if (cloudSpec === undefined) {
    ctx.activeRuns.delete(row.workflowRunId);
    await finalizeResumeFailure(ctx, row, phase.id, workflowRun.worktree, {
      message: "cloud spec missing from implement phase input_json on resume",
    });
    return;
  }

  // Route to the runner matching the persisted row's provider — a claude-cloud
  // orphan must attach via cloudClaude, not cloudCursor. When no cloud runner is
  // wired for the row's provider (e.g. a claude row after a rollback that dropped
  // cloudClaude) we can't attach with a correct SDK, so finalize the resume as a
  // failure rather than leave the row `running` to be retried on every boot (FR7).
  const runner = resumeCloudRunner(ctx.config, row.provider);
  if (runner === undefined) {
    ctx.activeRuns.delete(row.workflowRunId);
    await finalizeResumeFailure(ctx, row, phase.id, workflowRun.worktree, {
      message: `no cloud runner wired for provider "${row.provider}" on resume`,
    });
    return;
  }

  const target = buildResumeAttachContext({
    cloudSpec,
    controller,
    ctx,
    phaseId: phase.id,
    row,
    runner,
    worktree: workflowRun.worktree,
  });
  let eventPump: EventPumpHandle | undefined;
  try {
    await runResumeAttach(ctx, target, (pump) => {
      eventPump = pump;
    });
  } finally {
    eventPump?.stop();
    ctx.activeRuns.delete(row.workflowRunId);
    try {
      await target.ndjson.close();
    } catch {
      /* swallow */
    }
  }
}

async function runResumeAttach(
  ctx: ResumeContext,
  target: ResumeAttachContext,
  onPumpStarted: (pump: EventPumpHandle) => void,
): Promise<void> {
  // The caller resolved the provider's cloud runner and finalized as a failure
  // when none was wired, so an attach here always has the correct SDK (FR7).
  const runner = target.runner;

  let eventPump: EventPumpHandle | undefined;
  let stopDiscontinuitySampler: (() => void) | undefined;
  let capHandle: DurationCapHandle | undefined;
  const onEvent: AgentRunAttachInput["onEvent"] = (ev) => {
    target.ndjson.write(ev);
    eventPump?.heartbeat();
    wireCapStreamFold(target.shipCtx.provider, capHandle, ev);
  };

  try {
    const model = target.row.model ?? ctx.config.defaultModel;
    const resumeLog = target.shipCtx.logger.child({
      workflowRunId: target.row.workflowRunId,
      phase: target.phaseId,
    });
    // Same single-window cap as the dispatch path: the attach call itself
    // (`Agent.resume` + `Agent.getRun`) can stall, so it runs inside the
    // remaining-budget window rather than ahead of it.
    const cursorRow = ctx.store.getCursorRun(target.row.id);
    const rowCreatedAtWallMs =
      cursorRow?.startedAt !== undefined ? Date.parse(cursorRow.startedAt) : undefined;
    let capHandleRef: AgentRunHandle | undefined;
    const result = await runWithDurationCap({
      elapsedMs: resumeElapsedMs(ctx, target.row.id),
      kind: "attach",
      log: resumeLog,
      maxRunDurationMs: resolveMaxRunDurationMs(ctx.store, target.row.workflowRunId),
      onCapReady: (handle) => {
        capHandle = handle;
      },
      probeAgentId: target.row.agentId,
      probeRunId: target.row.runId,
      ...(cursorRow?.createdAtMs !== undefined && { serverCreatedAtMs: cursorRow.createdAtMs }),
      ...(rowCreatedAtWallMs !== undefined &&
        Number.isFinite(rowCreatedAtWallMs) && { rowCreatedAtWallMs }),
      signals: buildRemoteCapSignals({
        getHandle: () => capHandleRef,
        provider: target.shipCtx.provider,
        runner,
        runtime: "cloud",
      }),
      wallClock: () => Date.parse(ctx.clock()),
      onHandle: (handle) => {
        capHandleRef = handle;
        eventPump = startEventPump({ store: ctx.store, workflowRunId: target.row.workflowRunId });
        stopDiscontinuitySampler = startCapDiscontinuitySampler({ capHandle });
        onPumpStarted(eventPump);
        ctx.activeRuns.set(target.row.workflowRunId, { controller: target.controller, handle });
      },
      start: () =>
        runner.attach({
          agentId: target.row.agentId,
          cloud: target.cloudSpec,
          log: resumeLog,
          model,
          onEvent,
          runId: target.row.runId,
          signal: target.controller.signal,
          ...(ctx.config.mcpServers !== undefined && { mcpServers: ctx.config.mcpServers }),
          ...(ctx.config.agents !== undefined && { agents: ctx.config.agents }),
        }),
    });
    await finalizeSuccess({
      ctx: target.shipCtx,
      cursorRunId: target.row.id,
      paths: target.paths,
      phaseId: target.phaseId,
      result,
      worktree: target.worktree,
      workflowRunId: target.row.workflowRunId,
    });
  } catch (err) {
    await handleResumeAttachError(ctx, target, err);
  } finally {
    stopDiscontinuitySampler?.();
  }
}

// Wall time a resumed run consumed before this process attached, from the
// persisted cursor-run row. Zero when the row (or a sane delta) isn't
// available — the cap then falls back to a full fresh window.
function resumeElapsedMs(ctx: ResumeContext, cursorRunId: string): number {
  const startedAt = ctx.store.getCursorRun(cursorRunId)?.startedAt;
  if (startedAt === undefined) return 0;
  const elapsed = Date.parse(ctx.clock()) - Date.parse(startedAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return 0;
  return elapsed;
}

// Attach errors split by what they prove about the run. A duration-cap
// expiry is this process's own policy verdict on the attempt it started,
// and a not-found agent means the cloud side can never produce a result
// — both terminalize. Anything else (auth, network) may be transient or
// environmental: the row stays `running` for a later sweep to retry;
// permanent environmental causes require an explicit `cancelRun`.
async function handleResumeAttachError(
  ctx: ResumeContext,
  target: ResumeAttachContext,
  err: unknown,
): Promise<void> {
  if (err instanceof CursorRunStartTimedOutError) {
    await finalizeFailure({
      ctx: target.shipCtx,
      cursorRunId: target.row.id,
      err,
      paths: target.paths,
      phaseId: target.phaseId,
      worktree: target.worktree,
      workflowRunId: target.row.workflowRunId,
    });
    return;
  }
  if (err instanceof AgentNotFoundError) {
    await finalizeResumeFailure(ctx, target.row, target.phaseId, target.worktree, {
      message: `cloud agent ${target.row.agentId} no longer reachable on resume`,
    });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  target.shipCtx.logger.error(
    { err: message, workflowRunId: target.row.workflowRunId },
    "orphan resume attach failed — row left running",
  );
}

function resumeCtxAsShipContext(
  ctx: ResumeContext,
  workflowRunId: string,
  provider: AgentProvider,
): ShipContext {
  return {
    activeRuns: ctx.activeRuns,
    clock: ctx.clock,
    config: ctx.config,
    fs: ctx.fs,
    ids: {
      cursorRun: newCursorRunId,
      phase: newPhaseId,
      workflowRun: () => workflowRunId,
    },
    input: { docPath: "", runtime: "cloud" },
    logger: ctx.logger,
    // Provider comes from the persisted run row (FR7): a claude-cloud resume must
    // carry provider:"claude". On the attach path the resolved runner is always
    // the provider's cloud runner — resumeOneOrphanedCloudRun finalizes as a
    // failure before building the attach context when none is wired, so control
    // never reaches here with a mismatched provider. The `?? cursor` fallback is
    // a placeholder for the finalize-failure path only (ShipContext.runner is
    // required), which never invokes runner.run().
    provider,
    resolvedCursorRuntime: "cloud",
    runner: resumeCloudRunner(ctx.config, provider) ?? ctx.config.cursor,
    store: ctx.store,
  };
}

function parseImplementPhaseCloudSpec(inputJson: string): CloudRunSpec | undefined {
  try {
    const parsed: unknown = JSON.parse(inputJson);
    if (parsed === null || typeof parsed !== "object") return undefined;
    const cloud = (parsed as { cloud?: unknown }).cloud;
    if (cloud === null || typeof cloud !== "object") return undefined;
    return cloud as CloudRunSpec;
  } catch {
    return undefined;
  }
}

// Sync cleanup for a cursor_run row whose parent workflow already
// reached a terminal state before the process crashed. No attach is
// attempted; we just mirror the workflow's terminal onto the cursor
// row so its status isn't a stale lie. Cloud-side cancel (the agent
// may still be running on Cursor's VM) is intentionally out of scope —
// a separate enhancement; the immediate concern Codex flagged is
// not re-attaching, which this closes off.
function closeOrphanedCursorRowToMatchTerminalWorkflow(
  ctx: ResumeContext,
  row: ResumableCloudCursorRun,
  workflowStatus: TerminalWorkflowStatus,
): void {
  const cursorRow = ctx.store.getCursorRun(row.id);
  if (cursorRow === null) return;
  if (
    cursorRow.status === "succeeded" ||
    cursorRow.status === "failed" ||
    cursorRow.status === "cancelled"
  ) {
    return;
  }
  const endedAt = ctx.clock();
  const startedAtMs = new Date(cursorRow.startedAt).getTime();
  const endedAtMs = new Date(endedAt).getTime();
  const durationMs = Math.max(0, endedAtMs - startedAtMs);
  ctx.store.updateCursorRunStatus(row.id, {
    durationMs,
    endedAt,
    status: workflowStatus,
  });
}

async function finalizeResumeFailure(
  ctx: ResumeContext,
  row: ResumableCloudCursorRun,
  phaseId: string,
  worktree: WorktreeRef,
  args: { readonly message: string },
): Promise<void> {
  const paths = resolveRunArtifactPaths(ctx.config.runsDir, row.workflowRunId);
  await finalizeFailure({
    ctx: resumeCtxAsShipContext(ctx, row.workflowRunId, row.provider),
    cursorRunId: row.id,
    err: new Error(args.message),
    paths,
    phaseId,
    worktree,
    workflowRunId: row.workflowRunId,
  });
}

/**
 * `ShipService` — the workflow brain. Owns the state machine, drives
 * the cursor runner, persists artifacts, and exposes the five public
 * methods MCP server / CLI consume. Constructed via `createShipService`
 * with all collaborators DI'd (store / cursor / fs / clock / config).
 */

import type {
  AgentDefinition,
  CloudRunSpec,
  CursorRunAttachInput,
  CursorRunHandle,
  CursorRunInput,
  CursorRunner,
  CursorRunResult,
  McpServerConfig,
} from "@ship/cursor-runner";
import type { GetWorkflowRunOutput, ShipInput, ShipOutput, ShipStartOutput } from "@ship/mcp";
import type { ListRunsFilter, ResumableCloudCursorRun, Store } from "@ship/store";
import type {
  ArtifactRef,
  CursorRunRef,
  CursorRunRuntime,
  ModelSelection,
  TerminalCursorRunStatus,
  TerminalWorkflowStatus,
  WorkflowRun,
  WorkflowStatus,
  WorktreeRef,
} from "@ship/workflow";

import { CursorAgentNotFoundError } from "@ship/cursor-runner";
import { WorkflowRunNotFoundError } from "@ship/store";
import {
  CLOUD_WORKTREE_SENTINEL,
  cursorWatchUrl,
  DEFAULT_WORKFLOW_POLICY,
  newCursorRunId,
  newPhaseId,
  newWorkflowRunId,
} from "@ship/workflow";
import { basename } from "node:path";

import type { EventWriter } from "./artifacts/ndjson.js";
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
  type RunArtifactPaths,
} from "./artifacts/paths.js";
import { renderImplementationPrompt } from "./artifacts/prompt-template.js";
import { type EventPumpHandle, startEventPump } from "./cursor-runs/event-pump.js";
import { parseGitHubRepoSlug } from "./doc-source/parse-github-url.js";
import {
  ArtifactGoneError,
  ArtifactNotInManifestError,
  ArtifactsUnavailableLocalError,
  ArtifactTooLargeError,
  ArtifactWriteFailedError,
  CloudRunnerNotConfiguredError,
  MissingRepoError,
  WorkdirNotFoundError,
} from "./errors.js";
import { resolveValidatedDoc, resolveValidatedDocForCloud } from "./validate.js";

/** Construction-time configuration for the service. */
export interface ShipServiceConfig {
  /** Absolute path of the artifacts directory (`<UserConfigDir>/ship/runs/`). */
  readonly runsDir: string;
  /** Default model when `input.model` is omitted. */
  readonly defaultModel: ModelSelection;
  /** Optional MCP servers passed through to every `cursor.run()` call. */
  readonly mcpServers?: Record<string, McpServerConfig>;
  /** Optional inline subagents re-passed on cloud resume per ED-5. */
  readonly agents?: Record<string, AgentDefinition>;
  /** Local/desktop runner; used when `input.runtime` is `"local"` or omitted. */
  readonly cursor: CursorRunner;
  /** Optional cloud runner; required at dispatch time only for `runtime: "cloud"`. */
  readonly cloudCursor?: CursorRunner;
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
}

// Per-run entry stored in the `ActiveRunsRegistry`. `handle` is set
// after the cursor SDK call resolves and lets `cancelRun` abort the
// in-flight run.
export interface ActiveRun {
  readonly controller: AbortController;
  handle?: CursorRunHandle;
}

/** Latest cloud `cursor_runs.agent_id` linked from the run's phases (by `startedAt`). */
function resolveLatestCloudCursorAgentId(store: Store, run: WorkflowRun): string | undefined {
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
  return latest?.agentId;
}

/** MCP `get_workflow_run` view: domain run plus derived cloud watch fields. */
function enrichWorkflowRunView(store: Store, run: WorkflowRun | null): GetWorkflowRunOutput | null {
  if (run === null) return null;
  const agentId = resolveLatestCloudCursorAgentId(store, run);
  if (agentId === undefined) return run;
  return {
    ...run,
    cursorAgentId: agentId,
    watchUrl: cursorWatchUrl(agentId),
  };
}

export function createShipService(deps: ShipServiceDeps): ShipService {
  const { clock, config, fs, store } = deps;
  const docSource = deps.docSource;
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
  const makeCtx = (input: ShipInput): ShipContext => ({
    activeRuns,
    clock,
    config,
    fs,
    ids,
    input,
    resolvedCursorRuntime: resolvePersistedRuntime(input),
    runner: selectRunner(config, input),
    store,
    ...(docSource !== undefined ? { docSource } : {}),
  });

  const resumeCtx: ResumeContext = {
    activeRuns,
    clock,
    config,
    fs,
    resumeBgPending,
    store,
  };

  const initialResume = resumeOrphanedRunsTracked(resumeCtx).catch((err: unknown) => {
    logResumeFailure(err);
  });

  const service: ShipService = {
    ship: (input) => runShip(makeCtx(input)),
    startShip: (input) => runShipStart(makeCtx(input), bgPending),
    getRun: (id) => Promise.resolve(enrichWorkflowRunView(store, store.getRun(id))),
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
  };

  return service;
}

interface ResumeContext {
  readonly activeRuns: ActiveRunsRegistry;
  readonly clock: () => string;
  readonly config: ShipServiceConfig;
  readonly fs: ShipFs;
  readonly resumeBgPending: Set<Promise<void>>;
  readonly store: Store;
}

function logResumeFailure(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`ship: resumeOrphanedRuns failed: ${message}\n`);
}

interface ShipContext {
  readonly activeRuns: ActiveRunsRegistry;
  readonly clock: () => string;
  readonly config: ShipServiceConfig;
  readonly docSource?: DocSource;
  readonly fs: ShipFs;
  readonly ids: NonNullable<ShipServiceDeps["ids"]>;
  readonly input: ShipInput;
  /** Value persisted to `cursor_runs.runtime` for this invocation. */
  readonly resolvedCursorRuntime: CursorRunRuntime;
  readonly runner: CursorRunner;
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

function resolvePersistedRuntime(input: ShipInput): CursorRunRuntime {
  return input.runtime === "cloud" ? "cloud" : "local";
}

function selectRunner(config: ShipServiceConfig, input: ShipInput): CursorRunner {
  if (input.runtime === "cloud") {
    if (config.cloudCursor === undefined) {
      throw new CloudRunnerNotConfiguredError();
    }
    return config.cloudCursor;
  }
  return config.cursor;
}

interface BuildCursorRunInputArgs {
  readonly ctx: ShipContext;
  readonly prep: PreparedRun;
  readonly prompt: string;
  readonly model: ModelSelection;
  readonly controller: AbortController;
  readonly onEvent: CursorRunInput["onEvent"];
}

function buildShipCursorRunInput(args: BuildCursorRunInputArgs): CursorRunInput {
  const { ctx, prep, prompt, model, controller, onEvent } = args;
  const base = {
    cwd: prep.effectiveWorkdir,
    prompt,
    model,
    ...(ctx.config.mcpServers !== undefined && { mcpServers: ctx.config.mcpServers }),
    ...(ctx.config.agents !== undefined && { agents: ctx.config.agents }),
    agentName: `ship/${prep.workflowRunId}`,
    signal: controller.signal,
    onEvent,
  } as const;
  if (ctx.input.runtime === "cloud") {
    return {
      ...base,
      runtime: "cloud",
      ...(ctx.input.cloud !== undefined && {
        cloud: ctx.input.cloud as NonNullable<CursorRunInput["cloud"]>,
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
          logBackgroundFailure(prep.workflowRunId, err);
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
  if (ctx.input.runtime === "cloud") {
    const validated = await resolveValidatedDocForCloud(
      ctx.fs,
      ctx.input.docPath,
      buildCloudDocResolveOptions(ctx),
    );
    return persistInitialState(ctx, validated);
  }
  if (ctx.input.workdir === undefined) {
    throw new WorkdirNotFoundError("(missing)");
  }
  const validated = await resolveValidatedDoc(ctx.fs, ctx.input.workdir, ctx.input.docPath);
  return persistInitialState(ctx, validated);
}

function resolveRepo(input: ShipInput): string {
  if (input.repo !== undefined) return input.repo;
  const url = input.cloud?.repos[0]?.url;
  if (url !== undefined) {
    const derived = parseGitHubRepoSlug(url);
    if (derived !== undefined) return derived;
  }
  throw new MissingRepoError();
}

/** Repo slug for remote doc fetch — derived from `cloud.repos[0].url` per F3. */
function resolveDocRepoSlug(input: ShipInput): string {
  const url = input.cloud?.repos[0]?.url;
  if (url !== undefined) {
    const derived = parseGitHubRepoSlug(url);
    if (derived !== undefined) return derived;
  }
  if (input.repo !== undefined) return input.repo;
  throw new MissingRepoError();
}

function buildCloudDocResolveOptions(ctx: ShipContext): CloudDocResolveOptions {
  const cloudRepo = ctx.input.cloud?.repos[0];
  return {
    repoSlug: resolveDocRepoSlug(ctx.input),
    ...(ctx.input.workdir !== undefined ? { workdir: ctx.input.workdir } : {}),
    ...(cloudRepo?.startingRef !== undefined ? { startingRef: cloudRepo.startingRef } : {}),
    ...(cloudRepo?.prUrl !== undefined ? { prUrl: cloudRepo.prUrl } : {}),
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
function logBackgroundFailure(workflowRunId: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(
    `ship-start: background continuation rejected after finalize: workflowRunId=${workflowRunId} err=${message}\n`,
  );
}

function persistInitialState(ctx: ShipContext, validated: ValidatedDoc): PreparedRun {
  const workflowRunId = ctx.ids.workflowRun();
  const phaseId = ctx.ids.phase();
  const paths = resolveRunArtifactPaths(ctx.config.runsDir, workflowRunId);

  const repo = resolveRepo(ctx.input);
  const baseRef = ctx.input.baseRef ?? DEFAULT_WORKFLOW_POLICY.baseRef;
  const cloudNoWorkdir = ctx.input.runtime === "cloud" && ctx.input.workdir === undefined;
  const effectiveWorkdir = ctx.input.workdir ?? paths.dir;
  const worktree: WorktreeRef = cloudNoWorkdir
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
    inputJson: JSON.stringify(
      ctx.input.runtime === "cloud" && ctx.input.cloud !== undefined
        ? { cloud: ctx.input.cloud, docPath: ctx.input.docPath }
        : { docPath: ctx.input.docPath },
    ),
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
  };
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

  let cursorRunId: string | undefined;
  let ndjson: EventWriter | undefined;
  let eventPump: EventPumpHandle | undefined;

  try {
    const prompt = await prepareArtifacts(ctx, prep);

    // Concurrent `cancelRun()` may have flipped the workflow + phase
    // rows to `cancelled` while we were doing fs work. Bail before
    // invoking the runner — its terminal status would otherwise
    // silently overwrite the cancellation.
    if (ctx.store.getRun(prep.workflowRunId)?.status === "cancelled") {
      return finalizeAlreadyCancelled(ctx, prep);
    }

    const model: ModelSelection = resolveModelSelection(ctx.input, ctx.config.defaultModel);
    ndjson = createNdjsonEventWriter(ctx.fs, prep.paths.events);
    const ndjsonRef = ndjson;

    const onEvent: CursorRunInput["onEvent"] = (ev) => {
      ndjsonRef.write(ev);
      eventPump?.heartbeat();
    };

    const runInput = buildShipCursorRunInput({
      ctx,
      prep,
      prompt,
      model,
      controller,
      onEvent,
    });

    const handle = await ctx.runner.run(runInput);

    if (ctx.resolvedCursorRuntime === "cloud") {
      eventPump = startEventPump({ store: ctx.store, workflowRunId: prep.workflowRunId });
    }

    cursorRunId = ctx.ids.cursorRun();
    ctx.store.recordCursorRun({
      id: cursorRunId,
      workflowRunId: prep.workflowRunId,
      agentId: handle.agentId,
      runId: handle.runId,
      runtime: ctx.resolvedCursorRuntime,
      model,
      artifactsDir: prep.paths.dir,
    });
    // Link the phase to the cursor-run so `getRun()` consumers can
    // join phase rows back to their `cursor_runs` metadata after
    // process restart.
    ctx.store.updatePhase(prep.phaseId, { cursorRunId });
    ctx.activeRuns.set(prep.workflowRunId, { controller, handle });

    const result = await handle.result;
    return await finalizeSuccess({
      ctx,
      cursorRunId,
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
    eventPump?.stop();
    if (ndjson !== undefined) {
      try {
        await ndjson.close();
      } catch {
        /* swallow — close errors after terminal don't change outcome */
      }
    }
  }
}

async function prepareArtifacts(ctx: ShipContext, prep: PreparedRun): Promise<string> {
  await ctx.fs.mkdir(prep.paths.dir, { recursive: true });
  const taskDoc =
    prep.validated.content ?? (await ctx.fs.readFile(prep.validated.absoluteDocPath, "utf-8"));
  await ctx.fs.writeFile(prep.paths.taskDoc, taskDoc);

  const prompt = renderImplementationPrompt({
    taskDoc,
    repo: prep.repo,
    worktreePath:
      prep.worktree.path === CLOUD_WORKTREE_SENTINEL
        ? CLOUD_WORKTREE_SENTINEL
        : prep.effectiveWorkdir,
    ...(ctx.input.branch !== undefined && { branch: ctx.input.branch }),
    baseRef: prep.baseRef,
  });
  await ctx.fs.writeFile(prep.paths.prompt, prompt);
  return prompt;
}

interface FinalizeSuccessArgs {
  readonly ctx: ShipContext;
  readonly cursorRunId: string;
  readonly paths: RunArtifactPaths;
  readonly phaseId: string;
  readonly result: CursorRunResult;
  readonly worktree: WorktreeRef;
  readonly workflowRunId: string;
}

async function finalizeSuccess(args: FinalizeSuccessArgs): Promise<ShipOutput> {
  const { ctx, paths, result } = args;
  const endedAt = ctx.clock();

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

  // Read current row status so a concurrent `cancelRun()` that already
  // flipped the workflow row to `cancelled` isn't overwritten by the
  // runner's terminal status. Phase + cursor-run rows still reflect the
  // run's actual outcome — they're internal-consistency markers.
  const isCancelled = ctx.store.getRun(args.workflowRunId)?.status === "cancelled";
  const terminal: TerminalWorkflowStatus = isCancelled ? "cancelled" : result.status;

  persistSuccessRows(ctx, args, terminal, endedAt, isCancelled);

  const updatedRun = ctx.store.getRun(args.workflowRunId);
  const cursorRunRef = ctx.store.getCursorRun(args.cursorRunId);
  return buildShipOutput({
    workflowRunId: args.workflowRunId,
    status: terminal,
    worktree: updatedRun?.worktree ?? args.worktree,
    cursorRun: assertTerminalCursorRunRef(cursorRunRef, terminal),
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
async function tryWriteSuccessArtifacts(
  ctx: ShipContext,
  paths: RunArtifactPaths,
  result: CursorRunResult,
): Promise<WriteOutcome> {
  try {
    await ctx.fs.writeFile(paths.result, `${JSON.stringify(result, null, 2)}\n`);
    if (result.summary !== undefined && result.summary !== "") {
      await ctx.fs.writeFile(paths.summary, result.summary);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, err };
  }
}

// Phase + cursor-run + workflow-run row updates on the success path.
// `isCancelled` is true when a concurrent `cancelRun()` already flipped
// the workflow row mid-flight; we keep the cursor + phase rows aligned
// with the runner's actual outcome but leave the workflow row at
// `cancelled` so the user's cancel intent isn't silently overwritten.
function persistSuccessRows(
  ctx: ShipContext,
  args: FinalizeSuccessArgs,
  terminal: TerminalWorkflowStatus,
  endedAt: string,
  isCancelled: boolean,
): void {
  const phasePatch: { status: TerminalWorkflowStatus; endedAt: string; errorMessage?: string } = {
    status: terminal,
    endedAt,
  };
  if (args.result.errorMessage !== undefined) phasePatch.errorMessage = args.result.errorMessage;
  ctx.store.updatePhase(args.phaseId, phasePatch);
  ctx.store.updateCursorRunStatus(args.cursorRunId, {
    status: terminal,
    endedAt,
    durationMs: args.result.durationMs,
    ...(args.result.artifacts !== undefined && { artifacts: [...args.result.artifacts] }),
  });
  if (!isCancelled) ctx.store.updateWorkflowRunStatus(args.workflowRunId, args.result.status);
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
  runner: CursorRunner,
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
    if (err instanceof CursorAgentNotFoundError) {
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
    cursorRun: synthesizeFailedCursorRun(
      prep.workflowRunId,
      prep.paths.dir,
      endedAt,
      "cancelled",
      ctx.resolvedCursorRuntime,
    ),
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

async function finalizeFailure(args: FinalizeFailureArgs): Promise<ShipOutput> {
  const { ctx } = args;
  const endedAt = ctx.clock();
  const errorChain = flattenErrorChain(args.err);
  // Single-level errors keep the raw message (back-compat with existing
  // assertions). Multi-level chains get the joined "L0: <msg> | L1: <msg>"
  // form so a single-field consumer still sees every level. The full
  // structured chain is also written to `result.json` for forensic use.
  const errorMessage =
    errorChain.length <= 1
      ? (errorChain[0]?.message ?? stringifyUnknown(args.err))
      : errorChain.map((e, i) => `L${String(i)}: ${e.message}`).join(" | ");

  const isCancelled = ctx.store.getRun(args.workflowRunId)?.status === "cancelled";
  const terminal: TerminalWorkflowStatus = isCancelled ? "cancelled" : "failed";

  persistFailureRows({ ctx, args, terminal, endedAt, errorMessage, isCancelled });
  await tryWriteFailureResult(ctx, args.paths.result, terminal, errorMessage, errorChain);

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
}

// Phase + (optional) cursor-run + workflow-run row updates on failure.
// `isCancelled` keeps the workflow row at `cancelled` if the user
// already cancelled mid-flight; phase + cursor-run rows align with the
// actual failure for internal consistency.
function persistFailureRows(p: PersistFailureRowsArgs): void {
  const { ctx, args, terminal, endedAt, errorMessage, isCancelled } = p;
  const phasePatch: { status: TerminalWorkflowStatus; endedAt: string; errorMessage?: string } = {
    status: terminal,
    endedAt,
  };
  if (!isCancelled) phasePatch.errorMessage = errorMessage;
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
async function tryWriteFailureResult(
  ctx: ShipContext,
  path: string,
  status: TerminalWorkflowStatus,
  errorMessage: string,
  errorChain: readonly ErrorChainEntry[],
): Promise<void> {
  try {
    const body = safeStringifyFailureResult({ status, errorMessage, errorChain });
    await ctx.fs.writeFile(path, `${body}\n`);
  } catch {
    // swallow
  }
}

interface FailureResultPayload {
  readonly status: string;
  readonly errorMessage: string;
  readonly errorChain: readonly ErrorChainEntry[];
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
  return synthesizeFailedCursorRun(
    args.workflowRunId,
    args.paths.dir,
    ctx.clock(),
    terminal,
    ctx.resolvedCursorRuntime,
  );
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
function synthesizeFailedCursorRun(
  workflowRunId: string,
  artifactsDir: string,
  endedAt: string,
  status: TerminalCursorRunStatus,
  runtime: CursorRunRuntime,
): CursorRunRef & { status: TerminalCursorRunStatus } {
  return {
    id: `cr_synthetic_${workflowRunId}`,
    agentId: "agent-not-created",
    runtime,
    status,
    startedAt: endedAt,
    endedAt,
    artifactsDir,
  };
}

async function resumeOrphanedRuns(ctx: ResumeContext): Promise<void> {
  if (ctx.config.cloudCursor === undefined) return;
  const rows = ctx.store.listResumableCloudCursorRuns();
  if (rows.length === 0) return;

  await Promise.allSettled(rows.map((row) => resumeOneOrphanedCloudRun(ctx, row)));
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
  readonly shipCtx: ShipContext;
  readonly worktree: WorktreeRef;
}

function buildResumeAttachContext(args: {
  ctx: ResumeContext;
  row: ResumableCloudCursorRun;
  phaseId: string;
  cloudSpec: CloudRunSpec;
  worktree: WorktreeRef;
  controller: AbortController;
}): ResumeAttachContext {
  const { ctx, row, phaseId, cloudSpec, worktree, controller } = args;
  const paths = resolveRunArtifactPaths(ctx.config.runsDir, row.workflowRunId);
  return {
    cloudSpec,
    controller,
    ndjson: createNdjsonEventWriter(ctx.fs, paths.events),
    paths,
    phaseId,
    row,
    shipCtx: resumeCtxAsShipContext(ctx, row.workflowRunId),
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

  const target = buildResumeAttachContext({
    cloudSpec,
    controller,
    ctx,
    phaseId: phase.id,
    row,
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
  const cloudCursor = ctx.config.cloudCursor;
  if (cloudCursor === undefined) return;

  let eventPump: EventPumpHandle | undefined;
  const onEvent: CursorRunAttachInput["onEvent"] = (ev) => {
    target.ndjson.write(ev);
    eventPump?.heartbeat();
  };

  try {
    const model = target.row.model ?? ctx.config.defaultModel;
    const handle = await cloudCursor.attach({
      agentId: target.row.agentId,
      cloud: target.cloudSpec,
      model,
      onEvent,
      runId: target.row.runId,
      signal: target.controller.signal,
      ...(ctx.config.mcpServers !== undefined && { mcpServers: ctx.config.mcpServers }),
      ...(ctx.config.agents !== undefined && { agents: ctx.config.agents }),
    });

    eventPump = startEventPump({ store: ctx.store, workflowRunId: target.row.workflowRunId });
    onPumpStarted(eventPump);
    ctx.activeRuns.set(target.row.workflowRunId, { controller: target.controller, handle });

    const result = await handle.result;
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
  }
}

async function handleResumeAttachError(
  ctx: ResumeContext,
  target: ResumeAttachContext,
  err: unknown,
): Promise<void> {
  if (err instanceof CursorAgentNotFoundError) {
    await finalizeResumeFailure(ctx, target.row, target.phaseId, target.worktree, {
      message: `cloud agent ${target.row.agentId} no longer reachable on resume`,
    });
    return;
  }
  await finalizeFailure({
    ctx: target.shipCtx,
    cursorRunId: target.row.id,
    err,
    paths: target.paths,
    phaseId: target.phaseId,
    worktree: target.worktree,
    workflowRunId: target.row.workflowRunId,
  });
}

function resumeCtxAsShipContext(ctx: ResumeContext, workflowRunId: string): ShipContext {
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
    resolvedCursorRuntime: "cloud",
    runner: ctx.config.cloudCursor ?? ctx.config.cursor,
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
    ctx: resumeCtxAsShipContext(ctx, row.workflowRunId),
    cursorRunId: row.id,
    err: new Error(args.message),
    paths,
    phaseId,
    worktree,
    workflowRunId: row.workflowRunId,
  });
}

/**
 * `ShipService` — the workflow brain. Owns the state machine, drives
 * the cursor runner, persists artifacts, and exposes the five public
 * methods MCP server / CLI consume. Constructed via `createShipService`
 * with all collaborators DI'd (store / cursor / fs / clock / config).
 */

import type {
  CursorRunHandle,
  CursorRunner,
  CursorRunResult,
  McpServerConfig,
} from "@ship/cursor-runner";
import type { ShipInput, ShipOutput, ShipStartOutput, ThinkingEffort } from "@ship/mcp";
import type { ListRunsFilter, Store } from "@ship/store";
import type {
  CursorRunRef,
  ModelSelection,
  TerminalCursorRunStatus,
  TerminalWorkflowStatus,
  WorkflowRun,
  WorkflowStatus,
  WorktreeRef,
} from "@ship/workflow";

import {
  DEFAULT_WORKFLOW_POLICY,
  newCursorRunId,
  newPhaseId,
  newWorkflowRunId,
} from "@ship/workflow";
import { basename } from "node:path";

import type { EventWriter } from "./artifacts/ndjson.js";
import type { ShipFs } from "./fs/shape.js";
import type { ValidatedDoc } from "./validate.js";

import { createNdjsonEventWriter } from "./artifacts/ndjson.js";
import { resolveRunArtifactPaths, type RunArtifactPaths } from "./artifacts/paths.js";
import { renderImplementationPrompt } from "./artifacts/prompt-template.js";
import { ArtifactWriteFailedError } from "./errors.js";
import { resolveValidatedDoc } from "./validate.js";

/** Construction-time configuration for the service. */
export interface ShipServiceConfig {
  /** Absolute path of the artifacts directory (`<UserConfigDir>/ship/runs/`). */
  readonly runsDir: string;
  /** Default model when `input.model` is omitted. */
  readonly defaultModel: ModelSelection;
  /** Optional MCP servers passed through to every `cursor.run()` call. */
  readonly mcpServers?: Record<string, McpServerConfig>;
}

/** All collaborators the service needs. Injected at construction time. */
export interface ShipServiceDeps {
  readonly store: Store;
  readonly cursor: CursorRunner;
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
  // for in-flight `ship` runs and `open_pr` runs so `cancelRun` can
  // signal whichever service holds the controller. Omitted → service
  // creates its own private map.
  readonly activeRuns?: ActiveRunsRegistry;
}

// Shared registry of in-flight runs. Each entry carries an
// `AbortController` whose `signal` the running service observes; the
// optional `handle` is `ShipService`-specific (it lets `cancelRun`
// abort an in-flight cursor SDK call). `OpenPrService` populates an
// entry without a handle. Exported so default wiring can construct a
// single Map and pass it to both services.
export type ActiveRunsRegistry = Map<string, ActiveRun>;

/** Public service surface. CLI + MCP server code against this. */
export interface ShipService {
  ship(input: ShipInput): Promise<ShipOutput>;
  // Async kickoff for the MCP `ship` tool — persists the row, transitions
  // to `running`, schedules the cursor continuation on the next tick, and
  // resolves with `{ workflowRunId, status: "running" }`. Callers poll
  // `getRun` for terminal state. CLI keeps using `ship` (blocking).
  startShip(input: ShipInput): Promise<ShipStartOutput>;
  getRun(workflowRunId: string): Promise<WorkflowRun | null>;
  listRuns(filter: ListRunsFilter): Promise<WorkflowRun[]>;
  cancelRun(workflowRunId: string): Promise<{ workflowRunId: string; status: WorkflowStatus }>;
  // Awaits every in-flight `startShip` background continuation to fully
  // settle (success, failure, or safety-net stderr log). Use this before
  // closing the store in tests / long-lived host processes — otherwise
  // a setImmediate continuation can race past `store.close()` and crash
  // with "database connection is not open" against the closed handle.
  // Resolves immediately if nothing is in flight.
  drainBackground(): Promise<void>;
}

// Per-run entry stored in the shared `ActiveRunsRegistry`. `handle` is
// `ShipService`-specific; `OpenPrService` populates an entry without one.
export interface ActiveRun {
  readonly controller: AbortController;
  handle?: CursorRunHandle;
}

export function createShipService(deps: ShipServiceDeps): ShipService {
  const { clock, config, cursor, fs, store } = deps;
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
  // `bgPending` stays per-`ShipService` even when `activeRuns` is
  // shared with `OpenPrService` — only `startShip` schedules these
  // un-awaited continuations, so there's nothing for `OpenPrService`
  // to drain through this Set.
  const bgPending = new Set<Promise<void>>();
  const makeCtx = (input: ShipInput): ShipContext => ({
    activeRuns,
    clock,
    config,
    cursor,
    fs,
    ids,
    input,
    store,
  });

  return {
    ship: (input) => runShip(makeCtx(input)),
    startShip: (input) => runShipStart(makeCtx(input), bgPending),
    getRun: (id) => Promise.resolve(store.getRun(id)),
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
      await Promise.allSettled([...bgPending]);
    },
  };
}

interface ShipContext {
  readonly activeRuns: ActiveRunsRegistry;
  readonly clock: () => string;
  readonly config: ShipServiceConfig;
  readonly cursor: CursorRunner;
  readonly fs: ShipFs;
  readonly ids: NonNullable<ShipServiceDeps["ids"]>;
  readonly input: ShipInput;
  readonly store: Store;
}

interface PreparedRun {
  readonly workflowRunId: string;
  readonly phaseId: string;
  readonly paths: RunArtifactPaths;
  readonly worktree: WorktreeRef;
  readonly baseRef: string;
  readonly validated: ValidatedDoc;
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
  // Pre-row validation throws cleanly with no row created.
  const validated = await resolveValidatedDoc(ctx.fs, ctx.input.workdir, ctx.input.docPath);
  return persistInitialState(ctx, validated);
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

  const baseRef = ctx.input.baseRef ?? DEFAULT_WORKFLOW_POLICY.baseRef;
  const branch = ctx.input.branch ?? "(unknown)";
  const worktreeName = ctx.input.worktreeName ?? (basename(ctx.input.workdir) || "workdir");
  const worktree: WorktreeRef = {
    repo: ctx.input.repo,
    name: worktreeName,
    branch,
    path: ctx.input.workdir,
    baseRef,
  };

  // Row exists from this point — fs and runner failures resolve with
  // a persisted `failed` ShipOutput rather than throwing past `ship()`.
  ctx.store.createWorkflowRun({
    id: workflowRunId,
    repo: ctx.input.repo,
    docPath: ctx.input.docPath,
    baseRef,
    worktree,
    policy: DEFAULT_WORKFLOW_POLICY,
  });
  ctx.store.appendPhase({
    id: phaseId,
    workflowRunId,
    kind: "implement",
    inputJson: JSON.stringify({ docPath: ctx.input.docPath }),
  });

  return { workflowRunId, phaseId, paths, worktree, baseRef, validated };
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

    const handle = await ctx.cursor.run({
      cwd: ctx.input.workdir,
      prompt,
      model,
      ...(ctx.config.mcpServers !== undefined && { mcpServers: ctx.config.mcpServers }),
      agentName: `ship/${prep.workflowRunId}`,
      signal: controller.signal,
      onEvent: (ev) => {
        ndjsonRef.write(ev);
      },
    });

    cursorRunId = ctx.ids.cursorRun();
    ctx.store.recordCursorRun({
      id: cursorRunId,
      workflowRunId: prep.workflowRunId,
      agentId: handle.agentId,
      runtime: "local",
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
  const taskDoc = await ctx.fs.readFile(prep.validated.absoluteDocPath, "utf-8");
  await ctx.fs.writeFile(prep.paths.taskDoc, taskDoc);

  const prompt = renderImplementationPrompt({
    taskDoc,
    repo: ctx.input.repo,
    worktreePath: ctx.input.workdir,
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
  });
  if (!isCancelled) ctx.store.updateWorkflowRunStatus(args.workflowRunId, args.result.status);
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
    cursorRun: synthesizeFailedCursorRun(prep.workflowRunId, prep.paths.dir, endedAt, "cancelled"),
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
  const errorMessage = args.err instanceof Error ? args.err.message : String(args.err);

  const isCancelled = ctx.store.getRun(args.workflowRunId)?.status === "cancelled";
  const terminal: TerminalWorkflowStatus = isCancelled ? "cancelled" : "failed";

  persistFailureRows({ ctx, args, terminal, endedAt, errorMessage, isCancelled });
  await tryWriteFailureResult(ctx, args.paths.result, terminal, errorMessage);

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

// Best-effort `result.json` write so the archive carries some forensics
// even on the failure path. Never propagates — errors are swallowed
// internally.
async function tryWriteFailureResult(
  ctx: ShipContext,
  path: string,
  status: TerminalWorkflowStatus,
  errorMessage: string,
): Promise<void> {
  try {
    await ctx.fs.writeFile(path, `${JSON.stringify({ status, errorMessage }, null, 2)}\n`);
  } catch {
    // swallow
  }
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
  return synthesizeFailedCursorRun(args.workflowRunId, args.paths.dir, ctx.clock(), terminal);
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
 * Resolves the per-run `ModelSelection` from `input` over the wiring
 * default. Three cases:
 *
 * - `input.model` set → fresh selection rooted on that id; carries
 *   `input.thinking` if provided, else has no `params` (caller
 *   explicitly overrode the model so we don't graft the wiring's
 *   `thinking` onto a possibly-incompatible model id).
 * - `input.thinking` set, `input.model` not → wiring default's id +
 *   params with `thinking` overwritten by the input value.
 * - Neither set → wiring default verbatim.
 */
function resolveModelSelection(input: ShipInput, defaultModel: ModelSelection): ModelSelection {
  const { model, thinking } = input;

  if (model !== undefined) {
    return {
      id: model,
      ...(thinking !== undefined && { params: [thinkingParam(thinking)] }),
    };
  }

  if (thinking !== undefined) {
    return {
      id: defaultModel.id,
      params: mergeThinkingParam(defaultModel.params, thinking),
    };
  }

  return defaultModel;
}

function thinkingParam(value: ThinkingEffort): { id: "thinking"; value: ThinkingEffort } {
  return { id: "thinking", value };
}

/**
 * Replaces or appends the `thinking` param without disturbing any
 * other params the wiring already configured. The current wiring
 * only sets `thinking`, but this keeps the override hygienic if more
 * defaults grow here later.
 */
function mergeThinkingParam(
  base: ModelSelection["params"],
  value: ThinkingEffort,
): NonNullable<ModelSelection["params"]> {
  const next: NonNullable<ModelSelection["params"]> = [];
  let replaced = false;
  for (const p of base ?? []) {
    if (p.id === "thinking") {
      next.push(thinkingParam(value));
      replaced = true;
    } else {
      next.push(p);
    }
  }
  if (!replaced) next.push(thinkingParam(value));
  return next;
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
): CursorRunRef & { status: TerminalCursorRunStatus } {
  return {
    id: `cr_synthetic_${workflowRunId}`,
    agentId: "agent-not-created",
    runtime: "local",
    status,
    startedAt: endedAt,
    endedAt,
    artifactsDir,
  };
}

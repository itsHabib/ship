/**
 * `ShipService` — the workflow brain. Owns the state machine, drives
 * the cursor runner, persists artifacts, and exposes the four V1
 * methods MCP server / CLI consume. Constructed via `createShipService`
 * with all collaborators DI'd (store / cursor / fs / clock / config).
 */

import type {
  CursorRunHandle,
  CursorRunner,
  CursorRunResult,
  McpServerConfig,
} from "@ship/cursor-runner";
import type { ShipInput, ShipOutput } from "@ship/mcp";
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
import { validateWorkdirAndDoc } from "./validate.js";

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
}

/** Public service surface. CLI + MCP server code against this. */
export interface ShipService {
  ship(input: ShipInput): Promise<ShipOutput>;
  getRun(workflowRunId: string): Promise<WorkflowRun | null>;
  listRuns(filter: ListRunsFilter): Promise<WorkflowRun[]>;
  cancelRun(workflowRunId: string): Promise<{ workflowRunId: string; status: WorkflowStatus }>;
}

interface ActiveRun {
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
  const activeRuns = new Map<string, ActiveRun>();

  return {
    ship: (input) => shipImpl({ activeRuns, clock, config, cursor, fs, ids, input, store }),
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
  };
}

interface ShipContext {
  readonly activeRuns: Map<string, ActiveRun>;
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

async function shipImpl(ctx: ShipContext): Promise<ShipOutput> {
  // Pre-row validation throws cleanly with no row created.
  const validated = await validateWorkdirAndDoc(ctx.fs, ctx.input.workdir, ctx.input.docPath);
  const prep = persistInitialState(ctx, validated);
  return executeAndFinalize(ctx, prep);
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

async function executeAndFinalize(ctx: ShipContext, prep: PreparedRun): Promise<ShipOutput> {
  // Register the controller BEFORE invoking the runner so an early
  // cancelRun() arriving during `cursor.run()` startup can abort the
  // pre-aborted signal — see Phase 6 § ED-2.
  const controller = new AbortController();
  ctx.activeRuns.set(prep.workflowRunId, { controller });

  let cursorRunId: string | undefined;
  let ndjson: EventWriter | undefined;

  try {
    const prompt = await prepareArtifacts(ctx, prep);
    ctx.store.updatePhase(prep.phaseId, { status: "running", startedAt: ctx.clock() });
    ctx.store.updateWorkflowRunStatus(prep.workflowRunId, "running");

    const model: ModelSelection = ctx.input.model
      ? { id: ctx.input.model }
      : ctx.config.defaultModel;
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

  try {
    await ctx.fs.writeFile(paths.result, `${JSON.stringify(result, null, 2)}\n`);
    if (result.summary !== undefined && result.summary !== "") {
      await ctx.fs.writeFile(paths.summary, result.summary);
    }
  } catch (err) {
    return await finalizeFailure({
      ctx: args.ctx,
      cursorRunId: args.cursorRunId,
      err: new ArtifactWriteFailedError("failed to persist run artifacts", { cause: err }),
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
  const currentRun = ctx.store.getRun(args.workflowRunId);
  const isCancelled = currentRun?.status === "cancelled";
  const cursorTerminal: TerminalCursorRunStatus = isCancelled ? "cancelled" : result.status;
  const finalStatus: TerminalWorkflowStatus = isCancelled ? "cancelled" : result.status;

  const phasePatch: { status: TerminalWorkflowStatus; endedAt: string; errorMessage?: string } = {
    status: cursorTerminal,
    endedAt,
  };
  if (result.errorMessage !== undefined) phasePatch.errorMessage = result.errorMessage;
  ctx.store.updatePhase(args.phaseId, phasePatch);
  ctx.store.updateCursorRunStatus(args.cursorRunId, {
    status: cursorTerminal,
    endedAt,
    durationMs: result.durationMs,
  });
  if (!isCancelled) {
    ctx.store.updateWorkflowRunStatus(args.workflowRunId, result.status);
  }

  const updatedRun = ctx.store.getRun(args.workflowRunId);
  const cursorRunRef = ctx.store.getCursorRun(args.cursorRunId);
  return buildShipOutput({
    workflowRunId: args.workflowRunId,
    status: finalStatus,
    worktree: updatedRun?.worktree ?? args.worktree,
    cursorRun: assertTerminalCursorRunRef(cursorRunRef, cursorTerminal),
    paths,
    summary: result.summary,
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

  const currentRun = ctx.store.getRun(args.workflowRunId);
  const isCancelled = currentRun?.status === "cancelled";
  const finalStatus: TerminalWorkflowStatus = isCancelled ? "cancelled" : "failed";

  const phasePatch: { status: TerminalWorkflowStatus; endedAt: string; errorMessage?: string } = {
    status: finalStatus,
    endedAt,
  };
  if (!isCancelled) phasePatch.errorMessage = errorMessage;
  ctx.store.updatePhase(args.phaseId, phasePatch);
  if (args.cursorRunId !== undefined) {
    try {
      ctx.store.updateCursorRunStatus(args.cursorRunId, {
        status: finalStatus,
        endedAt,
      });
    } catch {
      /* swallow — best-effort cleanup */
    }
  }
  if (!isCancelled) {
    ctx.store.updateWorkflowRunStatus(args.workflowRunId, "failed");
  }

  const updatedRun = ctx.store.getRun(args.workflowRunId);
  const cursorRunRef =
    args.cursorRunId !== undefined ? ctx.store.getCursorRun(args.cursorRunId) : null;

  // Best-effort: write a truncated result.json with the error so the
  // archive carries some forensics. If even that fails, swallow.
  try {
    await ctx.fs.writeFile(
      args.paths.result,
      `${JSON.stringify({ status: finalStatus, errorMessage }, null, 2)}\n`,
    );
  } catch {
    /* swallow */
  }

  return buildShipOutput({
    workflowRunId: args.workflowRunId,
    status: finalStatus,
    worktree: updatedRun?.worktree ?? args.worktree,
    cursorRun:
      cursorRunRef !== null
        ? assertTerminalCursorRunRef(cursorRunRef, finalStatus)
        : synthesizeFailedCursorRun(args.workflowRunId, args.paths.dir, ctx.clock(), finalStatus),
    paths: args.paths,
    summary: undefined,
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

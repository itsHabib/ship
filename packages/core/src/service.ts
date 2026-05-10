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

import type { ShipFs } from "./fs/shape.js";

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
  readonly handle: CursorRunHandle;
  readonly controller: AbortController;
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
  readonly prompt: string;
  readonly model: ModelSelection;
}

async function prepareRun(ctx: ShipContext): Promise<PreparedRun> {
  const { absoluteDocPath } = await validateWorkdirAndDoc(
    ctx.fs,
    ctx.input.workdir,
    ctx.input.docPath,
  );

  const workflowRunId = ctx.ids.workflowRun();
  const paths = resolveRunArtifactPaths(ctx.config.runsDir, workflowRunId);
  await ctx.fs.mkdir(paths.dir, { recursive: true });

  const taskDoc = await ctx.fs.readFile(absoluteDocPath, "utf-8");
  await ctx.fs.writeFile(paths.taskDoc, taskDoc);

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

  const prompt = renderImplementationPrompt({
    taskDoc,
    repo: ctx.input.repo,
    worktreePath: ctx.input.workdir,
    ...(ctx.input.branch !== undefined && { branch: ctx.input.branch }),
    baseRef,
  });
  await ctx.fs.writeFile(paths.prompt, prompt);

  ctx.store.createWorkflowRun({
    id: workflowRunId,
    repo: ctx.input.repo,
    docPath: ctx.input.docPath,
    baseRef,
    worktree,
    policy: DEFAULT_WORKFLOW_POLICY,
  });

  const phaseId = ctx.ids.phase();
  ctx.store.appendPhase({
    id: phaseId,
    workflowRunId,
    kind: "implement",
    inputJson: JSON.stringify({ docPath: ctx.input.docPath }),
  });
  ctx.store.updatePhase(phaseId, { status: "running", startedAt: ctx.clock() });
  ctx.store.updateWorkflowRunStatus(workflowRunId, "running");

  const model: ModelSelection = ctx.input.model ? { id: ctx.input.model } : ctx.config.defaultModel;

  return { workflowRunId, phaseId, paths, worktree, prompt, model };
}

async function shipImpl(ctx: ShipContext): Promise<ShipOutput> {
  const prep = await prepareRun(ctx);
  const ndjson = createNdjsonEventWriter(ctx.fs, prep.paths.events);
  const controller = new AbortController();
  let cursorRunId: string | undefined;

  try {
    const handle = await ctx.cursor.run({
      cwd: ctx.input.workdir,
      prompt: prep.prompt,
      model: prep.model,
      ...(ctx.config.mcpServers !== undefined && { mcpServers: ctx.config.mcpServers }),
      agentName: `ship/${prep.workflowRunId}`,
      signal: controller.signal,
      onEvent: (ev) => {
        ndjson.write(ev);
      },
    });

    cursorRunId = ctx.ids.cursorRun();
    ctx.store.recordCursorRun({
      id: cursorRunId,
      workflowRunId: prep.workflowRunId,
      agentId: handle.agentId,
      runtime: "local",
      model: prep.model,
      artifactsDir: prep.paths.dir,
    });

    ctx.activeRuns.set(prep.workflowRunId, { handle, controller });

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
    try {
      await ndjson.close();
    } catch {
      /* swallow — close errors after terminal don't change outcome */
    }
  }
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

  const terminalStatus: TerminalWorkflowStatus = result.status;
  const phasePatch: { status: typeof terminalStatus; endedAt: string; errorMessage?: string } = {
    status: terminalStatus,
    endedAt,
  };
  if (result.errorMessage !== undefined) phasePatch.errorMessage = result.errorMessage;
  ctx.store.updatePhase(args.phaseId, phasePatch);
  ctx.store.updateCursorRunStatus(args.cursorRunId, {
    status: terminalStatus,
    endedAt,
    durationMs: result.durationMs,
  });
  ctx.store.updateWorkflowRunStatus(args.workflowRunId, terminalStatus);

  const updatedRun = ctx.store.getRun(args.workflowRunId);
  const cursorRunRef = ctx.store.getCursorRun(args.cursorRunId);
  return buildShipOutput({
    workflowRunId: args.workflowRunId,
    status: terminalStatus,
    worktree: updatedRun?.worktree ?? args.worktree,
    cursorRun: assertTerminalCursorRunRef(cursorRunRef, terminalStatus),
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

  ctx.store.updatePhase(args.phaseId, {
    status: "failed",
    endedAt,
    errorMessage,
  });
  if (args.cursorRunId !== undefined) {
    try {
      ctx.store.updateCursorRunStatus(args.cursorRunId, {
        status: "failed",
        endedAt,
      });
    } catch {
      /* swallow — best-effort cleanup */
    }
  }
  ctx.store.updateWorkflowRunStatus(args.workflowRunId, "failed");

  const updatedRun = ctx.store.getRun(args.workflowRunId);
  const cursorRunRef =
    args.cursorRunId !== undefined ? ctx.store.getCursorRun(args.cursorRunId) : null;

  // Best-effort: try to write a truncated result.json with the error so the
  // archive carries some forensics. If even that fails, swallow — we're in
  // a failure path already.
  try {
    await ctx.fs.writeFile(
      args.paths.result,
      `${JSON.stringify({ status: "failed", errorMessage }, null, 2)}\n`,
    );
  } catch {
    /* swallow */
  }

  return buildShipOutput({
    workflowRunId: args.workflowRunId,
    status: "failed",
    worktree: updatedRun?.worktree ?? args.worktree,
    cursorRun:
      cursorRunRef !== null
        ? assertTerminalCursorRunRef(cursorRunRef, "failed")
        : synthesizeFailedCursorRun(args.workflowRunId, args.paths.dir, ctx.clock()),
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
 * Builds a synthetic failed cursor-run ref when we never got far enough
 * to record one (e.g. cursor.run() rejected before returning a handle).
 * Used to produce a coherent ShipOutput in those edge cases.
 */
function synthesizeFailedCursorRun(
  workflowRunId: string,
  artifactsDir: string,
  endedAt: string,
): CursorRunRef & { status: TerminalCursorRunStatus } {
  return {
    id: `cr_synthetic_${workflowRunId}`,
    agentId: "agent-not-created",
    runtime: "local",
    status: "failed",
    startedAt: endedAt,
    endedAt,
    artifactsDir,
  };
}

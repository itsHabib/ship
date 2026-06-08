/**
 * `RoomCursorRunner` — drives a Cursor agent inside a disposable rooms
 * microVM. Unlike Local/Cloud it is NOT an `@cursor/sdk` caller (the SDK
 * runs inside the VM): it is a subprocess orchestrator over the `rooms`
 * binary (ED-1). It spawns `rooms run`, reads the host-collected `--out`
 * contract artifacts, replays `events.ndjson` through `onEvent`, then
 * resolves a `CursorRunResult` whose `branches[]` carries the pushed
 * branch — the same shape `CloudCursorRunner` returns (ED-2). PR opening
 * is downstream (ED-3). See `docs/features/rooms-backend/spec.md`.
 */

import type { SDKMessage } from "@cursor/sdk";

import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CursorRunAttachInput,
  CursorRunHandle,
  CursorRunInput,
  CursorRunner,
  CursorRunResult,
  RoomRunSpec,
} from "./runner.js";

import {
  cursorRunFailedError,
  CursorRunFailedError,
  InvalidRoomReposError,
  MissingRoomImageError,
  MissingRoomSpecError,
  RoomArtifactError,
  RoomResumeNotSupportedError,
  RoomSchemaVersionError,
  WrongRunnerError,
} from "./errors.js";

// Pinned rooms artifact contract version (rooms `SCHEMA_VERSION`,
// `rooms/src/artifacts.rs`). A mismatch bails loudly rather than letting a
// silent contract drift mis-report a run.
const ROOMS_SCHEMA_VERSION = 1;

const SUCCEEDED_STATUSES = new Set([
  "success",
  "succeeded",
  "finished",
  "completed",
  "ok",
  "passed",
]);
const CANCELLED_STATUSES = new Set(["cancelled", "canceled", "aborted"]);
const FAILED_STATUSES = new Set(["failed", "failure", "error", "errored"]);

/** Options for the host `rooms` subprocess. `signal`-handling is the runner's job, not spawn's. */
export interface RoomsSpawnOptions {
  readonly env: NodeJS.ProcessEnv;
}

/** Minimal child-process shape the runner drives. `node:child_process` `ChildProcess` satisfies it. */
export interface RoomsChild {
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  kill(signal?: number | NodeJS.Signals): boolean;
}

/** Spawn seam — injectable so unit tests drive the orchestrator without a real `rooms` binary. */
export type RoomsSpawn = (
  command: string,
  args: readonly string[],
  options: RoomsSpawnOptions,
) => RoomsChild;

const defaultRoomsSpawn: RoomsSpawn = (command, args, options) =>
  nodeSpawn(command, [...args], { env: options.env, stdio: ["ignore", "inherit", "inherit"] });

/** Construction-time configuration. All optional; production omits them. */
export interface RoomCursorRunnerOptions {
  /** `rooms` binary resolved on PATH. Default: `"rooms"`. */
  readonly roomsBin?: string;
  /** Spawn seam override (tests). Default: `node:child_process` spawn. */
  readonly spawn?: RoomsSpawn;
  /** Fallback guest image when `room.image` is unset. The rooms CLI requires `--image`, so `run()` rejects with `MissingRoomImageError` when neither is set. */
  readonly defaultImage?: string;
}

/** Construct once, reuse across runs. The runner holds no per-run state. */
export class RoomCursorRunner implements CursorRunner {
  readonly #roomsBin: string;
  readonly #spawn: RoomsSpawn;
  readonly #defaultImage: string | undefined;

  constructor(opts: RoomCursorRunnerOptions = {}) {
    this.#roomsBin = opts.roomsBin ?? "rooms";
    this.#spawn = opts.spawn ?? defaultRoomsSpawn;
    this.#defaultImage = opts.defaultImage;
  }

  run(input: CursorRunInput): Promise<CursorRunHandle> {
    if (input.runtime !== "rooms") {
      return Promise.reject(
        new WrongRunnerError('RoomCursorRunner requires input.runtime === "rooms"'),
      );
    }
    if (input.room === undefined) {
      return Promise.reject(new MissingRoomSpecError());
    }
    // Runtime guard for non-TS callers; `repos` is typed as a 1-tuple for normal TS usage.
    const repos = (input.room as { repos?: unknown }).repos;
    if (!Array.isArray(repos) || repos.length !== 1) {
      return Promise.reject(new InvalidRoomReposError(Array.isArray(repos) ? repos.length : 0));
    }
    // The rooms CLI requires --image (no default). Reject up front rather than
    // letting clap fail inside the subprocess.
    const image = input.room.image ?? this.#defaultImage;
    if (image === undefined || image === "") {
      return Promise.reject(new MissingRoomImageError());
    }
    return Promise.resolve(this.#buildHandle(input, input.room, image));
  }

  attach(input: CursorRunAttachInput): Promise<CursorRunHandle> {
    return Promise.reject(new RoomResumeNotSupportedError({ agentId: input.agentId }));
  }

  #buildHandle(input: CursorRunInput, room: RoomRunSpec, image: string): CursorRunHandle {
    const agentId = `room-${randomUUID()}`;
    const runId = `run-${randomUUID()}`;
    let terminated = false;
    let cancelRequested = false;
    let child: RoomsChild | undefined;
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

    const cancelInternal = (): Promise<void> => {
      if (terminated || cancelRequested) return Promise.resolve();
      cancelRequested = true;
      killChild(child);
      return Promise.resolve();
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

    void this.#runPipeline(input, room, image, {
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
      isCancelRequested: () => cancelRequested,
      setChild: (c) => {
        child = c;
        if (cancelRequested) killChild(c);
      },
    });

    return { agentId, cancel: cancelInternal, result, runId };
  }

  async #runPipeline(
    input: CursorRunInput,
    room: RoomRunSpec,
    image: string,
    cb: RoomPipelineCallbacks,
  ): Promise<void> {
    let tmpRoot: string | undefined;
    try {
      tmpRoot = await mkdtemp(join(tmpdir(), "ship-rooms-"));
      const outDir = join(tmpRoot, "out");
      await mkdir(outDir, { recursive: true });
      const taskPath = join(tmpRoot, "task.md");
      await writeFile(taskPath, input.prompt);

      if (cb.isCancelRequested()) {
        cb.finalizeOk(cancelledResult());
        await safeRemove(tmpRoot);
        return;
      }

      const args = buildRoomsArgs({
        baseSha: room.repos[0].startingRef ?? "HEAD",
        image,
        model: input.model.id,
        outDir,
        pushBranch: room.pushBranch ?? derivePushBranch(input.agentName),
        repoUrl: room.repos[0].url,
        taskPath,
      });
      const child = this.#spawn(this.#roomsBin, args, { env: buildRoomsEnv() });
      cb.setChild(child);
      this.#wireChild(child, { cb, input, outDir, repoUrl: room.repos[0].url, tmpRoot });
    } catch (err) {
      // Setup failed before any artifacts were written — nothing to debug, so
      // clean up the temp dir we may have created.
      if (tmpRoot !== undefined) await safeRemove(tmpRoot);
      cb.finalizeError(cursorRunFailedError("rooms run setup failed", err));
    }
  }

  #wireChild(child: RoomsChild, ctx: RoomCollectContext): void {
    child.on("error", (err: Error): void => {
      ctx.cb.finalizeError(cursorRunFailedError("rooms subprocess failed", err));
    });
    child.on("close", (code: number | null): void => {
      void this.#collectAndFinalize(ctx, code);
    });
  }

  async #collectAndFinalize(ctx: RoomCollectContext, exitCode: number | null): Promise<void> {
    if (ctx.cb.isCancelRequested()) {
      ctx.cb.finalizeOk(cancelledResult());
      await safeRemove(ctx.tmpRoot);
      return;
    }
    try {
      const result = await collectRoomRun({
        onEvent: ctx.input.onEvent,
        outDir: ctx.outDir,
        repoUrl: ctx.repoUrl,
      });
      // A cancel that landed while artifacts were being read/replayed wins —
      // don't resolve a killed run as succeeded.
      if (ctx.cb.isCancelRequested()) {
        ctx.cb.finalizeOk(cancelledResult());
        await safeRemove(ctx.tmpRoot);
        return;
      }
      // A nonzero rooms exit (e.g. the push failed after the agent succeeded)
      // overrides a stale `succeeded` in result.json.
      const finalResult = applyExitCode(result, exitCode);
      ctx.cb.finalizeOk(finalResult);
      if (finalResult.status === "succeeded") await safeRemove(ctx.tmpRoot);
    } catch (err) {
      ctx.cb.finalizeError(
        err instanceof CursorRunFailedError
          ? err
          : cursorRunFailedError("failed to collect rooms artifacts", err),
      );
    }
  }
}

interface RoomPipelineCallbacks {
  finalizeOk: (terminal: CursorRunResult) => void;
  finalizeError: (err: unknown) => void;
  isCancelRequested: () => boolean;
  setChild: (child: RoomsChild) => void;
}

interface RoomCollectContext {
  cb: Pick<RoomPipelineCallbacks, "finalizeOk" | "finalizeError" | "isCancelRequested">;
  input: CursorRunInput;
  outDir: string;
  repoUrl: string;
  tmpRoot: string;
}

// --- artifact collection (replay events, THEN build result) ---

interface RoomResultJson {
  readonly schema_version?: unknown;
  readonly status?: unknown;
  readonly exit_code?: unknown;
  readonly started_at?: unknown;
  readonly ended_at?: unknown;
  readonly pushed_branch?: unknown;
}

async function collectRoomRun(args: {
  outDir: string;
  repoUrl: string;
  onEvent: CursorRunInput["onEvent"];
}): Promise<CursorRunResult> {
  const parsed = await readResultJson(join(args.outDir, "result.json"));
  assertSchemaVersion(parsed);
  // Replay BEFORE the result resolves — local/cloud stream live; rooms
  // replays terminally, but the onEvent-before-result ordering must hold.
  await replayRoomEvents(join(args.outDir, "events.ndjson"), args.onEvent);
  const summary = await readFileOptional(join(args.outDir, "summary.md"));
  return buildRoomResult(parsed, summary, args.repoUrl);
}

async function readResultJson(resultPath: string): Promise<RoomResultJson> {
  const raw = await readFileOrThrow(resultPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new RoomArtifactError(`rooms result.json is not valid JSON (${resultPath})`, {
      cause: err,
    });
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new RoomArtifactError(`rooms result.json is not an object (${resultPath})`);
  }
  return parsed;
}

function assertSchemaVersion(parsed: RoomResultJson): void {
  if (parsed.schema_version !== ROOMS_SCHEMA_VERSION) {
    throw new RoomSchemaVersionError({
      expected: ROOMS_SCHEMA_VERSION,
      received: parsed.schema_version,
    });
  }
}

function buildRoomResult(
  parsed: RoomResultJson,
  summary: string | undefined,
  repoUrl: string,
): CursorRunResult {
  const status = mapRoomsStatus(parsed.status, parsed.exit_code);
  const pushedBranch =
    typeof parsed.pushed_branch === "string" && parsed.pushed_branch !== ""
      ? parsed.pushed_branch
      : undefined;
  const out: {
    status: CursorRunResult["status"];
    durationMs: number;
    branches: CursorRunResult["branches"];
    summary?: string;
    errorMessage?: string;
    sdkTerminalStatus?: string;
  } = {
    branches: pushedBranch !== undefined ? [{ branch: pushedBranch, repoUrl }] : [],
    durationMs: computeDurationMs(parsed.started_at, parsed.ended_at),
    status,
  };
  if (summary !== undefined && summary !== "") out.summary = summary;
  if (typeof parsed.status === "string" && parsed.status !== "") {
    out.sdkTerminalStatus = parsed.status;
  }
  if (status === "failed") out.errorMessage = buildRoomErrorMessage(parsed, summary);
  return out;
}

function mapRoomsStatus(
  statusRaw: unknown,
  exitCodeRaw: unknown,
): "succeeded" | "failed" | "cancelled" {
  const s = typeof statusRaw === "string" ? statusRaw.toLowerCase() : "";
  if (SUCCEEDED_STATUSES.has(s)) return "succeeded";
  if (CANCELLED_STATUSES.has(s)) return "cancelled";
  if (FAILED_STATUSES.has(s)) return "failed";
  // Unknown status vocabulary — infer from exit_code so a wording change
  // degrades gracefully instead of mis-reporting.
  return exitCodeRaw === 0 ? "succeeded" : "failed";
}

function computeDurationMs(startedRaw: unknown, endedRaw: unknown): number {
  if (typeof startedRaw !== "string" || typeof endedRaw !== "string") return 0;
  const start = Date.parse(startedRaw);
  const end = Date.parse(endedRaw);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  const ms = end - start;
  return ms >= 0 ? ms : 0;
}

function buildRoomErrorMessage(parsed: RoomResultJson, summary: string | undefined): string {
  if (summary !== undefined && summary !== "") return summary;
  const status =
    typeof parsed.status === "string" && parsed.status !== "" ? parsed.status : "unknown";
  const exitPart =
    typeof parsed.exit_code === "number" ? ` (exit_code ${String(parsed.exit_code)})` : "";
  return `rooms run reported status "${status}"${exitPart}`;
}

async function replayRoomEvents(
  eventsPath: string,
  onEvent: CursorRunInput["onEvent"],
): Promise<void> {
  const raw = await readFileOptional(eventsPath);
  if (raw === undefined) return;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    emitRoomEvent(trimmed, onEvent);
  }
}

function emitRoomEvent(line: string, onEvent: CursorRunInput["onEvent"]): void {
  let ev: SDKMessage;
  try {
    ev = JSON.parse(line) as SDKMessage;
  } catch {
    return; // skip malformed lines
  }
  try {
    const maybePromise: unknown = onEvent(ev);
    if (isPromiseLike(maybePromise)) {
      maybePromise.then(undefined, () => {
        /* swallow */
      });
    }
  } catch {
    /* swallow — onEvent is fire-and-forget (ED-4) */
  }
}

// --- argv / env builders ---

function buildRoomsArgs(args: {
  baseSha: string;
  image: string;
  model: string;
  outDir: string;
  pushBranch: string;
  repoUrl: string;
  taskPath: string;
}): string[] {
  return [
    "run",
    "--runner",
    "cursor",
    "--image",
    args.image,
    "--repo",
    args.repoUrl,
    "--base-sha",
    args.baseSha,
    "--task",
    args.taskPath,
    "--model",
    args.model,
    "--push-branch",
    args.pushBranch,
    "--out",
    args.outDir,
  ];
}

// Fold a nonzero rooms subprocess exit into the result. rooms writes
// `result.json` from the agent's exit status BEFORE a push error surfaces, so
// a push failure can leave a stale `succeeded` there while the process exits
// nonzero. A non-clean exit downgrades a `succeeded` result to `failed`;
// results that already reported failed/cancelled are left untouched.
function applyExitCode(result: CursorRunResult, exitCode: number | null): CursorRunResult {
  if (exitCode === 0) return result;
  if (result.status !== "succeeded") return result;
  const detail = exitCode === null ? "a signal" : `code ${String(exitCode)}`;
  const errorMessage =
    result.summary !== undefined && result.summary !== ""
      ? result.summary
      : `rooms exited with ${detail}`;
  return { ...result, errorMessage, status: "failed" };
}

// GH_TOKEN (← GH_TOKEN ?? GITHUB_TOKEN) + the inherited CURSOR_API_KEY /
// ANTHROPIC_API_KEY ride the subprocess ENV, never argv — rooms forwards
// push-only into the guest.
function buildRoomsEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const ghToken = process.env["GH_TOKEN"] ?? process.env["GITHUB_TOKEN"];
  if (ghToken !== undefined && ghToken !== "") env["GH_TOKEN"] = ghToken;
  return env;
}

// `rooms/<slug(agentName) || "run">-<short-uuid>` — always uuid-suffixed.
// agentName is conventionally `ship/<workflowRunId>`.
function derivePushBranch(agentName: string | undefined): string {
  const slug = agentName !== undefined ? slugify(agentName) : "";
  const label = slug !== "" ? slug : "run";
  return `rooms/${label}-${randomUUID().slice(0, 8)}`;
}

function slugify(value: string): string {
  // Split on runs of non-alphanumerics and drop empties — collapses
  // separators and trims leading/trailing dashes without an anchored,
  // backtracking-prone regex.
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 0)
    .join("-");
}

// --- small helpers ---

function cancelledResult(): CursorRunResult {
  return { branches: [], durationMs: 0, status: "cancelled" };
}

async function readFileOrThrow(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch (err) {
    throw new RoomArtifactError(`rooms artifact not found or unreadable: ${path}`, { cause: err });
  }
}

async function readFileOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return undefined;
  }
}

async function safeRemove(path: string): Promise<void> {
  try {
    await rm(path, { force: true, recursive: true });
  } catch {
    /* swallow — cleanup failure doesn't change the run outcome */
  }
}

function killChild(child: RoomsChild | undefined): void {
  if (child === undefined) return;
  try {
    child.kill();
  } catch {
    /* swallow — best-effort cancel */
  }
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

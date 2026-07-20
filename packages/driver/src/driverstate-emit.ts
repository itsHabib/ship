/**
 * Best-effort driver-state ledger emission (workbench spec §4 D1 / §9 P5),
 * receipts-grade like the park-receipts write in `engine.ts`: a ledger write
 * failure NEVER fails a tick or a driver verb — it logs at warn and continues.
 *
 * Mechanism: a store decorator over the three driver mutations every lifecycle
 * transition funnels through (`insertDriverRun`, `updateDriverStream`,
 * `updateDriverRunStatus`), so the ~15 engine/judgment/land call sites need no
 * per-site hooks and the SQLite store stays untouched engine-internal state.
 * All ledger mechanics (canonical encoding, chain, transition validation) live
 * in `@ship/driverstate-emitter`; this module only maps store deltas to event
 * kinds. The emitter's own state machine rejects an out-of-order emission —
 * that rejection is logged and swallowed, never retrofitted onto ship's flow.
 */

import type { Logger } from "@ship/logger";
import type {
  ConsumeReviewArtifactInput,
  DriverRun,
  DriverStream,
  Store,
  UpdateDriverStreamInput,
} from "@ship/store";

import { appendEvent, type AppendResult, releaseRun } from "@ship/driverstate-emitter";
import { prNumberFromUrl } from "@ship/receipt";

import { parseManifest } from "./manifest.js";

/** Ship `drv_<ulid>` → ledger `dsr_<ulid>` — deterministic, no mapping table. */
export function ledgerRunId(driverRunId: string): string {
  return `dsr_${driverRunId.replace(/^drv_/, "")}`;
}

/** Ship `ds_<ulid>` → ledger `dss_<ulid>`. */
export function ledgerStreamId(streamId: string): string {
  return `dss_${streamId.replace(/^ds_/, "")}`;
}

/**
 * Deterministic event id per discriminator: a retried mutation re-mints the
 * same id, so the emitter's idempotent append absorbs store-level replays.
 * Uniqueness only matters within one run's ledger, so the run id stays out.
 */
function eventId(discriminator: string): string {
  return `evt_${discriminator}`;
}

/**
 * Wraps `store` so driver lifecycle mutations additionally emit driver-state
 * events. Returns a store with identical behavior on every verb; emission
 * failures are logged via `logger` (when given) and never propagate.
 */
export function withDriverStateEmission(store: Store, logger?: Logger): Store {
  const emit = (driverRunId: string, result: AppendResult): void => {
    if (result.ok) return;
    logger?.warn(
      { driverRunId, err: result.error },
      "driverstate: ledger emission failed; continuing (best-effort)",
    );
  };

  return {
    ...store,
    insertDriverRun: (input) => {
      const run = store.insertDriverRun(input);
      try {
        emit(run.id, emitRunImported(run, input.sourceJson, input.manifestPath));
        closePreCompletedStreams(run, emit);
      } catch (err) {
        logger?.warn({ driverRunId: run.id, err: String(err) }, "driverstate: emission threw");
      }
      return run;
    },
    updateDriverStream: (id, patch) => {
      const stream = store.updateDriverStream(id, patch);
      try {
        emitStreamDelta(stream, patch, emit);
      } catch (err) {
        logger?.warn({ streamId: id, err: String(err) }, "driverstate: emission threw");
      }
      return stream;
    },
    updateDriverRunStatus: (id, status) => {
      const run = store.updateDriverRunStatus(id, status);
      try {
        emitRunTerminal(run, status, emit);
      } catch (err) {
        logger?.warn({ driverRunId: id, err: String(err) }, "driverstate: emission threw");
      }
      return run;
    },
    consumeReviewArtifactAndPrepareDispatch: (input) => {
      store.consumeReviewArtifactAndPrepareDispatch(input);
      try {
        emitReviewCycle(input, emit);
      } catch (err) {
        logger?.warn({ streamId: input.streamId, err: String(err) }, "driverstate: emission threw");
      }
    },
  };
}

/**
 * The address flow moves a stream back to `dispatching` through this atomic
 * store op, bypassing `updateDriverStream` — in ledger terms the stream stays
 * `pr_open` and the round is a `review_cycle` (the only legal pr_open event).
 * findings is -1: the count is not known at this seam, only that a settled
 * review round is being addressed.
 */
function emitReviewCycle(input: ConsumeReviewArtifactInput, emit: Emit): void {
  emit(
    input.driverRunId,
    appendEvent({
      actor: `ship:${input.driverRunId}`,
      body: { cycle: Math.max(1, input.addressCycle), findings: -1, panel_settled: true },
      id: eventId(`${ledgerStreamId(input.streamId)}_cycle_${String(input.addressCycle)}`),
      kind: "review_cycle",
      runId: ledgerRunId(input.driverRunId),
      stream: ledgerStreamId(input.streamId),
    }),
  );
}

function emitRunImported(run: DriverRun, sourceJson: string, manifestPath: string): AppendResult {
  const parsed = parseManifest(sourceJson);
  const manifest: unknown = parsed.ok ? parsed.manifest : { unparsed: true };
  const generatedAt = parsed.ok ? parsed.manifest.generated_at : "";
  const streams = run.batches.flatMap((batch) =>
    batch.streams.map((s) => ({
      batch: batch.batchIndex,
      doc_path: s.specPath,
      stream: ledgerStreamId(s.id),
    })),
  );
  return appendEvent({
    actor: `ship:${run.id}`,
    body: {
      generated_at: generatedAt,
      manifest,
      repo: run.repo,
      source: manifestPath,
      streams,
    },
    extRef: run.id,
    id: eventId(`${ledgerRunId(run.id)}_imported`),
    kind: "run_imported",
    runId: ledgerRunId(run.id),
  });
}

type Emit = (driverRunId: string, result: AppendResult) => void;

/**
 * A manifest can import streams already `done` or `skipped` (absorbed
 * progress). The ledger did not track that work, so record each as
 * `stream_skipped` — pending → skipped, terminal — with the ship status in
 * the reason; otherwise they block `run_finished` forever. Non-terminal
 * absorbed statuses (landed, failed) are left pending: their live tail
 * (land, retry, skip) emits real transitions from pending legally.
 */
function closePreCompletedStreams(run: DriverRun, emit: Emit): void {
  for (const s of run.batches.flatMap((b) => b.streams)) {
    if (s.status !== "done" && s.status !== "skipped") {
      continue;
    }
    emit(
      run.id,
      appendEvent({
        actor: `ship:${run.id}`,
        body: { reason: `progress absorbed at import (ship status: ${s.status})` },
        id: eventId(`${ledgerStreamId(s.id)}_import_absorbed`),
        kind: "stream_skipped",
        runId: ledgerRunId(run.id),
        stream: ledgerStreamId(s.id),
      }),
    );
  }
}

interface StreamEventCtx {
  actor: string;
  runId: string;
  stream: string;
  seq: number;
}

function emitStreamDelta(stream: DriverStream, patch: UpdateDriverStreamInput, emit: Emit): void {
  const ctx: StreamEventCtx = {
    actor: `ship:${stream.driverRunId}`,
    runId: ledgerRunId(stream.driverRunId),
    seq: Math.max(1, stream.attempts.length),
    stream: ledgerStreamId(stream.id),
  };
  const send = (result: AppendResult): void => {
    emit(stream.driverRunId, result);
  };
  emitStatusEvent(stream, patch, ctx, send);
  emitPrEvents(stream, patch, ctx, send);
}

type Send = (result: AppendResult) => void;

/** The status-delta events: dispatch, terminal attempt (landed/failed), skip. */
function emitStatusEvent(
  stream: DriverStream,
  patch: UpdateDriverStreamInput,
  ctx: StreamEventCtx,
  send: Send,
): void {
  if (patch.status === "dispatching") {
    send(appendEvent(dispatchedEvent(stream, ctx)));
    return;
  }
  if (patch.status === "landed" || patch.status === "failed") {
    send(appendEvent(attemptEvent(stream, patch.status, ctx)));
    return;
  }
  if (patch.status === "skipped") {
    send(appendEvent(skippedEvent(stream, ctx)));
    return;
  }
  // Dispatch-fallback hop: a terminal failed attempt arrives in the same patch
  // that resets the stream to `pending` for the next target — record the
  // attempt (ledger dispatched → failed) so the hop is not a silent gap; the
  // re-dispatch then transitions failed → dispatched legally.
  if (patch.status === "pending" && isTerminalFailedAttempt(patch)) {
    send(appendEvent(attemptEvent(stream, "failed", ctx)));
  }
}

function isTerminalFailedAttempt(patch: UpdateDriverStreamInput): boolean {
  const last = patch.attempts?.at(-1);
  return last?.terminal === true && last.failureCategory !== undefined;
}

function dispatchedEvent(
  stream: DriverStream,
  ctx: StreamEventCtx,
): Parameters<typeof appendEvent>[0] {
  const base = { actor: ctx.actor, runId: ctx.runId, stream: ctx.stream };
  // Keyed by the UPCOMING attempt (length + 1), not the last recorded one —
  // a retry/hop re-dispatch must mint a fresh id or idempotent append would
  // swallow it as a replay of the first dispatch.
  const dispatchSeq = stream.attempts.length + 1;
  return {
    ...base,
    body: { engine: "ship" },
    id: eventId(`${ctx.stream}_dispatch_${String(dispatchSeq)}`),
    kind: "stream_dispatched",
  };
}

function attemptEvent(
  stream: DriverStream,
  status: "landed" | "failed",
  ctx: StreamEventCtx,
): Parameters<typeof appendEvent>[0] {
  const { seq, ...base } = ctx;
  // Prefer the engine's structured classification on the latest attempt
  // (bounded vocabulary: sdk-throw, gateway categories, …); the raw
  // errorMessage is the fallback, "engine_failure" the floor.
  const category =
    stream.attempts.at(-1)?.failureCategory ?? stream.errorMessage ?? "engine_failure";
  const failure = status === "failed" ? { failure_category: category } : {};
  return {
    ...base,
    body: { doc_path: stream.specPath, seq, terminal: true, ...failure },
    id: eventId(`${ctx.stream}_attempt_${String(seq)}_${status}`),
    kind: "stream_attempt",
  };
}

function skippedEvent(
  stream: DriverStream,
  ctx: StreamEventCtx,
): Parameters<typeof appendEvent>[0] {
  const base = { actor: ctx.actor, runId: ctx.runId, stream: ctx.stream };
  return {
    ...base,
    body: { reason: stream.errorMessage ?? "" },
    id: eventId(`${ctx.stream}_skipped`),
    kind: "stream_skipped",
  };
}

/** The PR-fact events: pr_opened when a PR number lands, merged when the merge commit does. */
function emitPrEvents(
  stream: DriverStream,
  patch: UpdateDriverStreamInput,
  ctx: StreamEventCtx,
  send: Send,
): void {
  emitPrOpened(stream, patch, ctx, send);
  emitMerged(stream, patch, ctx, send);
}

// The landed patch carries prUrl (buildLandedPatch); prNumber often only
// arrives at merge time — trigger on either, resolving the number from the
// URL, so pr_opened precedes review_cycle/stream_merged in the ledger.
function emitPrOpened(
  stream: DriverStream,
  patch: UpdateDriverStreamInput,
  ctx: StreamEventCtx,
  send: Send,
): void {
  if (patch.prUrl === undefined && patch.prNumber === undefined) {
    return;
  }
  const url = patch.prUrl ?? stream.prUrl ?? "";
  const pr = patch.prNumber ?? stream.prNumber ?? prNumberFromUrl(url);
  if (pr === undefined) {
    return;
  }
  send(
    appendEvent({
      actor: ctx.actor,
      // head_sha is required by the contract but the driver model does not
      // track a HEAD SHA at this seam — empty by design, meaning unknown.
      body: { head_sha: "", pr, url },
      extRef: url,
      id: eventId(`${ctx.stream}_pr_${String(pr)}`),
      kind: "stream_pr_opened",
      runId: ctx.runId,
      stream: ctx.stream,
    }),
  );
}

function emitMerged(
  stream: DriverStream,
  patch: UpdateDriverStreamInput,
  ctx: StreamEventCtx,
  send: Send,
): void {
  if (patch.mergeCommit === undefined || stream.prNumber === undefined) {
    return;
  }
  send(
    appendEvent({
      actor: ctx.actor,
      body: {
        merge_commit: patch.mergeCommit,
        merged_at: stream.mergedAt ?? new Date().toISOString(),
        pr: stream.prNumber,
      },
      id: eventId(`${ctx.stream}_merged`),
      kind: "stream_merged",
      runId: ctx.runId,
      stream: ctx.stream,
    }),
  );
}

function emitRunTerminal(run: DriverRun, status: DriverRun["status"], emit: Emit): void {
  if (status !== "done" && status !== "failed" && status !== "cancelled") {
    return;
  }
  if (status !== "done") {
    closeAbortedStreams(run, status, emit);
  }
  emit(
    run.id,
    appendEvent({
      actor: `ship:${run.id}`,
      body: { ship_status: status },
      id: eventId(`${ledgerRunId(run.id)}_finished`),
      kind: "run_finished",
      runId: ledgerRunId(run.id),
    }),
  );
  releaseRun(ledgerRunId(run.id), `ship:${run.id}`);
}

/**
 * A failed/cancelled run can stop with streams the ledger still holds
 * non-terminal, and `run_finished` is only legal once every stream is terminal.
 * Close what can legally close: never-dispatched streams skip
 * (pending → skipped), in-flight ones fail (dispatched → failed). A stream the
 * table cannot close from here (landed / pr_open) leaves `run_finished` to be
 * rejected and logged — visible, not silent, per the best-effort rule.
 */
function closeAbortedStreams(run: DriverRun, status: "failed" | "cancelled", emit: Emit): void {
  const reason = `run ${status}`;
  const actor = `ship:${run.id}`;
  const runId = ledgerRunId(run.id);
  for (const s of run.batches.flatMap((b) => b.streams)) {
    const kind = abortCloseKind(s);
    emit(
      run.id,
      appendEvent({
        actor,
        body: { reason },
        id: eventId(`${ledgerStreamId(s.id)}_abort_${kind}`),
        kind,
        runId,
        stream: ledgerStreamId(s.id),
      }),
    );
  }
}

/**
 * The closing kind for one aborted stream, chosen so the common ledger state
 * accepts it: in-flight streams fail (ledger dispatched → failed); everything
 * else skips — legal from both pending (never emitted, incl. progress absorbed
 * at import) and failed. A stream the ledger already holds terminal (e.g.
 * merged live in this process) rejects the skip in the emitter's validator —
 * logged and harmless, per the best-effort rule.
 */
function abortCloseKind(s: DriverStream): string {
  if (s.status === "dispatching" || s.status === "dispatched") {
    return "stream_failed";
  }
  return "stream_skipped";
}

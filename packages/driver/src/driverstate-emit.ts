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
 * Address receipt facts publish intrinsically from the public address path,
 * only after the engine's post-consumption live-head revalidation succeeds.
 */

import type { Logger } from "@ship/logger";
import type {
  ConsumeReviewArtifactInput,
  DriverRun,
  DriverStream,
  Store,
  UpdateDriverStreamInput,
} from "@ship/store";

import { appendEvent, type AppendResult, formatTime, releaseRun } from "@ship/driverstate-emitter";

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
    },
  };
}

/**
 * Publish a consumed address artifact only after the engine's fresh-head
 * revalidation succeeds. Consumption and emission are deliberately separate:
 * the store transaction wins at-most-once first, but a head that advances
 * before dispatch must not leave settled stale review evidence in the ledger.
 */
export function emitValidatedAddressFacts(
  store: Store,
  input: ConsumeReviewArtifactInput,
  logger?: Logger,
): void {
  const emit: Emit = (driverRunId, result) => {
    if (result.ok) return;
    logger?.warn(
      { driverRunId, err: result.error },
      "driverstate: address receipt emission failed; continuing",
    );
  };
  try {
    const run = store.getDriverRun(input.driverRunId);
    if (run === null) {
      return;
    }
    // `address()` is a public engine API and may be called with an undecorated
    // store. Deterministically bootstrap the ledger so receipt publication
    // cannot be omitted by forgetting a service-layer callback.
    emit(run.id, emitRunImported(run, run.sourceJson, run.manifestPath));
    closePreCompletedStreams(run, emit);
    emitAddressFacts(store, input, emit);
  } catch (err) {
    logger?.warn({ streamId: input.streamId, err: String(err) }, "driverstate: emission threw");
  }
}

/**
 * In ledger terms the stream stays `pr_open` and the round is a
 * `review_cycle`. findings is -1: the count is not known at this seam, only
 * that a settled review round is being addressed.
 */
function emitAddressFacts(store: Store, input: ConsumeReviewArtifactInput, emit: Emit): void {
  const run = store.getDriverRun(input.driverRunId);
  const stream = run?.batches
    .flatMap((batch) => batch.streams)
    .find((candidate) => candidate.id === input.streamId);
  if (stream === undefined) {
    return;
  }
  reconcileImportedLandedAddress(stream, input, emit);
  emitPROpened({
    driverRunId: input.driverRunId,
    emit,
    headSha: input.headSha,
    pr: input.prNumber,
    streamId: input.streamId,
    url: `https://github.com/${input.repo}/pull/${String(input.prNumber)}`,
  });
  const closureFacts = compactFacts({
    task_ref: stream.taskId,
    seat: input.producerHarness,
    harness: input.producerHarness,
    model: stream.modelId ?? input.dispatchModel,
    provider: stream.provider ?? input.dispatchProvider,
    effort: stream.effortTier,
    review_producer: input.producerId,
    catalog_revision: input.producerCatalogRevision,
    review_artifact_id: input.artifactId,
    review_artifact_digest: input.canonicalSha256,
    opening_head_sha: input.addressCycle === 1 ? input.headSha : undefined,
    review_head_sha: input.headSha,
    ship_run_ref: input.driverRunId,
  });
  emit(
    input.driverRunId,
    appendEvent({
      actor: `ship:${input.driverRunId}`,
      body: closureFacts,
      id: eventId(
        `${ledgerStreamId(input.streamId)}_closure_address_${String(input.addressCycle)}`,
      ),
      kind: "closure_facts",
      runId: ledgerRunId(input.driverRunId),
      stream: ledgerStreamId(input.streamId),
    }),
  );
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

/**
 * Upgrade repair for a run that was persisted before landed-at-import
 * reconciliation existed. Address preparation has appended its new
 * non-terminal attempt to the store input; when that is the stream's first
 * attempt, the landed state was absorbed rather than observed by this ledger.
 * Replaying the import-keyed events is safe both for a legacy pending ledger
 * and for a current ledger that already wrote them during insert.
 */
function reconcileImportedLandedAddress(
  stream: DriverStream,
  input: ConsumeReviewArtifactInput,
  emit: Emit,
): void {
  if (input.attempts.length !== 1) {
    return;
  }
  openImportedLandedStream(input.driverRunId, stream, emit);
}

function compactFacts(facts: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(facts)) {
    if (value !== undefined && value !== "") {
      out[name] = value;
    }
  }
  return out;
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
      ship_run_ref: run.id,
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
 * A manifest can import streams with progress the ledger did not observe.
 * Completed streams close as skipped because their prior attempt history is
 * unavailable. A landed stream needs the smallest honest legal history before
 * address can attach its PR and review receipt: one deterministic synthetic
 * dispatch followed by one terminal landed attempt. Stable event ids make an
 * import replay idempotent and avoid minting duplicate attempts.
 *
 * Failed streams stay pending: their live retry/skip tail can transition from
 * pending legally without inventing a failed attempt and failure category.
 */
function closePreCompletedStreams(run: DriverRun, emit: Emit): void {
  for (const s of run.batches.flatMap((b) => b.streams)) {
    if (s.status === "landed") {
      openImportedLandedStream(run.id, s, emit);
      continue;
    }
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

function openImportedLandedStream(driverRunId: string, stream: DriverStream, emit: Emit): void {
  const actor = `ship:${driverRunId}`;
  const runId = ledgerRunId(driverRunId);
  const streamId = ledgerStreamId(stream.id);
  emit(
    driverRunId,
    appendEvent({
      actor,
      body: { engine: "ship", imported: true },
      id: eventId(`${streamId}_import_dispatch`),
      kind: "stream_dispatched",
      runId,
      stream: streamId,
    }),
  );
  emit(
    driverRunId,
    appendEvent({
      actor,
      body: {
        doc_path: stream.specPath,
        imported: true,
        seq: Math.max(1, stream.attempts.length),
        terminal: true,
      },
      id: eventId(`${streamId}_import_landed`),
      kind: "stream_attempt",
      runId,
      stream: streamId,
    }),
  );
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
  emitMerged(stream, patch, ctx, send);
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
  emitPROpened({
    driverRunId: stream.driverRunId,
    emit: (_driverRunId, result) => {
      send(result);
    },
    // A legacy land without address never observed the opening head. Keep the
    // lifecycle placeholder unknown; mergeHeadSha belongs only to the merged
    // event below. If address already emitted the exact opening, deterministic
    // PR-event idempotency preserves that committed body.
    headSha: "",
    pr: stream.prNumber,
    streamId: stream.id,
    url: stream.prUrl ?? "",
  });
  if (patch.finalReviewedHeadSha !== undefined && patch.gateRunRef !== undefined) {
    send(
      appendEvent({
        actor: ctx.actor,
        body: {
          final_reviewed_head_sha: patch.finalReviewedHeadSha,
          gate_head_sha: patch.finalReviewedHeadSha,
          gate_run_ref: patch.gateRunRef,
        },
        id: eventId(`${ctx.stream}_closure_gate_${patch.finalReviewedHeadSha}`),
        kind: "closure_facts",
        runId: ctx.runId,
        stream: ctx.stream,
      }),
    );
  }
  send(
    appendEvent({
      actor: ctx.actor,
      body: {
        merge_commit: patch.mergeCommit,
        merged_at: stream.mergedAt ?? new Date().toISOString(),
        ...(patch.mergeHeadSha === undefined ? {} : { head_sha: patch.mergeHeadSha }),
        pr: stream.prNumber,
      },
      id: eventId(`${ctx.stream}_merged`),
      kind: "stream_merged",
      runId: ctx.runId,
      stream: ctx.stream,
    }),
  );
}

function emitPROpened(input: {
  driverRunId: string;
  streamId: string;
  pr: number;
  url: string;
  headSha: string;
  emit: Emit;
}): void {
  const stream = ledgerStreamId(input.streamId);
  input.emit(
    input.driverRunId,
    appendEvent({
      actor: `ship:${input.driverRunId}`,
      body: { head_sha: input.headSha, pr: input.pr, url: input.url },
      extRef: input.url,
      id: eventId(`${stream}_pr_${String(input.pr)}`),
      kind: "stream_pr_opened",
      runId: ledgerRunId(input.driverRunId),
      stream,
    }),
  );
}

/**
 * Record an address refusal that requires mechanism repair. The caller supplies
 * only live GitHub facts; this helper does not infer producer or panel state.
 * Best-effort, like every other driver-state write.
 */
export function emitAddressIntervention(
  input: {
    driverRunId: string;
    streamId: string;
    prNumber: number;
    repo: string;
    liveHeadSha: string;
    reasonCode: string;
  },
  logger?: Logger,
): void {
  const emit: Emit = (driverRunId, result) => {
    if (result.ok) return;
    logger?.warn(
      { driverRunId, err: result.error },
      "driverstate: address intervention emission failed; continuing",
    );
  };
  emitPROpened({
    driverRunId: input.driverRunId,
    emit,
    headSha: input.liveHeadSha,
    pr: input.prNumber,
    streamId: input.streamId,
    url: `https://github.com/${input.repo}/pull/${String(input.prNumber)}`,
  });
  emit(
    input.driverRunId,
    appendEvent({
      actor: `ship:${input.driverRunId}`,
      body: {
        actor: `ship:${input.driverRunId}`,
        kind: "mechanism-repair",
        reason_code: input.reasonCode,
        time: formatTime(new Date()),
      },
      id: eventId(
        `${ledgerStreamId(input.streamId)}_intervention_${input.reasonCode}_${input.liveHeadSha}`,
      ),
      kind: "intervention",
      runId: ledgerRunId(input.driverRunId),
      stream: ledgerStreamId(input.streamId),
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

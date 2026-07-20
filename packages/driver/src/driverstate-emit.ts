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
import type { DriverRun, DriverStream, Store, UpdateDriverStreamInput } from "@ship/store";

import { appendEvent, type AppendResult, releaseRun } from "@ship/driverstate-emitter";

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
  };
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
    send(appendEvent(dispatchedEvent(ctx)));
    return;
  }
  if (patch.status === "landed" || patch.status === "failed") {
    send(appendEvent(attemptEvent(stream, patch.status, ctx)));
    return;
  }
  if (patch.status === "skipped") {
    send(appendEvent(skippedEvent(stream, ctx)));
  }
}

function dispatchedEvent(ctx: StreamEventCtx): Parameters<typeof appendEvent>[0] {
  const { seq, ...base } = ctx;
  return {
    ...base,
    body: { engine: "ship" },
    id: eventId(`${ctx.stream}_dispatch_${String(seq)}`),
    kind: "stream_dispatched",
  };
}

function attemptEvent(
  stream: DriverStream,
  status: "landed" | "failed",
  ctx: StreamEventCtx,
): Parameters<typeof appendEvent>[0] {
  const { seq, ...base } = ctx;
  const failure =
    status === "failed" ? { failure_category: stream.errorMessage ?? "engine_failure" } : {};
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
  const base = { actor: ctx.actor, runId: ctx.runId, stream: ctx.stream };
  if (patch.prNumber !== undefined) {
    send(
      appendEvent({
        ...base,
        body: { head_sha: "", pr: patch.prNumber, url: stream.prUrl ?? "" },
        extRef: stream.prUrl ?? "",
        id: eventId(`${ctx.stream}_pr_${String(patch.prNumber)}`),
        kind: "stream_pr_opened",
      }),
    );
  }
  if (patch.mergeCommit !== undefined && stream.prNumber !== undefined) {
    send(
      appendEvent({
        ...base,
        body: {
          merge_commit: patch.mergeCommit,
          merged_at: stream.mergedAt ?? new Date().toISOString(),
          pr: stream.prNumber,
        },
        id: eventId(`${ctx.stream}_merged`),
        kind: "stream_merged",
      }),
    );
  }
}

function emitRunTerminal(run: DriverRun, status: DriverRun["status"], emit: Emit): void {
  if (status !== "done" && status !== "failed" && status !== "cancelled") {
    return;
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

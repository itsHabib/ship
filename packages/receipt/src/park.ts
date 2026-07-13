/**
 * Park receipts — live telemetry when a driver run enters awaiting_judgment.
 *
 * Manifest projection covers terminal stream outcomes; park rows are written at
 * the transition so tailers (flare) observe the block without reading SQLite.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { Receipt, ReceiptRuntime } from "./schema.js";

import { readReceiptsFile, writeReceiptsFile } from "./jsonl.js";
import { buildReceipt, receiptIdentity } from "./schema.js";

export interface ParkStreamInput {
  batchIndex: number;
  branch?: string | undefined;
  prNumber?: number | undefined;
  runtime?: ReceiptRuntime | undefined;
  specPath: string;
  streamIndex: number;
  taskId?: string | undefined;
  taskSlug?: string | undefined;
  workflowRunId?: string | undefined;
}

export interface ParkReceiptRunInput {
  driverRunId: string;
  generatedAt: string;
  phase?: string | undefined;
  project?: string | undefined;
  repo: string;
  streams: ParkStreamInput[];
}

/** Build one driver park receipt for a stream awaiting judgment. */
export function buildParkReceipt(input: ParkReceiptRunInput, stream: ParkStreamInput): Receipt {
  return buildReceipt({
    key: parkStreamKey(input.driverRunId, stream, input.project),
    source: "driver",
    outcome: "parked",
    project: input.project,
    phase: input.phase,
    repo: input.repo,
    runtime: stream.runtime,
    task_id: stream.taskId,
    task_slug: stream.taskSlug,
    doc_path: stream.specPath,
    branch: stream.branch,
    pr_number: stream.prNumber,
    run_id: stream.workflowRunId ?? input.driverRunId,
    generated_at: input.generatedAt,
    batch_id: stream.batchIndex,
  });
}

/** Build park receipts for every stream parked on this run. */
export function buildParkReceipts(input: ParkReceiptRunInput): Receipt[] {
  return input.streams.map((stream) => buildParkReceipt(input, stream));
}

/**
 * Append park receipts to the JSONL file at `path`, PRESERVING existing file
 * order. Idempotent by identity: an incoming receipt whose identity already
 * exists replaces that row in place (drop-then-append), so re-ticking the same
 * parked run never adds a second row.
 *
 * CRITICAL — do NOT sort or upsert this path. flare TAILS this file BY OFFSET
 * (it resumes from a saved byte cursor near EOF to page the operator). A fresh
 * park MUST land AFTER that cursor, i.e. appended at EOF — never sorted to the
 * top. `upsertReceipts`/`sortReceipts` reorder newest-activity-first, which
 * would shift the file prefix, tear flare's cursor, and make the park invisible.
 * Reading in file order and writing `[...kept, ...incoming]` keeps the prefix
 * byte-identical, so flare's cursor stays valid and reads the appended park.
 *
 * Race (acceptable for v0): two driver instances parking the same instant do a
 * non-atomic read-modify-write → last-writer-wins on the kept prefix. Tolerated
 * because flare dedupes on key+outcome, so a lost row is at worst one re-page.
 */
export function persistReceipts(path: string, incoming: Receipt[]): void {
  if (incoming.length === 0) {
    return;
  }
  const incomingIdentities = new Set(incoming.map(receiptIdentity));
  const kept = readReceiptsFile(path).filter(
    (existing) => !incomingIdentities.has(receiptIdentity(existing)),
  );
  // Parents may not exist on a fresh machine (e.g. `~/.config/ship/`); create
  // them so the first-ever park does not throw ENOENT.
  mkdirSync(dirname(path), { recursive: true });
  writeReceiptsFile(path, [...kept, ...incoming]);
}

function parkStreamKey(
  driverRunId: string,
  stream: ParkStreamInput,
  project: string | undefined,
): string {
  return `${driverRunId}:${parkStreamDiscriminator(stream, project)}`;
}

/**
 * Per-run stream discriminator. The driver run id is prefixed by the caller so
 * two DIFFERENT runs of the same task get distinct keys — otherwise the global
 * file's flare dedupe (key+outcome) would suppress the second run's park as a
 * duplicate and drop a page. Stable across re-polls of the SAME run.
 */
function parkStreamDiscriminator(stream: ParkStreamInput, project: string | undefined): string {
  if (stream.taskId !== undefined && stream.taskId !== "") {
    return stream.taskId;
  }
  if (stream.branch !== undefined && stream.branch !== "") {
    return stream.branch;
  }
  if (stream.prNumber !== undefined) {
    return `pr-${String(stream.prNumber)}`;
  }
  return `${project ?? "unknown"}:${String(stream.batchIndex)}:${stream.taskSlug ?? "stream"}:${String(stream.streamIndex)}`;
}

/**
 * Park receipts — live telemetry when a driver run enters awaiting_judgment.
 *
 * Manifest projection covers terminal stream outcomes; park rows are written at
 * the transition so tailers (flare) observe the block without reading SQLite.
 */

import type { Receipt, ReceiptRuntime } from "./schema.js";

import { upsertReceipts } from "./build.js";
import { readReceiptsFile, writeReceiptsFile } from "./jsonl.js";
import { buildReceipt } from "./schema.js";

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
    key: parkStreamKey(stream, input.project),
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

/** Upsert incoming receipts into the JSONL file at `path`. Idempotent by identity. */
export function persistReceipts(path: string, incoming: Receipt[]): void {
  if (incoming.length === 0) {
    return;
  }
  const merged = upsertReceipts(readReceiptsFile(path), incoming);
  writeReceiptsFile(path, merged);
}

function parkStreamKey(stream: ParkStreamInput, project: string | undefined): string {
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

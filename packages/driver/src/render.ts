/**
 * Render a stored driver run back to `driver.md` text.
 */

import type { Store } from "@ship/store";
import type { DriverBatch, DriverRun, DriverStream } from "@ship/store";

import { DriverRunNotFoundError } from "@ship/store";
import { LineCounter, parseDocument, stringify } from "yaml";

import { storeBatchStatusToManifest, storeStatusToManifest } from "./status-mapping.js";

/** Store rows → deterministic `driver.md` text (frontmatter + original body). */
export function renderDriverRun(store: Store, driverRunId: string): string {
  const run = store.getDriverRun(driverRunId);
  if (run === null) {
    throw new DriverRunNotFoundError(driverRunId);
  }
  return renderFromRun(run);
}

function renderFromRun(run: DriverRun): string {
  const { body, frontmatter } = splitSourceJson(run.sourceJson);
  const lineCounter = new LineCounter();
  const doc = parseDocument(frontmatter, { lineCounter, prettyErrors: false });
  const parsed: unknown = doc.toJS();
  if (!isRecord(parsed)) {
    throw new Error("stored source_json frontmatter is not a mapping");
  }

  parsed["batches"] = overlayBatches(parsed["batches"], run);
  const renderedFrontmatter = stringify(parsed, {
    indent: 2,
    lineWidth: 0,
    sortMapEntries: true,
  }).trimEnd();
  return `---\n${renderedFrontmatter}\n---${body}`;
}

function splitSourceJson(sourceJson: string): { frontmatter: string; body: string } {
  const text = sourceJson.charCodeAt(0) === 0xfeff ? sourceJson.slice(1) : sourceJson;
  const match = /^---\r?\n([\s\S]*?)\r?\n---((?:\r?\n[\s\S]*)?)$/.exec(text);
  if (match === null) {
    throw new Error("stored source_json is missing driver manifest frontmatter fences");
  }
  const frontmatter = match[1];
  const bodySuffix = match[2];
  if (frontmatter === undefined || bodySuffix === undefined) {
    throw new Error("stored source_json frontmatter split failed");
  }
  return { body: bodySuffix, frontmatter };
}

function overlayBatches(batchesValue: unknown, run: DriverRun): unknown {
  if (!Array.isArray(batchesValue)) {
    return batchesValue;
  }

  return batchesValue.map((batchEntry) => overlayBatchEntry(batchEntry, run));
}

function overlayBatchEntry(batchEntry: unknown, run: DriverRun): unknown {
  if (!isRecord(batchEntry)) {
    return batchEntry;
  }
  const manifestBatchId = batchEntry["id"];
  if (typeof manifestBatchId !== "number") {
    return batchEntry;
  }
  const storeBatch = run.batches.find((batch) => batch.batchIndex === manifestBatchId);
  if (storeBatch === undefined) {
    return batchEntry;
  }

  // Store rows are the only truth for progress: delete-then-set so a field
  // the row lacks (e.g. completed_at on a non-done batch) can't survive from
  // the stored source frontmatter.
  const overlaid: Record<string, unknown> = {
    ...batchEntry,
    status: storeBatchStatusToManifest(storeBatch.status),
    streams: overlayStreams(batchEntry["streams"], storeBatch),
  };
  delete overlaid["completed_at"];
  if (storeBatch.completedAt !== undefined) {
    overlaid["completed_at"] = storeBatch.completedAt;
  }
  return overlaid;
}

function overlayStreams(streamsValue: unknown, storeBatch: DriverBatch): unknown {
  if (!Array.isArray(streamsValue)) {
    return streamsValue;
  }

  // Positional pairing: import inserts streams in manifest order and the
  // store hydrates them ordered by stream_index, so source entry i IS store
  // stream i. Matching by spec_path would conflate duplicate spec paths.
  return streamsValue.map((streamEntry, index) =>
    overlayStreamEntry(streamEntry, storeBatch.streams[index]),
  );
}

function overlayStreamEntry(streamEntry: unknown, storeStream: DriverStream | undefined): unknown {
  if (!isRecord(streamEntry)) {
    return streamEntry;
  }
  if (storeStream === undefined) {
    return streamEntry;
  }

  return overlayStreamProgress(streamEntry, storeStream);
}

function overlayStreamProgress(
  streamEntry: Record<string, unknown>,
  storeStream: DriverStream,
): Record<string, unknown> {
  const overlaid: Record<string, unknown> = {
    ...streamEntry,
    status: storeStatusToManifest(storeStream.status),
  };
  delete overlaid["pr_number"];
  delete overlaid["merge_commit"];
  delete overlaid["merged_at"];
  delete overlaid["cycles"];
  if (storeStream.prNumber !== undefined) overlaid["pr_number"] = storeStream.prNumber;
  if (storeStream.mergeCommit !== undefined) overlaid["merge_commit"] = storeStream.mergeCommit;
  if (storeStream.mergedAt !== undefined) overlaid["merged_at"] = storeStream.mergedAt;
  if (storeStream.cycles !== undefined) overlaid["cycles"] = storeStream.cycles;
  return overlaid;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

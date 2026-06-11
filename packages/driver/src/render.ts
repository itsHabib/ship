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

  return {
    ...batchEntry,
    ...(storeBatch.completedAt !== undefined ? { completed_at: storeBatch.completedAt } : {}),
    status: storeBatchStatusToManifest(storeBatch.status),
    streams: overlayStreams(batchEntry["streams"], storeBatch),
  };
}

function overlayStreams(streamsValue: unknown, storeBatch: DriverBatch): unknown {
  if (!Array.isArray(streamsValue)) {
    return streamsValue;
  }

  return streamsValue.map((streamEntry) => overlayStreamEntry(streamEntry, storeBatch));
}

function overlayStreamEntry(streamEntry: unknown, storeBatch: DriverBatch): unknown {
  if (!isRecord(streamEntry)) {
    return streamEntry;
  }
  const specPath = streamEntry["spec_path"];
  if (typeof specPath !== "string") {
    return streamEntry;
  }
  const storeStream = storeBatch.streams.find((stream) => stream.specPath === specPath);
  if (storeStream === undefined) {
    return streamEntry;
  }

  return overlayStreamProgress(streamEntry, storeStream);
}

function overlayStreamProgress(
  streamEntry: Record<string, unknown>,
  storeStream: DriverStream,
): Record<string, unknown> {
  return {
    ...streamEntry,
    status: storeStatusToManifest(storeStream.status),
    ...(storeStream.prNumber !== undefined ? { pr_number: storeStream.prNumber } : {}),
    ...(storeStream.mergeCommit !== undefined ? { merge_commit: storeStream.mergeCommit } : {}),
    ...(storeStream.mergedAt !== undefined ? { merged_at: storeStream.mergedAt } : {}),
    ...(storeStream.cycles !== undefined ? { cycles: storeStream.cycles } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

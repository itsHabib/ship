/**
 * JSONL persistence for the receipt dataset — one compact JSON object per line,
 * append-friendly and grep-able. Reads validate every row through
 * `receiptSchema` so a corrupt or stale-schema line fails loudly instead of
 * poisoning a metric downstream.
 */

import { readFileSync, writeFileSync } from "node:fs";

import type { Receipt } from "./schema.js";

import { receiptSchema } from "./schema.js";

/** Parse JSONL into receipts, skipping blank lines; throws on a malformed/invalid row. */
export function parseReceiptsJsonl(text: string): Receipt[] {
  const receipts: Receipt[] = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    receipts.push(parseLine(trimmed, index + 1));
  }
  return receipts;
}

/** Serialize receipts to JSONL (trailing newline; empty dataset → empty string). */
export function serializeReceiptsJsonl(receipts: Receipt[]): string {
  if (receipts.length === 0) {
    return "";
  }
  return `${receipts.map((receipt) => JSON.stringify(receipt)).join("\n")}\n`;
}

/** Read a receipts file; a missing file is an empty dataset, not an error. */
export function readReceiptsFile(path: string): Receipt[] {
  const text = readFileTextOrNull(path);
  return text === null ? [] : parseReceiptsJsonl(text);
}

export function writeReceiptsFile(path: string, receipts: Receipt[]): void {
  writeFileSync(path, serializeReceiptsJsonl(receipts), "utf8");
}

function parseLine(line: string, lineNumber: number): Receipt {
  const json = tryParseJson(line);
  if (json === undefined) {
    throw new Error(`receipts: malformed JSON on line ${String(lineNumber)}`);
  }
  const parsed = receiptSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `receipts: invalid receipt on line ${String(lineNumber)}: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

function tryParseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function readFileTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

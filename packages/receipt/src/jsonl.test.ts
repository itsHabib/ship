import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { Receipt } from "./schema.js";

import {
  parseReceiptsJsonl,
  readReceiptsFile,
  serializeReceiptsJsonl,
  writeReceiptsFile,
} from "./jsonl.js";
import { buildReceipt } from "./schema.js";

function sample(): Receipt[] {
  return [
    buildReceipt({ key: "d1", source: "driver", outcome: "merged", pr_number: 24, cycles: 2 }),
    buildReceipt({
      key: "r1",
      source: "ship-run",
      outcome: "succeeded",
      duration_ms: 1000,
      cost_tokens: null,
    }),
  ];
}

describe("serializeReceiptsJsonl / parseReceiptsJsonl", () => {
  it("serializes an empty dataset to an empty string", () => {
    expect(serializeReceiptsJsonl([])).toBe("");
  });

  it("round-trips a dataset stably", () => {
    const text = serializeReceiptsJsonl(sample());
    expect(serializeReceiptsJsonl(parseReceiptsJsonl(text))).toBe(text);
  });

  it("skips blank lines on parse", () => {
    const text = `${serializeReceiptsJsonl(sample())}\n   \n`;
    expect(parseReceiptsJsonl(text)).toHaveLength(2);
  });

  it("throws with a line number on malformed JSON", () => {
    expect(() => parseReceiptsJsonl("{ not json")).toThrow(/line 1/);
  });

  it("throws on a structurally invalid receipt", () => {
    expect(() => parseReceiptsJsonl(JSON.stringify({ key: "x" }))).toThrow(/invalid receipt/);
  });
});

describe("readReceiptsFile / writeReceiptsFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "ship-receipt-jsonl-"));

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("treats a missing file as an empty dataset", () => {
    expect(readReceiptsFile(join(dir, "absent.jsonl"))).toEqual([]);
  });

  it("writes then reads back the same receipts", () => {
    const path = join(dir, "receipts.jsonl");
    writeReceiptsFile(path, sample());
    expect(readReceiptsFile(path)).toHaveLength(2);
  });
});

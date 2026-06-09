import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { Receipt } from "./schema.js";

import { manifestToReceipts } from "./manifest.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, "../test/fixtures/driver.md"), "utf8");

function byKey(receipts: Receipt[], key: string): Receipt {
  const found = receipts.find((receipt) => receipt.key === key);
  if (found === undefined) {
    throw new Error(`no receipt for ${key}`);
  }
  return found;
}

describe("manifestToReceipts", () => {
  const receipts = manifestToReceipts(fixture);

  it("flattens every batch's streams into one receipt each", () => {
    expect(receipts).toHaveLength(4);
    expect(receipts.every((receipt) => receipt.source === "driver")).toBe(true);
  });

  it("propagates manifest-level project/phase/repo + batch id to each row", () => {
    const merged = byKey(receipts, "tsk_A");
    expect(merged.project).toBe("dossier");
    expect(merged.phase).toBe("hygiene-followups");
    expect(merged.repo).toBe("dossier");
    expect(merged.batch_id).toBe(1);
    expect(merged.generated_at).toBe("2026-05-18T00:00:00Z");
  });

  it("maps a merged stream to outcome=merged with PR + merge + cycles", () => {
    const merged = byKey(receipts, "tsk_A");
    expect(merged.outcome).toBe("merged");
    expect(merged.pr_number).toBe(24);
    expect(merged.merge_commit).toBe("e966e87ddf963f19b0e7e13e5424cd9162893532");
    expect(merged.merged_at).toBe("2026-05-18T02:22:26Z");
    expect(merged.cycles).toBe(2);
    expect(merged.cycles_capped).toBe(false);
    expect(merged.runtime).toBe("local");
    expect(merged.doc_path).toBe("docs/features/hygiene-followups/actor-on-update-verbs.md");
  });

  it("flags cycles >= 3 as capped", () => {
    expect(byKey(receipts, "tsk_D").cycles_capped).toBe(true);
  });

  it("maps failed and pending streams to their outcomes", () => {
    expect(byKey(receipts, "tsk_B").outcome).toBe("failed");
    expect(byKey(receipts, "tsk_C").outcome).toBe("pending");
  });

  it("returns [] for text without frontmatter", () => {
    expect(manifestToReceipts("# just a heading\n\nno frontmatter here")).toEqual([]);
  });

  it("returns [] for an empty string", () => {
    expect(manifestToReceipts("")).toEqual([]);
  });

  it("returns [] when frontmatter is not a manifest shape", () => {
    expect(manifestToReceipts("---\nbatches: not-an-array\n---\n")).toEqual([]);
  });

  it("synthesizes a key when a stream lacks task_id/branch/pr", () => {
    const text = [
      "---",
      "source:",
      "  project: demo",
      "batches:",
      "  - id: 7",
      "    streams:",
      "      - task_slug: keyless",
      "        status: pending",
      "---",
    ].join("\n");
    const [receipt] = manifestToReceipts(text);
    expect(receipt?.key).toBe("demo:7:keyless:0");
  });

  it("falls back to branch then pr for the key", () => {
    const text = [
      "---",
      "batches:",
      "  - streams:",
      "      - branch_name: feat/x",
      "        status: done",
      "      - pr_number: 99",
      "        status: done",
      "---",
    ].join("\n");
    const keys = manifestToReceipts(text).map((receipt) => receipt.key);
    expect(keys).toEqual(["feat/x", "pr-99"]);
  });

  it("skips a manifest with syntactically invalid YAML instead of throwing", () => {
    expect(manifestToReceipts("---\nbatches: [unterminated\n---\n")).toEqual([]);
  });

  it("synthesizes a unique key per anonymous stream (no silent collision)", () => {
    const text = [
      "---",
      "batches:",
      "  - id: 1",
      "    streams:",
      "      - status: pending",
      "      - status: pending",
      "---",
    ].join("\n");
    const keys = manifestToReceipts(text).map((receipt) => receipt.key);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });
});

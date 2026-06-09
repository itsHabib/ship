import { describe, expect, it } from "vitest";

import type { Receipt } from "./schema.js";

import { sortReceipts, upsertReceipts } from "./build.js";
import { buildReceipt } from "./schema.js";

function driver(key: string, extra: Record<string, unknown> = {}): Receipt {
  return buildReceipt({ key, source: "driver", outcome: "merged", ...extra });
}

describe("upsertReceipts", () => {
  it("replaces a same-identity row and preserves the rest", () => {
    const existing = [driver("a", { pr_number: 1 }), driver("b", { pr_number: 2 })];
    const incoming = [driver("a", { pr_number: 11 })];
    const merged = upsertReceipts(existing, incoming);

    expect(merged).toHaveLength(2);
    expect(merged.find((receipt) => receipt.key === "a")?.pr_number).toBe(11);
    expect(merged.find((receipt) => receipt.key === "b")?.pr_number).toBe(2);
  });

  it("is idempotent — applying the same incoming twice changes nothing", () => {
    const existing = [driver("a")];
    const incoming = [driver("b"), driver("c")];
    const once = upsertReceipts(existing, incoming);
    const twice = upsertReceipts(once, incoming);
    expect(twice).toEqual(once);
  });

  it("treats the same key under different sources as distinct identities", () => {
    const merged = upsertReceipts(
      [driver("tsk_1")],
      [buildReceipt({ key: "tsk_1", source: "ship-run", outcome: "succeeded" })],
    );
    expect(merged).toHaveLength(2);
  });
});

describe("sortReceipts", () => {
  it("orders by newest activity first, identity as the tiebreak", () => {
    const old = driver("old", { merged_at: "2026-01-01T00:00:00Z" });
    const recent = driver("recent", { merged_at: "2026-06-01T00:00:00Z" });
    const undated = driver("undated");
    const sorted = sortReceipts([old, undated, recent]);
    expect(sorted.map((receipt) => receipt.key)).toEqual(["recent", "old", "undated"]);
  });
});

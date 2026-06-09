import { describe, expect, it } from "vitest";

import { buildReceipt, RECEIPT_SCHEMA_VERSION, receiptIdentity, receiptSchema } from "./schema.js";

describe("buildReceipt", () => {
  it("stamps the current schema version regardless of the input", () => {
    const receipt = buildReceipt({
      key: "k",
      source: "driver",
      outcome: "merged",
      schema_version: 99,
    });
    expect(receipt.schema_version).toBe(RECEIPT_SCHEMA_VERSION);
  });

  it("throws on an invalid outcome", () => {
    expect(() => buildReceipt({ key: "k", source: "driver", outcome: "bogus" })).toThrow();
  });

  it("throws on a missing key", () => {
    expect(() => buildReceipt({ source: "driver", outcome: "merged" })).toThrow();
  });
});

describe("receiptIdentity", () => {
  it("scopes the key by source", () => {
    expect(receiptIdentity({ key: "tsk_1", source: "driver" })).toBe("driver:tsk_1");
    expect(receiptIdentity({ key: "tsk_1", source: "ship-run" })).toBe("ship-run:tsk_1");
  });
});

describe("receiptSchema", () => {
  it("rejects an empty key", () => {
    expect(
      receiptSchema.safeParse({ schema_version: 1, key: "", source: "driver", outcome: "merged" })
        .success,
    ).toBe(false);
  });
});

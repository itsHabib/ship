import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseReceiptsJsonl } from "./jsonl.js";
import { buildParkReceipt, buildParkReceipts, persistReceipts } from "./park.js";
import { receiptSchema } from "./schema.js";

describe("buildParkReceipt", () => {
  it("builds a parked driver receipt with stream context", () => {
    const receipt = buildParkReceipt(
      {
        driverRunId: "drv_1",
        generatedAt: "2026-07-13T12:00:00.000Z",
        phase: "talk-readiness",
        project: "ship",
        repo: "ship",
        streams: [],
      },
      {
        batchIndex: 1,
        branch: "emit-park-receipts",
        runtime: "local",
        specPath: "docs/features/emit-park-receipts/spec.md",
        streamIndex: 0,
        taskId: "tsk_park",
        taskSlug: "emit-park-receipts",
        workflowRunId: "wf_park",
      },
    );

    expect(receiptSchema.safeParse(receipt).success).toBe(true);
    expect(receipt.outcome).toBe("parked");
    expect(receipt.source).toBe("driver");
    expect(receipt.key).toBe("tsk_park");
    expect(receipt.repo).toBe("ship");
    expect(receipt.run_id).toBe("wf_park");
  });

  it("round-trips parked receipts through persistReceipts idempotently", () => {
    const dir = mkdtempSync(join(tmpdir(), "receipt-park-"));
    const path = join(dir, "receipts.jsonl");
    const input = {
      driverRunId: "drv_1",
      generatedAt: "2026-07-13T12:00:00.000Z",
      project: "ship",
      repo: "ship",
      streams: [
        {
          batchIndex: 1,
          branch: "feat-a",
          specPath: "docs/tasks/a.md",
          streamIndex: 0,
          taskSlug: "feat-a",
        },
      ],
    };
    const receipts = buildParkReceipts(input);

    persistReceipts(path, receipts);
    persistReceipts(path, receipts);

    const rows = parseReceiptsJsonl(readFileSync(path, "utf8"));
    expect(rows.filter((row) => row.outcome === "parked")).toHaveLength(1);
    rmSync(dir, { force: true, recursive: true });
  });
});

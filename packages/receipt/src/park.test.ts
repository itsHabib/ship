import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseReceiptsJsonl, writeReceiptsFile } from "./jsonl.js";
import { buildParkReceipt, buildParkReceipts, persistReceipts } from "./park.js";
import { buildReceipt, receiptSchema } from "./schema.js";

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
    // The key is prefixed with the driver run id so two DIFFERENT runs of the
    // same task get distinct identities in the global file (flare dedupes on
    // key+outcome; without the prefix the second run's park would be suppressed).
    expect(receipt.key).toBe("drv_1:tsk_park");
    expect(receipt.repo).toBe("ship");
    expect(receipt.run_id).toBe("wf_park");
  });

  it("keys two runs of the same task distinctly, one run stably", () => {
    const stream = {
      batchIndex: 1,
      branch: "feat-a",
      specPath: "docs/tasks/a.md",
      streamIndex: 0,
      taskId: "tsk_shared",
      taskSlug: "feat-a",
    };
    const base = { generatedAt: "2026-07-13T12:00:00.000Z", project: "ship", repo: "ship" };
    const runA1 = buildParkReceipt({ ...base, driverRunId: "drv_a", streams: [] }, stream);
    const runA2 = buildParkReceipt({ ...base, driverRunId: "drv_a", streams: [] }, stream);
    const runB = buildParkReceipt({ ...base, driverRunId: "drv_b", streams: [] }, stream);
    // Same run → same key (idempotent across re-polls); different run → different key.
    expect(runA1.key).toBe(runA2.key);
    expect(runA1.key).not.toBe(runB.key);
    expect(runA1.key).toBe("drv_a:tsk_shared");
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

describe("persistReceipts append discipline", () => {
  const parkInput = {
    driverRunId: "drv_new",
    generatedAt: "2026-07-13T13:00:00.000Z",
    project: "ship",
    repo: "ship",
    streams: [{ batchIndex: 1, branch: "feat-new", specPath: "docs/tasks/new.md", streamIndex: 0 }],
  };

  it("appends the park at EOF, keeping the existing file prefix byte-identical", () => {
    // flare tails BY OFFSET from a cursor near EOF, so a fresh park MUST land
    // after it (appended), never sorted to the top — otherwise the shifted
    // prefix tears flare's cursor and the park is never read.
    const dir = mkdtempSync(join(tmpdir(), "receipt-park-append-"));
    const path = join(dir, "receipts.jsonl");
    // A pre-existing row with a NEWER activity time than the park — a sort would
    // pull it below the park (newest-first); an append must not.
    const existing = buildReceipt({
      key: "prior",
      source: "driver",
      outcome: "merged",
      repo: "ship",
      merged_at: "2999-01-01T00:00:00.000Z",
    });
    writeReceiptsFile(path, [existing]);
    const prefixBefore = readFileSync(path, "utf8");

    persistReceipts(path, buildParkReceipts(parkInput));

    const text = readFileSync(path, "utf8");
    expect(text.startsWith(prefixBefore)).toBe(true); // prefix untouched
    const rows = parseReceiptsJsonl(text);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.key).toBe("prior"); // existing row kept first
    expect(rows[1]?.outcome).toBe("parked"); // park is last
    rmSync(dir, { force: true, recursive: true });
  });

  it("replaces the same-identity row in place on re-tick without growing the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "receipt-park-replace-"));
    const path = join(dir, "receipts.jsonl");
    const older = buildReceipt({
      key: "older",
      source: "driver",
      outcome: "merged",
      repo: "ship",
      merged_at: "2000-01-01T00:00:00.000Z",
    });
    writeReceiptsFile(path, [older]);

    const receipts = buildParkReceipts(parkInput);
    persistReceipts(path, receipts);
    persistReceipts(path, receipts);

    const rows = parseReceiptsJsonl(readFileSync(path, "utf8"));
    expect(rows).toHaveLength(2); // older + one park, no duplicate
    expect(rows[0]?.key).toBe("older");
    expect(rows[1]?.key).toBe("drv_new:feat-new");
    rmSync(dir, { force: true, recursive: true });
  });

  it("creates a missing parent directory instead of throwing ENOENT", () => {
    const dir = mkdtempSync(join(tmpdir(), "receipt-park-mkdir-"));
    // Nested path whose parent does not yet exist — mirrors a fresh
    // `~/.config/ship/` on a clean runner.
    const path = join(dir, "nested", "ship", "receipts.jsonl");

    expect(() => {
      persistReceipts(path, buildParkReceipts(parkInput));
    }).not.toThrow();

    const rows = parseReceiptsJsonl(readFileSync(path, "utf8"));
    expect(rows.filter((row) => row.outcome === "parked")).toHaveLength(1);
    rmSync(dir, { force: true, recursive: true });
  });
});

import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppendInput } from "./emitter.js";

import { appendEvent } from "./emitter.js";
import { ledgerPath, runDir } from "./paths.js";

let stateRoot: string;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "driverstate-emitter-"));
});

afterEach(() => {
  // vitest's tmp fixture dirs are process-local scratch; no cleanup beyond GC
  // is required for CI, but nothing here writes outside `stateRoot`.
});

function baseInput(overrides: Partial<AppendInput> = {}): AppendInput {
  return {
    runId: "dsr_test0000000000000000001",
    kind: "run_imported",
    actor: "ship:drv_test",
    body: { repo: "itsHabib/ship", source: "docs/driver.md", generated_at: "2026-07-20T00:00:00Z" },
    stateRoot,
    ...overrides,
  };
}

function ledgerLines(runId: string): string[] {
  const raw = readFileSync(ledgerPath(runDir(stateRoot, runId)), "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

describe("appendEvent", () => {
  it("chains three appends: each prev links to the prior hash", () => {
    const t0 = new Date("2026-07-20T00:00:00Z");
    const r1 = appendEvent(baseInput({ time: t0 }));
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    const r2 = appendEvent(
      baseInput({
        id: "evt_second",
        kind: "stream_dispatched",
        stream: "dss_test0000000000000000001",
        time: new Date("2026-07-20T00:01:00Z"),
      }),
    );
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.event.prev).toBe(r1.event.hash);

    const r3 = appendEvent(
      baseInput({
        id: "evt_third",
        kind: "stream_attempt",
        stream: "dss_test0000000000000000001",
        body: { seq: 1, doc_path: "docs/a.md", terminal: false },
        time: new Date("2026-07-20T00:02:00Z"),
      }),
    );
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;
    expect(r3.event.prev).toBe(r2.event.hash);

    expect(new Set([r1.event.hash, r2.event.hash, r3.event.hash]).size).toBe(3);
    expect(ledgerLines("dsr_test0000000000000000001")).toHaveLength(3);
  });

  it("heals a torn trailing partial line before appending", () => {
    const runId = "dsr_torn00000000000000000001";
    const rd = runDir(stateRoot, runId);
    const r1 = appendEvent(baseInput({ runId, time: new Date("2026-07-20T00:00:00Z") }));
    expect(r1.ok).toBe(true);

    // Simulate a crash mid-write: a partial, unterminated line appended after
    // the last complete newline.
    appendFileSync(ledgerPath(rd), '{"id":"evt_torn","incomplete');

    const r2 = appendEvent(
      baseInput({
        runId,
        id: "evt_second",
        kind: "stream_dispatched",
        stream: "dss_torn0000000000000000001",
        time: new Date("2026-07-20T00:01:00Z"),
      }),
    );
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    // The healed head is still the first event: the torn line never counted.
    expect(r2.event.prev).toBe(r1.ok ? r1.event.hash : "");

    const lines = ledgerLines(runId);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => {
        JSON.parse(line) as unknown;
      }).not.toThrow();
    }
  });

  it("is idempotent by event id: a retried append returns the committed event, no duplicate line", () => {
    const runId = "dsr_idem00000000000000000001";
    const input = baseInput({ runId, id: "evt_fixed", time: new Date("2026-07-20T00:00:00Z") });

    const first = appendEvent(input);
    expect(first.ok).toBe(true);

    const retry = appendEvent(input);
    expect(retry.ok).toBe(true);
    if (!first.ok || !retry.ok) return;
    expect(retry.event.hash).toBe(first.event.hash);
    expect(retry.event).toEqual(first.event);

    expect(ledgerLines(runId)).toHaveLength(1);
  });

  it("rejects an event older than the current head (monotonic time)", () => {
    const runId = "dsr_mono00000000000000000001";
    const first = appendEvent(baseInput({ runId, time: new Date("2026-07-20T00:05:00Z") }));
    expect(first.ok).toBe(true);

    const older = appendEvent(
      baseInput({
        runId,
        id: "evt_older",
        kind: "stream_dispatched",
        stream: "dss_mono0000000000000000001",
        time: new Date("2026-07-20T00:00:00Z"),
      }),
    );
    expect(older.ok).toBe(false);
    if (older.ok) return;
    expect(older.error).toMatch(/monotonic/i);

    expect(ledgerLines(runId)).toHaveLength(1);
  });

  it("dedupes run_imported on (repo, source, generated_at) across runs, returning the original", () => {
    const shared = {
      repo: "itsHabib/ship",
      source: "docs/driver.md",
      generated_at: "2026-07-20T00:00:00Z",
    };
    const original = appendEvent(
      baseInput({
        runId: "dsr_run_a0000000000000001",
        body: shared,
        time: new Date("2026-07-20T00:00:00Z"),
      }),
    );
    expect(original.ok).toBe(true);
    if (!original.ok) return;

    const retriedImport = appendEvent(
      baseInput({
        runId: "dsr_run_b0000000000000001",
        id: "evt_fresh_retry",
        body: shared,
        time: new Date("2026-07-20T00:10:00Z"),
      }),
    );
    expect(retriedImport.ok).toBe(true);
    if (!retriedImport.ok) return;
    expect(retriedImport.event).toEqual(original.event);
    // No line was ever committed for run B — the dedupe short-circuited before write.
    const rbLedger = join(runDir(stateRoot, "dsr_run_b0000000000000001"), "events.jsonl");
    expect(() => readFileSync(rbLedger, "utf8")).toThrow();
  });

  it("does not dedupe two distinct imports (different generated_at)", () => {
    const a = appendEvent(
      baseInput({
        runId: "dsr_distinct_a000000000001",
        body: { repo: "x/y", source: "docs/driver.md", generated_at: "2026-07-20T00:00:00Z" },
        time: new Date("2026-07-20T00:00:00Z"),
      }),
    );
    const b = appendEvent(
      baseInput({
        runId: "dsr_distinct_b000000000001",
        body: { repo: "x/y", source: "docs/driver.md", generated_at: "2026-07-21T00:00:00Z" },
        time: new Date("2026-07-20T00:00:00Z"),
      }),
    );
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.event.id).not.toBe(b.event.id);
    expect(a.event.run).not.toBe(b.event.run);
  });

  it("returns a result value instead of throwing on a filesystem failure", () => {
    // A stateRoot path through a file (not a directory) makes mkdirSync fail;
    // appendEvent must catch it, not throw to the caller.
    const blocker = join(stateRoot, "blocker-file");
    writeFileSync(blocker, "not a directory");
    const result = appendEvent(baseInput({ stateRoot: join(blocker, "nested") }));
    expect(result.ok).toBe(false);
  });
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { AppendInput } from "./emitter.js";

import { canonicalBytes } from "./canonical.js";
import { appendEvent } from "./emitter.js";

let stateRoot: string;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "driverstate-transitions-"));
});

const RUN = "dsr_test0000000000000000001";
const STREAM = "dss_test0000000000000000001";

function input(overrides: Partial<AppendInput> = {}): AppendInput {
  return {
    runId: RUN,
    kind: "run_imported",
    actor: "ship:drv_test",
    body: { repo: "itsHabib/ship", source: "docs/driver.md", generated_at: "2026-07-20T00:00:00Z" },
    stateRoot,
    ...overrides,
  };
}

function mustAppend(overrides: Partial<AppendInput>): void {
  const r = appendEvent(input(overrides));
  expect(r.ok).toBe(true);
}

describe("write-time transition enforcement (spec §5)", () => {
  it("rejects a stream event on a run that was never imported", () => {
    const r = appendEvent(
      input({ kind: "stream_dispatched", stream: STREAM, body: { engine: "test" } }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) {
      return;
    }
    expect(r.error).toContain("illegal transition");
  });

  it("rejects stream_merged on a stream that never opened a PR", () => {
    mustAppend({ time: new Date("2026-07-20T00:00:00Z") });
    mustAppend({
      id: "evt_dispatch",
      kind: "stream_dispatched",
      stream: STREAM,
      body: { engine: "test" },
      time: new Date("2026-07-20T00:01:00Z"),
    });
    const r = appendEvent(
      input({
        kind: "stream_merged",
        stream: STREAM,
        body: { pr: 1, merge_commit: "abc", merged_at: "2026-07-20T00:02:00Z" },
        time: new Date("2026-07-20T00:02:00Z"),
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) {
      return;
    }
    expect(r.error).toContain("stream_merged from dispatched");
  });

  it("rejects a second run_imported with a different dedupe key", () => {
    mustAppend({ time: new Date("2026-07-20T00:00:00Z") });
    const r = appendEvent(
      input({
        id: "evt_reimport",
        body: { repo: "itsHabib/ship", source: "docs/driver.md", generated_at: "OTHER" },
        time: new Date("2026-07-20T00:01:00Z"),
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) {
      return;
    }
    expect(r.error).toContain("run_open");
  });

  it("rejects a stream_attempt whose seq does not increase", () => {
    mustAppend({ time: new Date("2026-07-20T00:00:00Z") });
    mustAppend({
      id: "evt_dispatch",
      kind: "stream_dispatched",
      stream: STREAM,
      body: { engine: "test" },
      time: new Date("2026-07-20T00:01:00Z"),
    });
    mustAppend({
      id: "evt_attempt1",
      kind: "stream_attempt",
      stream: STREAM,
      body: { seq: 2, doc_path: "docs/a.md", terminal: false },
      time: new Date("2026-07-20T00:02:00Z"),
    });
    const r = appendEvent(
      input({
        kind: "stream_attempt",
        stream: STREAM,
        body: { seq: 2, doc_path: "docs/a.md", terminal: false },
        time: new Date("2026-07-20T00:03:00Z"),
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) {
      return;
    }
    expect(r.error).toContain("seq 2");
  });

  it("rejects any event after run_finished (finishing is the no-retry declaration)", () => {
    mustAppend({ time: new Date("2026-07-20T00:00:00Z") });
    mustAppend({
      id: "evt_skip",
      kind: "stream_skipped",
      stream: STREAM,
      body: { reason: "test" },
      time: new Date("2026-07-20T00:01:00Z"),
    });
    // The manifest snapshot named no streams, so STREAM (skipped) is the only one.
    mustAppend({
      id: "evt_finish",
      kind: "run_finished",
      body: {},
      time: new Date("2026-07-20T00:02:00Z"),
    });
    const r = appendEvent(
      input({
        kind: "stream_dispatched",
        stream: STREAM,
        body: { engine: "test" },
        time: new Date("2026-07-20T00:03:00Z"),
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) {
      return;
    }
    expect(r.error).toContain("run_finished");
  });

  it("rejects run_finished while a manifest-named stream is still pending (untouched is non-terminal)", () => {
    const r1 = appendEvent(
      input({
        body: {
          repo: "itsHabib/ship",
          source: "docs/driver.md",
          generated_at: "2026-07-20T00:00:00Z",
          streams: [{ stream: STREAM, doc_path: "docs/a.md", batch: 1 }],
        },
        time: new Date("2026-07-20T00:00:00Z"),
      }),
    );
    expect(r1.ok).toBe(true);
    const r = appendEvent(
      input({ kind: "run_finished", body: {}, time: new Date("2026-07-20T00:01:00Z") }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) {
      return;
    }
    expect(r.error).toContain("run_finished from pending");
  });
});

describe("body canonical escaping (Go parity)", () => {
  it("escapes U+2028/U+2029 in nested body strings the way Go's encoder does", () => {
    const bytes = canonicalBytes({
      id: "evt_x",
      run: RUN,
      v: "driver-state-v0.1.0",
      kind: "stream_failed",
      stream: STREAM,
      time: "2026-07-20T00:00:00Z",
      actor: "ship:drv_test",
      ext_ref: "",
      body: { reason: "line\u2028sep\u2029end & <tag>" },
      prev: "",
      hash: "",
    });
    const text = Buffer.from(bytes).toString("utf8");
    expect(text).toContain('"reason":"line\\u2028sep\\u2029end & <tag>"');
    expect(text).not.toContain("\u2028");
    expect(text).not.toContain("\u2029");
  });
});

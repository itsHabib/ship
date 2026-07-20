/** Tests for the best-effort driver-state ledger emission decorator. */

import type { DriverRun, Store } from "@ship/store";

import { createStore } from "@ship/store";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ledgerRunId, ledgerStreamId, withDriverStateEmission } from "./driverstate-emit.js";
import { importManifest } from "./import.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "../test/fixtures");

let store: Store;
let wrapped: Store;
let stateRoot: string;
let priorStateDir: string | undefined;

beforeEach(() => {
  store = createStore({ dbPath: ":memory:" });
  wrapped = withDriverStateEmission(store);
  stateRoot = mkdtempSync(join(tmpdir(), "driverstate-emit-"));
  priorStateDir = process.env["WORKBENCH_STATE_DIR"];
  process.env["WORKBENCH_STATE_DIR"] = stateRoot;
});

afterEach(() => {
  store.close();
  if (priorStateDir === undefined) {
    delete process.env["WORKBENCH_STATE_DIR"];
  } else {
    process.env["WORKBENCH_STATE_DIR"] = priorStateDir;
  }
});

function importFixture(): DriverRun {
  return importManifest(wrapped, join(fixturesDir, "synthetic-full.driver.md")).run;
}

function ledgerKinds(driverRunId: string): string[] {
  const path = join(stateRoot, ledgerRunId(driverRunId), "events.jsonl");
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => (JSON.parse(l) as { kind: string }).kind);
}

function pendingStreamId(run: DriverRun): string {
  const stream = run.batches
    .flatMap((b) => b.streams)
    .find((s) => s.status === "pending" && s.taskSlug === "cloud-stream");
  if (stream === undefined) throw new Error("fixture has no pending cloud-stream");
  return stream.id;
}

describe("withDriverStateEmission", () => {
  it("emits run_imported with the manifest snapshot on insertDriverRun", () => {
    const run = importFixture();
    expect(ledgerKinds(run.id)).toEqual(["run_imported"]);

    const path = join(stateRoot, ledgerRunId(run.id), "events.jsonl");
    const first = JSON.parse(readFileSync(path, "utf8").split("\n")[0] ?? "") as {
      actor: string;
      ext_ref: string;
      body: { repo: string; streams: { stream: string }[]; manifest: unknown };
    };
    expect(first.actor).toBe(`ship:${run.id}`);
    expect(first.ext_ref).toBe(run.id);
    expect(first.body.streams.length).toBeGreaterThan(0);
    expect(first.body.streams[0]?.stream).toMatch(/^dss_/);
    expect(first.body.manifest).toBeTruthy();
  });

  it("maps stream lifecycle patches to ledger events through merge and run finish", () => {
    const run = importFixture();
    const streamId = pendingStreamId(run);

    wrapped.updateDriverStream(streamId, { status: "dispatching" });
    wrapped.updateDriverStream(streamId, { status: "landed" });
    wrapped.updateDriverStream(streamId, { prNumber: 41, prUrl: "https://x/pull/41" });
    wrapped.updateDriverStream(streamId, {
      mergeCommit: "abc123",
      mergedAt: "2026-07-20T00:00:00.000Z",
      status: "done",
    });

    expect(ledgerKinds(run.id)).toEqual([
      "run_imported",
      "stream_dispatched",
      "stream_attempt",
      "stream_pr_opened",
      "stream_merged",
    ]);
  });

  it("emits a terminal failed attempt with a failure category", () => {
    const run = importFixture();
    const streamId = pendingStreamId(run);

    wrapped.updateDriverStream(streamId, { status: "dispatching" });
    wrapped.updateDriverStream(streamId, {
      errorMessage: "runner exploded",
      status: "failed",
    });

    const path = join(stateRoot, ledgerRunId(run.id), "events.jsonl");
    const attempt = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as { kind: string; body: { failure_category?: string } })
      .find((e) => e.kind === "stream_attempt");
    expect(attempt?.body.failure_category).toBe("runner exploded");
  });

  it("uses deterministic ids so a replayed patch does not duplicate history", () => {
    const run = importFixture();
    const streamId = pendingStreamId(run);

    wrapped.updateDriverStream(streamId, { status: "dispatching" });
    wrapped.updateDriverStream(streamId, { status: "dispatching" });

    expect(ledgerKinds(run.id)).toEqual(["run_imported", "stream_dispatched"]);
  });

  it("derives dsr/dss ids from ship ids deterministically", () => {
    expect(ledgerRunId("drv_01ABC")).toBe("dsr_01ABC");
    expect(ledgerStreamId("ds_01ABC")).toBe("dss_01ABC");
  });

  it("never fails a store mutation when the ledger is unwritable", () => {
    // A FILE at the state root makes every run-dir mkdir fail.
    const blocked = join(stateRoot, "blocked");
    writeFileSync(blocked, "not a directory");
    process.env["WORKBENCH_STATE_DIR"] = blocked;

    const run = importFixture();
    const streamId = pendingStreamId(run);
    const updated = wrapped.updateDriverStream(streamId, { status: "dispatching" });

    expect(run.id).toMatch(/^drv_/);
    expect(updated.status).toBe("dispatching");

    // Same mutations against the bare store: identical outcomes.
    const bare = createStore({ dbPath: ":memory:" });
    try {
      const bareRun = importManifest(bare, join(fixturesDir, "synthetic-full.driver.md")).run;
      expect(bareRun.status).toBe(run.status);
    } finally {
      bare.close();
    }
  });
});

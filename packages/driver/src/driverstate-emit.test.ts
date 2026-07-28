/** Tests for the best-effort driver-state ledger emission decorator. */

import type { DriverRun, Store } from "@ship/store";

import { createStore } from "@ship/store";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  emitAddressIntervention,
  ledgerRunId,
  ledgerStreamId,
  withDriverStateEmission,
} from "./driverstate-emit.js";
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

function ledgerEvents(driverRunId: string): { kind: string; body: unknown; stream?: string }[] {
  const path = join(stateRoot, ledgerRunId(driverRunId), "events.jsonl");
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as { kind: string; body: unknown; stream?: string });
}

function ledgerKinds(driverRunId: string): string[] {
  return ledgerEvents(driverRunId).map((e) => e.kind);
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
    const kinds = ledgerKinds(run.id);
    expect(kinds[0]).toBe("run_imported");
    // Pre-completed manifest streams (done/skipped at import) close immediately.
    expect(kinds.slice(1).every((k) => k === "stream_skipped")).toBe(true);

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

  it("maps stream lifecycle patches to ledger events through merge", () => {
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

    const forStream = ledgerEvents(run.id)
      .filter((e) => (e as { stream?: string }).stream === ledgerStreamId(streamId))
      .map((e) => e.kind);
    expect(forStream).toEqual([
      "stream_dispatched",
      "stream_attempt",
      "stream_pr_opened",
      "stream_merged",
    ]);
  });

  it("falls back to merged_at now when the patch carries only the merge commit", () => {
    const run = importFixture();
    const streamId = pendingStreamId(run);

    wrapped.updateDriverStream(streamId, { status: "dispatching" });
    wrapped.updateDriverStream(streamId, { status: "landed" });
    wrapped.updateDriverStream(streamId, { prNumber: 41, prUrl: "https://x/pull/41" });
    wrapped.updateDriverStream(streamId, { mergeCommit: "abc123", status: "done" });

    const merged = ledgerEvents(run.id).find((e) => e.kind === "stream_merged");
    expect(merged?.body).toMatchObject({ merge_commit: "abc123", pr: 41 });
    expect((merged?.body as { merged_at: string }).merged_at).not.toBe("");
  });

  it("prefers the latest attempt's structured failureCategory over errorMessage", () => {
    const run = importFixture();
    const streamId = pendingStreamId(run);

    wrapped.updateDriverStream(streamId, { status: "dispatching" });
    wrapped.updateDriverStream(streamId, {
      attempts: [
        { dispatchedAt: "2026-07-20T00:00:00.000Z", failureCategory: "sdk-throw", terminal: true },
      ],
      errorMessage: "raw exception text",
      status: "failed",
    });

    const attempt = ledgerEvents(run.id).find((e) => e.kind === "stream_attempt");
    expect((attempt?.body as { failure_category: string }).failure_category).toBe("sdk-throw");
  });

  it("emits run_finished (and closes aborted streams) on a cancelled run; non-terminal statuses emit nothing", () => {
    const run = importFixture();
    const streamId = pendingStreamId(run);
    wrapped.updateDriverStream(streamId, { status: "dispatching" });

    wrapped.updateDriverRunStatus(run.id, "running");
    expect(ledgerKinds(run.id)).not.toContain("run_finished");

    wrapped.updateDriverRunStatus(run.id, "cancelled");
    const kinds = ledgerKinds(run.id);
    expect(kinds).toContain("run_finished");
    // The in-flight stream failed, the untouched manifest streams skipped.
    expect(kinds.filter((k) => k === "stream_failed")).toHaveLength(1);
    expect(kinds).toContain("stream_skipped");
    expect(kinds.at(-1)).toBe("run_finished");
  });

  it("emits a review_cycle when the address flow consumes a review artifact", () => {
    const run = importFixture();
    const streamId = pendingStreamId(run);
    wrapped.updateDriverStream(streamId, { status: "dispatching" });
    wrapped.updateDriverStream(streamId, { status: "landed" });
    wrapped.updateDriverStream(streamId, { prNumber: 41, prUrl: "https://x/pull/41" });

    wrapped.consumeReviewArtifactAndPrepareDispatch({
      addressCycle: 1,
      artifactId: "rf_one",
      attempts: [{ dispatchedAt: "2026-07-20T00:00:00.000Z", terminal: false }],
      canonicalSha256: "a".repeat(64),
      dispatchProvider: "cursor",
      docPath: "C:/repo/address.md",
      driverRunId: run.id,
      expectedReviewCycle: 0,
      headSha: "b".repeat(40),
      producerHarness: "codex",
      producerId: "codex:reviewfindings-github",
      prNumber: 41,
      repo: "example/ship",
      streamId,
    });

    expect(ledgerKinds(run.id)).toContain("review_cycle");
  });

  it("persists address receipt facts for a resumed stream imported as landed", () => {
    const runId = "drv_01IMPORTEDLANDED";
    const streamId = "ds_01IMPORTEDLANDED";
    const headSha = "b".repeat(40);
    const artifactDigest = "a".repeat(64);
    const run = wrapped.insertDriverRun({
      batches: [
        {
          batchIndex: 1,
          dependsOn: [],
          id: "db_01IMPORTEDLANDED",
          status: "running",
          streams: [
            {
              attempts: [],
              branch: "codex/imported-landed",
              id: streamId,
              prNumber: 41,
              prUrl: "https://github.com/example/ship/pull/41",
              runtime: "cloud",
              specPath: "docs/imported-landed.md",
              status: "landed",
              streamIndex: 0,
              taskId: "tsk_01IMPORTEDLANDED",
              touches: [],
            },
          ],
        },
      ],
      id: runId,
      manifestPath: join(fixturesDir, "synthetic-full.driver.md"),
      phase: "driver-extraction",
      project: "ship",
      repo: "example/ship",
      sourceJson: readFileSync(join(fixturesDir, "synthetic-full.driver.md"), "utf8"),
      status: "running",
    });

    wrapped.consumeReviewArtifactAndPrepareDispatch({
      addressCycle: 1,
      artifactId: "rf_imported_landed",
      attempts: [{ dispatchedAt: "2026-07-20T00:00:00.000Z", terminal: false }],
      canonicalSha256: artifactDigest,
      dispatchProvider: "codex",
      docPath: "C:/repo/address.md",
      driverRunId: run.id,
      expectedReviewCycle: 0,
      headSha,
      prNumber: 41,
      producerHarness: "codex",
      producerId: "codex:reviewfindings-github",
      repo: "example/ship",
      streamId,
    });

    const events = ledgerEvents(run.id).filter(
      (event) => event.stream === ledgerStreamId(streamId),
    );
    expect(events.map((event) => event.kind)).toEqual([
      "stream_dispatched",
      "stream_attempt",
      "stream_pr_opened",
      "closure_facts",
      "review_cycle",
    ]);
    expect(events.filter((event) => event.kind === "stream_attempt")).toHaveLength(1);
    expect(events.find((event) => event.kind === "stream_pr_opened")?.body).toMatchObject({
      head_sha: headSha,
      pr: 41,
    });
    expect(events.find((event) => event.kind === "closure_facts")?.body).toMatchObject({
      review_artifact_digest: artifactDigest,
      review_artifact_id: "rf_imported_landed",
      review_head_sha: headSha,
      review_producer: "codex:reviewfindings-github",
      task_ref: "tsk_01IMPORTEDLANDED",
    });
    expect(events.find((event) => event.kind === "review_cycle")?.body).toMatchObject({
      cycle: 1,
      panel_settled: true,
    });
  });

  it("emits one exact-head closure sequence from address through Gate handoff and merge", () => {
    const run = importFixture();
    const streamId = pendingStreamId(run);
    const openingHead = "b".repeat(40);
    const finalHead = "c".repeat(40);
    const catalogRevision = "d".repeat(40);
    wrapped.updateDriverStream(streamId, { status: "dispatching" });
    wrapped.updateDriverStream(streamId, { status: "landed" });
    wrapped.updateDriverStream(streamId, {
      prNumber: 41,
      prUrl: "https://github.com/example/ship/pull/41",
    });

    wrapped.consumeReviewArtifactAndPrepareDispatch({
      addressCycle: 1,
      artifactId: "rf_exact",
      attempts: [{ dispatchedAt: "2026-07-20T00:00:00.000Z", terminal: false }],
      canonicalSha256: "a".repeat(64),
      dispatchProvider: "codex",
      docPath: "C:/repo/address.md",
      driverRunId: run.id,
      expectedReviewCycle: 0,
      headSha: openingHead,
      prNumber: 41,
      producerCatalogRevision: catalogRevision,
      producerHarness: "codex",
      producerId: "codex:reviewfindings-github",
      repo: "example/ship",
      streamId,
    });
    wrapped.updateDriverStream(streamId, { status: "landed" });
    wrapped.updateDriverStream(streamId, {
      finalReviewedHeadSha: finalHead,
      gateRunRef: "run_01ab",
      mergeCommit: "merge-commit",
      mergeHeadSha: finalHead,
      mergedAt: "2026-07-20T01:00:00.000Z",
      prNumber: 41,
      status: "done",
    });
    // Idempotent re-land does not append a second terminal closure.
    wrapped.updateDriverStream(streamId, {
      finalReviewedHeadSha: finalHead,
      gateRunRef: "run_01ab",
      mergeCommit: "merge-commit",
      mergeHeadSha: finalHead,
      prNumber: 41,
      status: "done",
    });

    const events = ledgerEvents(run.id).filter(
      (event) => event.stream === ledgerStreamId(streamId),
    );
    const opening = events.find((event) => event.kind === "stream_pr_opened");
    const closures = events.filter((event) => event.kind === "closure_facts");
    const merged = events.filter((event) => event.kind === "stream_merged");
    expect(opening?.body).toMatchObject({ head_sha: openingHead, pr: 41 });
    expect(closures).toHaveLength(2);
    expect(closures[0]?.body).toMatchObject({
      catalog_revision: catalogRevision,
      review_artifact_digest: "a".repeat(64),
      review_artifact_id: "rf_exact",
      review_head_sha: openingHead,
      review_producer: "codex:reviewfindings-github",
      ship_run_ref: run.id,
    });
    expect(closures[1]?.body).toMatchObject({
      final_reviewed_head_sha: finalHead,
      gate_head_sha: finalHead,
      gate_run_ref: "run_01ab",
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]?.body).toMatchObject({ head_sha: finalHead, merge_commit: "merge-commit" });
  });

  it("keeps legacy missing catalog provenance incomplete and records stale repair once", () => {
    const run = importFixture();
    const streamId = pendingStreamId(run);
    const liveHead = "e".repeat(40);
    wrapped.updateDriverStream(streamId, { status: "dispatching" });
    wrapped.updateDriverStream(streamId, { status: "landed" });

    emitAddressIntervention({
      driverRunId: run.id,
      liveHeadSha: liveHead,
      prNumber: 41,
      reasonCode: "stale-review-head",
      repo: "example/ship",
      streamId,
    });
    emitAddressIntervention({
      driverRunId: run.id,
      liveHeadSha: liveHead,
      prNumber: 41,
      reasonCode: "stale-review-head",
      repo: "example/ship",
      streamId,
    });

    const events = ledgerEvents(run.id).filter(
      (event) => event.stream === ledgerStreamId(streamId),
    );
    expect(events.filter((event) => event.kind === "intervention")).toHaveLength(1);
    expect(events.find((event) => event.kind === "intervention")?.body).toMatchObject({
      kind: "mechanism-repair",
      reason_code: "stale-review-head",
    });
    expect(events.some((event) => event.kind === "stream_merged")).toBe(false);
  });

  it("records the terminal failed attempt of a fallback hop (pending reset patch)", () => {
    const run = importFixture();
    const streamId = pendingStreamId(run);

    wrapped.updateDriverStream(streamId, { status: "dispatching" });
    // decideFallbackHop's patch shape: terminal failed attempt + pending reset.
    wrapped.updateDriverStream(streamId, {
      attempts: [
        {
          dispatchedAt: "2026-07-20T00:00:00.000Z",
          failureCategory: "sdk-throw",
          terminal: true,
        },
      ],
      status: "pending",
    });
    wrapped.updateDriverStream(streamId, { status: "dispatching" });

    const forStream = ledgerEvents(run.id)
      .filter((e) => e.stream === ledgerStreamId(streamId))
      .map((e) => e.kind);
    expect(forStream).toEqual(["stream_dispatched", "stream_attempt", "stream_dispatched"]);
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

    const forStream = ledgerEvents(run.id).filter(
      (e) => (e as { stream?: string }).stream === ledgerStreamId(streamId),
    );
    expect(forStream.map((e) => e.kind)).toEqual(["stream_dispatched"]);
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

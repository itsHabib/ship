/** Tests for `importManifest`. */

import type { Store } from "@ship/store";

import { createStore, newDriverRunId } from "@ship/store";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { importManifest, ImportManifestError } from "./import.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "../test/fixtures");

function fixturePath(name: string): string {
  return join(fixturesDir, name);
}

describe("importManifest", () => {
  let store: Store;

  beforeEach(() => {
    store = createStore({ dbPath: ":memory:" });
  });

  afterEach(() => {
    store.close();
  });

  it("imports hygiene-followups with progress fields absorbed", () => {
    const path = fixturePath("hygiene-followups.driver.md");
    const { run } = importManifest(store, path);
    expect(run.status).toBe("done");
    expect(run.repo).toBe("dossier");
    expect(run.project).toBe("dossier");
    expect(run.phase).toBe("hygiene-followups");
    expect(run.sourceJson).toBe(readFileSync(path, "utf8"));

    const doneStreams = run.batches
      .flatMap((batch) => batch.streams)
      .filter((s) => s.status === "done");
    expect(doneStreams.length).toBeGreaterThan(0);
    expect(doneStreams.some((s) => s.prNumber !== undefined)).toBe(true);
    expect(doneStreams.some((s) => s.mergeCommit !== undefined)).toBe(true);
  });

  it("imports synthetic fixture with pending and failed stream mapping", () => {
    const path = fixturePath("synthetic-full.driver.md");
    const { run } = importManifest(store, path);
    expect(run.status).toBe("pending");

    const streams = run.batches.flatMap((batch) => batch.streams);
    const failed = streams.find((s) => s.taskSlug === "rooms-stream");
    expect(failed?.status).toBe("failed");
    expect(failed?.cycles).toBe(3);

    const inProgress = streams.find((s) => s.taskSlug === "cloud-stream");
    expect(inProgress?.status).toBe("pending");

    const skipped = streams.find((s) => s.taskSlug === "skipped-task");
    expect(skipped?.status).toBe("skipped");
  });

  it("re-import of same manifest is warn-and-noop", () => {
    const path = fixturePath("synthetic-full.driver.md");
    const first = importManifest(store, path);
    const second = importManifest(store, path);
    expect(second.alreadyImported).toBe(true);
    expect(second.run.id).toBe(first.run.id);
    expect(store.listDriverRuns({ limit: 50 })).toHaveLength(1);
  });

  it("re-import after editing progress fields in file is still noop", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-import-noop-"));
    const path = join(dir, "driver.md");
    const original = readFileSync(fixturePath("synthetic-full.driver.md"), "utf8");
    writeFileSync(path, original, "utf8");

    const first = importManifest(store, path);
    const edited = original.replace("status: failed", "status: done");
    writeFileSync(path, edited, "utf8");

    const second = importManifest(store, path);
    expect(second.alreadyImported).toBe(true);
    expect(second.run.id).toBe(first.run.id);
    expect(
      second.run.batches.flatMap((b) => b.streams).find((s) => s.taskSlug === "rooms-stream")
        ?.status,
    ).toBe("failed");
    rmSync(dir, { force: true, recursive: true });
  });

  it("re-import finds its run behind 200+ newer runs for the same repo", () => {
    const path = fixturePath("synthetic-full.driver.md");
    const first = importManifest(store, path);

    for (let index = 0; index < 201; index += 1) {
      store.insertDriverRun({
        batches: [],
        id: newDriverRunId(),
        manifestPath: `/tmp/noise-${String(index)}.md`,
        phase: `noise-phase-${String(index)}`,
        project: "ship",
        repo: first.run.repo,
        sourceJson: "---\ndriver_version: 1\n---\n",
        status: "pending",
      });
    }

    const second = importManifest(store, path);
    expect(second.alreadyImported).toBe(true);
    expect(second.run.id).toBe(first.run.id);
  });

  it("assigns streamIndex in manifest order", () => {
    const path = fixturePath("hygiene-followups.driver.md");
    const { run } = importManifest(store, path);
    const firstBatch = run.batches[0];
    expect(firstBatch?.streams.map((s) => s.streamIndex)).toEqual([0, 1, 2]);
  });

  it("propagates parse failures as ImportManifestError", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-import-bad-"));
    const path = join(dir, "driver.md");
    writeFileSync(path, "not a manifest", "utf8");
    expect(() => importManifest(store, path)).toThrow(ImportManifestError);
    rmSync(dir, { force: true, recursive: true });
  });

  it("wraps a missing manifest file as ImportManifestError", () => {
    const path = fixturePath("does-not-exist.driver.md");
    expect(() => importManifest(store, path)).toThrow(ImportManifestError);
    expect(() => importManifest(store, path)).toThrow(/cannot read manifest/);
  });

  it("returns warnings for manifests with unknown keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-import-warn-"));
    const path = join(dir, "driver.md");
    const text = [
      "---",
      "driver_version: 1",
      "generated_at: 2026-06-10T00:00:00Z",
      "generated_by: work-driver-prep",
      "source:",
      "  project: ship",
      "  phase: test",
      "repo: ship",
      "base_branch: main",
      "batches: []",
      "---",
    ].join("\n");
    writeFileSync(path, text, "utf8");

    const { run, warnings } = importManifest(store, path);
    expect(run.repo).toBe("ship");
    expect(warnings).toBeDefined();
    expect(warnings?.some((warning) => warning.includes('unknown field "base_branch"'))).toBe(true);
    rmSync(dir, { force: true, recursive: true });
  });

  it("re-import of manifest with unknown keys still returns warnings", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-import-rewarn-"));
    const path = join(dir, "driver.md");
    const text = [
      "---",
      "driver_version: 1",
      "generated_at: 2026-06-10T00:00:00Z",
      "generated_by: work-driver-prep",
      "source:",
      "  project: ship",
      "  phase: test",
      "repo: ship",
      "rolls_up_task_ids: [tsk_01]",
      "batches: []",
      "---",
    ].join("\n");
    writeFileSync(path, text, "utf8");

    const first = importManifest(store, path);
    const second = importManifest(store, path);
    expect(second.alreadyImported).toBe(true);
    expect(second.run.id).toBe(first.run.id);
    expect(second.warnings?.some((warning) => warning.includes("rolls_up_task_ids"))).toBe(true);
    rmSync(dir, { force: true, recursive: true });
  });
});

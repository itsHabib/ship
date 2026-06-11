/** Tests for `importManifest`. */

import type { Store } from "@ship/store";

import { createStore } from "@ship/store";
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

  it("propagates parse failures as ImportManifestError", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-import-bad-"));
    const path = join(dir, "driver.md");
    writeFileSync(path, "not a manifest", "utf8");
    expect(() => importManifest(store, path)).toThrow(ImportManifestError);
    rmSync(dir, { force: true, recursive: true });
  });
});

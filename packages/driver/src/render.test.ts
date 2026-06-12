/** Tests for `renderDriverRun`. */

import type { Store } from "@ship/store";

import { DriverRunNotFoundError } from "@ship/store";
import { createStore } from "@ship/store";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ManifestBatch } from "./manifest.js";

import { importManifest } from "./import.js";
import { parseManifest } from "./manifest.js";
import { renderDriverRun } from "./render.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "../test/fixtures");

function firstBatchStreams(rendered: string): NonNullable<ManifestBatch["streams"]> {
  const parsed = parseManifest(rendered);
  if (!parsed.ok) {
    throw new Error("rendered manifest failed to parse");
  }
  return parsed.manifest.batches[0]?.streams ?? [];
}

describe("renderDriverRun", () => {
  let store: Store;

  beforeEach(() => {
    store = createStore({ dbPath: ":memory:" });
  });

  afterEach(() => {
    store.close();
  });

  it("preserves markdown body and unknown advisory fields", () => {
    const path = join(fixturesDir, "synthetic-full.driver.md");
    const { run } = importManifest(store, path);
    const rendered = renderDriverRun(store, run.id);
    const original = readFileSync(path, "utf8");
    const originalBody = original.slice(original.indexOf("\n---\n", 4) + 5);
    const renderedBody = rendered.slice(rendered.indexOf("\n---\n", 4) + 5);
    expect(renderedBody).toBe(originalBody);

    const parsed = parseManifest(rendered);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.conflict_notes).toBeDefined();
    expect(parsed.manifest.runtime_notes).toBeDefined();
  });

  it("overlays stream progress from store rows", () => {
    const path = join(fixturesDir, "synthetic-full.driver.md");
    const { run } = importManifest(store, path);
    const streamId = run.batches[0]?.streams.find((s) => s.taskSlug === "cloud-stream")?.id;
    expect(streamId).toBeDefined();
    store.updateDriverStream(streamId!, {
      prNumber: 999,
      status: "landed",
    });

    const rendered = renderDriverRun(store, run.id);
    const parsed = parseManifest(rendered);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const cloud = parsed.manifest.batches[0]?.streams.find((s) => s.task_slug === "cloud-stream");
    expect(cloud?.status).toBe("in_progress");
    expect(cloud?.pr_number).toBe(999);
  });

  it("drops stale completed_at when the store batch has none", () => {
    const path = join(fixturesDir, "synthetic-full.driver.md");
    const { run } = importManifest(store, path);

    const rendered = renderDriverRun(store, run.id);
    const parsed = parseManifest(rendered);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // The fixture's batch 1 is `running` with a (stale) completed_at; import
    // stores it as pending without completedAt, so render must not resurrect
    // the timestamp from the source frontmatter.
    expect(parsed.manifest.batches[0]?.status).toBe("pending");
    expect(parsed.manifest.batches[0]?.completed_at).toBeUndefined();
  });

  it("pairs duplicate spec_path streams positionally", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-render-dup-"));
    const path = join(dir, "driver.md");
    writeFileSync(
      path,
      [
        "---",
        "driver_version: 1",
        "generated_at: 2026-06-11T00:00:00Z",
        "generated_by: work-driver-prep",
        "source:",
        "  project: ship",
        "  phase: dup-spec",
        "repo: ship",
        "batches:",
        "  - id: 1",
        "    depends_on: []",
        "    streams:",
        "      - spec_path: docs/shared.md",
        "      - spec_path: docs/shared.md",
        "---",
        "",
      ].join("\n"),
      "utf8",
    );

    const { run } = importManifest(store, path);
    const second = run.batches[0]?.streams.find((s) => s.streamIndex === 1);
    expect(second).toBeDefined();
    store.updateDriverStream(second!.id, { prNumber: 7, status: "done" });

    const streams = firstBatchStreams(renderDriverRun(store, run.id));
    expect(streams[0]?.status).toBe("pending");
    expect(streams[0]?.pr_number).toBeUndefined();
    expect(streams[1]?.status).toBe("done");
    expect(streams[1]?.pr_number).toBe(7);
    rmSync(dir, { force: true, recursive: true });
  });

  it("two-render determinism: same state yields byte-identical output", () => {
    const path = join(fixturesDir, "hygiene-followups.driver.md");
    const { run } = importManifest(store, path);
    const first = renderDriverRun(store, run.id);
    const second = renderDriverRun(store, run.id);
    expect(second).toBe(first);
  });

  it("throws DriverRunNotFoundError for unknown id", () => {
    expect(() => renderDriverRun(store, "drv_missing")).toThrow(DriverRunNotFoundError);
  });
});

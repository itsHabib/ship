/** Tests for `renderDriverRun`. */

import type { Store } from "@ship/store";

import { DriverRunNotFoundError } from "@ship/store";
import { createStore } from "@ship/store";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { importManifest } from "./import.js";
import { parseManifest } from "./manifest.js";
import { renderDriverRun } from "./render.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "../test/fixtures");

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

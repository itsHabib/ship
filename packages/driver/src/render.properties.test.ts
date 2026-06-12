/** fast-check round-trip property: store mutations → render → parse → progress fields. */

import type { DriverStreamStatus, Store } from "@ship/store";

import { fc, test as fcTest } from "@fast-check/vitest";
import { createStore } from "@ship/store";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect } from "vitest";

import { importManifest } from "./import.js";
import { parseManifest } from "./manifest.js";
import { renderDriverRun } from "./render.js";
import { manifestStatusToStore, storeStatusToManifest } from "./status-mapping.js";

const here = dirname(fileURLToPath(import.meta.url));
const syntheticFixture = join(here, "../test/fixtures/synthetic-full.driver.md");
const cloudStreamSpec = "docs/features/driver-extraction/phases/cloud-stream.md";

const terminalStreamStatuses = ["pending", "done", "failed", "skipped"] as const;
const transientStreamStatuses = ["dispatching", "dispatched", "landed"] as const;

function cloudStreamFromFixture(store: Store) {
  const { run } = importManifest(store, syntheticFixture);
  const stream = run.batches
    .flatMap((batch) => batch.streams)
    .find((item) => item.specPath === cloudStreamSpec);
  if (stream === undefined) {
    throw new Error("cloud-stream fixture row missing");
  }
  return { runId: run.id, streamId: stream.id };
}

function renderedCloudStream(rendered: string) {
  const reparsed = parseManifest(rendered);
  expect(reparsed.ok).toBe(true);
  if (!reparsed.ok) {
    return undefined;
  }
  return reparsed.manifest.batches
    .flatMap((batch) => batch.streams)
    .find((item) => item.spec_path === cloudStreamSpec);
}

describe("driver render round-trip property", () => {
  fcTest.prop([fc.constantFrom(...terminalStreamStatuses)], { numRuns: 40 })(
    "terminal store statuses round-trip losslessly",
    (storeStatus) => {
      const store = createStore({ dbPath: ":memory:" });
      try {
        const { runId, streamId } = cloudStreamFromFixture(store);
        store.updateDriverStream(streamId, { status: storeStatus });
        const rendered = renderDriverRun(store, runId);
        const cloud = renderedCloudStream(rendered);
        expect(cloud?.status).toBe(storeStatusToManifest(storeStatus));
        expect(manifestStatusToStore(cloud?.status)).toBe(storeStatus);
      } finally {
        store.close();
      }
    },
  );

  fcTest.prop([fc.constantFrom(...transientStreamStatuses)], { numRuns: 20 })(
    "transient store statuses degrade to in_progress in manifest",
    (storeStatus) => {
      const store = createStore({ dbPath: ":memory:" });
      try {
        const { runId, streamId } = cloudStreamFromFixture(store);
        store.updateDriverStream(streamId, { status: storeStatus as DriverStreamStatus });
        const rendered = renderDriverRun(store, runId);
        const cloud = renderedCloudStream(rendered);
        expect(cloud?.status).toBe("in_progress");
        expect(manifestStatusToStore(cloud?.status)).toBe("pending");
      } finally {
        store.close();
      }
    },
  );

  fcTest.prop(
    [
      fc.option(fc.integer({ min: 1, max: 9999 }), { nil: undefined }),
      fc.option(fc.string({ minLength: 7, maxLength: 40 }), { nil: undefined }),
      fc.option(fc.integer({ min: 0, max: 5 }), { nil: undefined }),
    ],
    { numRuns: 30 },
  )("progress scalars survive render → parse", (prNumber, mergeCommit, cycles) => {
    const store = createStore({ dbPath: ":memory:" });
    try {
      const { runId, streamId } = cloudStreamFromFixture(store);
      const patch: {
        status: "done";
        cycles?: number;
        mergeCommit?: string;
        prNumber?: number;
      } = { status: "done" };
      if (cycles !== undefined) patch.cycles = cycles;
      if (mergeCommit !== undefined) patch.mergeCommit = mergeCommit;
      if (prNumber !== undefined) patch.prNumber = prNumber;
      store.updateDriverStream(streamId, patch);
      const rendered = renderDriverRun(store, runId);
      const cloud = renderedCloudStream(rendered);
      expect(cloud?.pr_number).toBe(prNumber);
      expect(cloud?.merge_commit).toBe(mergeCommit);
      expect(cloud?.cycles).toBe(cycles);
    } finally {
      store.close();
    }
  });
});

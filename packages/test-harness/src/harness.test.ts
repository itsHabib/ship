/**
 * Tests for `harness.ts`.
 *
 * Covers what no scenario test directly asserts:
 * - default `:memory:` dbPath produces a working store
 * - file-backed dbPath produces a real file
 * - clock + ids are wired to the underlying store (clock string lands as
 *   `createdAt`; ids round-trip)
 * - `close()` is idempotent
 */

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { Harness } from "./harness.js";

import { createSampleWorkflowRunInput } from "./fixtures.js";
import { createHarness } from "./harness.js";

describe("createHarness", () => {
  let h: Harness;

  beforeEach(() => {
    h = createHarness();
  });

  afterEach(() => {
    h.close();
  });

  test("default dbPath produces a working in-memory store", () => {
    const id = h.ids.workflowRun();
    const created = h.store.createWorkflowRun(createSampleWorkflowRunInput(id));
    expect(h.store.getRun(id)).toEqual(created);
  });

  test("clock is the source of truth for createdAt", () => {
    const id = h.ids.workflowRun();
    const before = h.clock(); // emit one timestamp; harness will use the next.
    const created = h.store.createWorkflowRun(createSampleWorkflowRunInput(id));
    // clock auto-advances 1ms per call; `before` is one tick ahead of t0,
    // and the createWorkflowRun internally calls clock(), so created.createdAt > before.
    expect(Date.parse(created.createdAt)).toBeGreaterThan(Date.parse(before));
  });

  test("ids return fresh prefixed ULIDs each call", () => {
    expect(h.ids.workflowRun()).toMatch(/^wf_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(h.ids.phase()).toMatch(/^ph_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(h.ids.cursorRun()).toMatch(/^cr_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(h.ids.workflowRun()).not.toBe(h.ids.workflowRun());
  });

  test("close() is idempotent", () => {
    h.close();
    expect(() => {
      h.close();
    }).not.toThrow();
  });

  test("methods on a closed store throw (sanity check)", () => {
    h.close();
    expect(() => h.store.listRuns({})).toThrow();
  });
});

describe("createHarness with file-backed dbPath", () => {
  let tmp: string;
  let h: Harness;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ship-harness-"));
    h = createHarness({ dbPath: join(tmp, "state.db") });
  });

  afterEach(() => {
    h.close();
    rmSync(tmp, { force: true, recursive: true });
  });

  test("creates a real file at the dbPath", () => {
    expect(statSync(join(tmp, "state.db")).isFile()).toBe(true);
  });

  test("survives close + re-open via a fresh harness", () => {
    const id = h.ids.workflowRun();
    h.store.createWorkflowRun(createSampleWorkflowRunInput(id));
    h.close();

    const reopened = createHarness({ dbPath: join(tmp, "state.db") });
    try {
      expect(reopened.store.getRun(id)).not.toBeNull();
    } finally {
      reopened.close();
    }
  });
});

describe("createHarness option propagation", () => {
  test("custom clockStart is honored — first user-visible tick lands within the configured second", () => {
    // createStore consumes a few clock ticks internally (migration's
    // applied_at). After it returns, the next call must still be within
    // the start moment's same minute, just a few ms in.
    const start = "2027-01-01T00:00:00.000Z";
    const h = createHarness({ clockStart: start });
    try {
      const first = h.clock();
      expect(first.startsWith("2027-01-01T00:00:00.")).toBe(true);
      expect(Date.parse(first)).toBeGreaterThan(Date.parse(start));
    } finally {
      h.close();
    }
  });

  test("custom clockStepMs is honored — consecutive user-visible calls advance by that step", () => {
    const h = createHarness({ clockStart: "2027-01-01T00:00:00.000Z", clockStepMs: 1000 });
    try {
      const a = Date.parse(h.clock());
      const b = Date.parse(h.clock());
      expect(b - a).toBe(1000);
    } finally {
      h.close();
    }
  });
});

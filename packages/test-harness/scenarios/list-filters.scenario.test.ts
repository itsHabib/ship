/**
 * Scenario: listRuns filtering across multiple repos and statuses.
 *
 * Seeds a fixed corpus of runs across two repos (`alpha`, `beta`) × three
 * statuses (`pending`, `running`, `succeeded`), each with 0-2 phases, then
 * asserts:
 * - `listRuns({})` returns all in most-recent-first order
 * - `listRuns({ repo })` filters correctly
 * - `listRuns({ status: [...] })` filters correctly
 * - `listRuns({ repo, status })` AND-combines
 * - phases are correctly grouped to their parent (no cross-leak)
 *
 * Exercises the two-query budget path (see workflow-runs.test.ts) at the
 * scenario level: same data, same assertions, end-to-end through the
 * public API.
 */

import { afterEach, beforeEach, expect, test } from "vitest";

import type { Harness } from "../src/index.js";

import {
  createHarness,
  createSampleAppendPhaseInput,
  createSampleWorkflowRunInput,
} from "../src/index.js";

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

afterEach(() => {
  h.close();
});

interface Seed {
  id: string;
  repo: string;
  finalStatus: "pending" | "running" | "succeeded";
  phaseCount: number;
}

function seedCorpus(): Seed[] {
  const seeds: Seed[] = [
    { finalStatus: "pending", id: h.ids.workflowRun(), phaseCount: 0, repo: "alpha" },
    { finalStatus: "running", id: h.ids.workflowRun(), phaseCount: 1, repo: "alpha" },
    { finalStatus: "succeeded", id: h.ids.workflowRun(), phaseCount: 2, repo: "alpha" },
    { finalStatus: "pending", id: h.ids.workflowRun(), phaseCount: 0, repo: "beta" },
    { finalStatus: "running", id: h.ids.workflowRun(), phaseCount: 1, repo: "beta" },
    { finalStatus: "succeeded", id: h.ids.workflowRun(), phaseCount: 1, repo: "beta" },
  ];
  for (const s of seeds) {
    h.store.createWorkflowRun(createSampleWorkflowRunInput(s.id, { repo: s.repo }));
    if (s.finalStatus !== "pending") {
      h.store.updateWorkflowRunStatus(s.id, "running");
    }
    if (s.finalStatus === "succeeded") {
      h.store.updateWorkflowRunStatus(s.id, "succeeded");
    }
    for (let i = 0; i < s.phaseCount; i++) {
      h.store.appendPhase(createSampleAppendPhaseInput(h.ids.phase(), s.id));
    }
  }
  return seeds;
}

test("listRuns({}): returns all seeded rows, most-recent-first", () => {
  const seeds = seedCorpus();
  const list = h.store.listRuns({});
  expect(list).toHaveLength(seeds.length);
  // Most-recent-first: last seeded comes first.
  expect(list[0]?.id).toBe(seeds[seeds.length - 1]?.id);
});

test("listRuns({ repo: 'alpha' }) filters by repo only", () => {
  seedCorpus();
  const alphaOnly = h.store.listRuns({ repo: "alpha" });
  expect(alphaOnly.every((r) => r.repo === "alpha")).toBe(true);
  expect(alphaOnly).toHaveLength(3);
});

test("listRuns({ status: ['running', 'pending'] }) filters by status array", () => {
  seedCorpus();
  const inProgress = h.store.listRuns({ status: ["pending", "running"] });
  expect(inProgress.every((r) => r.status === "pending" || r.status === "running")).toBe(true);
  expect(inProgress).toHaveLength(4);
});

test("listRuns({ repo, status }) AND-combines filters", () => {
  seedCorpus();
  const result = h.store.listRuns({ repo: "alpha", status: ["succeeded"] });
  expect(result).toHaveLength(1);
  expect(result[0]?.repo).toBe("alpha");
  expect(result[0]?.status).toBe("succeeded");
});

test("phases are grouped to their parent run, no cross-leak", () => {
  const seeds = seedCorpus();
  const list = h.store.listRuns({});
  // Each returned row's phases must belong to that row.
  for (const row of list) {
    expect(row.phases.every((p) => p.workflowRunId === row.id)).toBe(true);
  }
  // Total phases across the list matches the seed sum.
  const total = list.reduce((acc, r) => acc + r.phases.length, 0);
  const expected = seeds.reduce((acc, s) => acc + s.phaseCount, 0);
  expect(total).toBe(expected);
});

test("listRuns({ repo: 'no-such' }) returns []", () => {
  seedCorpus();
  expect(h.store.listRuns({ repo: "no-such-repo" })).toEqual([]);
});

/**
 * Property-based checks for shared RunResult → CursorRunResult mapping.
 */

import type { RunResult } from "@cursor/sdk";

import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";

import type { CloudRunSpec, CursorRunInput } from "./runner.js";

import { mapRunResult, mapTerminalResult } from "./_shared.js";

function readPositiveIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const ITER = readPositiveIntEnv("SHIP_PROP_ITER", 100);
const PROP_SEED = readPositiveIntEnv("SHIP_PROP_SEED", 0x2fed12f);

fc.configureGlobal({ seed: PROP_SEED });

const TERMINAL_CURSOR_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

const branchEntryArbitrary = fc.record({
  repoUrl: fc.string({ minLength: 1 }),
  branch: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
  prUrl: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
});

const runResultArbitrary = fc.oneof(
  fc.record({
    id: fc.string({ minLength: 1 }),
    status: fc.constant("finished" as const),
    durationMs: fc.option(fc.nat(), { nil: undefined }),
    result: fc.option(fc.string(), { nil: undefined }),
    model: fc.option(fc.record({ id: fc.string({ minLength: 1 }) }), { nil: undefined }),
    git: fc.option(
      fc.record({
        branches: fc.array(branchEntryArbitrary, { maxLength: 3 }),
      }),
      { nil: undefined },
    ),
  }),
  fc.record({
    id: fc.string({ minLength: 1 }),
    status: fc.constant("cancelled" as const),
    durationMs: fc.option(fc.nat(), { nil: undefined }),
    git: fc.option(
      fc.record({
        branches: fc.array(branchEntryArbitrary, { maxLength: 3 }),
      }),
      { nil: undefined },
    ),
  }),
  fc.record({
    id: fc.string({ minLength: 1 }),
    status: fc.constant("error" as const),
    durationMs: fc.option(fc.nat(), { nil: undefined }),
    result: fc.option(fc.string(), { nil: undefined }),
    git: fc.option(
      fc.record({
        branches: fc.array(branchEntryArbitrary, { maxLength: 3 }),
      }),
      { nil: undefined },
    ),
  }),
) as fc.Arbitrary<RunResult>;

const minimalInput: CursorRunInput = {
  cwd: "/tmp",
  model: { id: "composer-2.5" },
  onEvent: () => undefined,
  prompt: "test",
};

const baseCloudSpec = {
  repos: [{ url: "https://github.com/acme/sandbox" }],
} as const satisfies CloudRunSpec;

function mapForBranchProperty(result: RunResult) {
  if (result.status === "finished") {
    return mapTerminalResult(result, "succeeded", baseCloudSpec);
  }
  if (result.status === "cancelled") {
    return mapTerminalResult(result, "cancelled", baseCloudSpec);
  }
  return mapRunResult(result, minimalInput);
}

function expectBranchesPreserved(result: RunResult): void {
  const mapped = mapForBranchProperty(result);
  const sdkBranches = result.git?.branches ?? [];
  expect(mapped.branches).toHaveLength(sdkBranches.length);
  for (let i = 0; i < sdkBranches.length; i += 1) {
    const mappedBranch = mapped.branches[i];
    const sdkBranch = sdkBranches[i];
    expect(mappedBranch?.repoUrl).toBe(sdkBranch?.repoUrl);
    expect(mappedBranch?.branch).toBe(sdkBranch?.branch);
    expect(mappedBranch?.prUrl).toBe(sdkBranch?.prUrl);
  }
}

describe("_shared mapping properties (fast-check)", () => {
  test.prop([runResultArbitrary], { numRuns: ITER })(
    "S1: mapRunResult status is always terminal (succeeded | failed | cancelled)",
    (result) => {
      const mapped = mapRunResult(result, minimalInput);
      expect(TERMINAL_CURSOR_STATUSES.has(mapped.status)).toBe(true);
    },
  );

  test.prop([runResultArbitrary], { numRuns: ITER })(
    "S2: mapTerminalResult / mapRunResult branches preserve repoUrl entries",
    (result) => {
      expectBranchesPreserved(result);
    },
  );
});

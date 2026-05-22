/** Tests for `deriveCloudWarnings` and `mapTerminalResult` warning wiring. */

import type { RunResult } from "@cursor/sdk";

import { describe, expect, test } from "vitest";

import type { CloudRunSpec } from "./runner.js";
import type { CursorRunInput } from "./runner.js";

import { deriveCloudWarnings, mapRunResult, mapTerminalResult } from "./_shared.js";

const baseSpec = {
  repos: [{ url: "https://github.com/acme/sandbox" }],
} as const satisfies CloudRunSpec;

describe("deriveCloudWarnings", () => {
  test("returns [] when spec is undefined", () => {
    expect(deriveCloudWarnings(undefined, { status: "finished" } as RunResult)).toEqual([]);
  });

  test("autoCreatePR true without prUrl yields autoCreatePR warning", () => {
    const result = {
      git: { branches: [{ repoUrl: "github.com/acme/sandbox" }] },
      status: "finished",
    } as RunResult;
    const spec = { ...baseSpec, autoCreatePR: true } as CloudRunSpec;
    expect(deriveCloudWarnings(spec, result)).toContain(
      "autoCreatePR was requested but result.branches[0].prUrl is undefined",
    );
  });

  test("workOnCurrentBranch not true without branch yields branch warning", () => {
    const result = {
      git: { branches: [{ repoUrl: "github.com/acme/sandbox" }] },
      status: "finished",
    } as RunResult;
    expect(deriveCloudWarnings(baseSpec, result)).toContain(
      "a new branch was expected (workOnCurrentBranch !== true) but result.branches[0].branch is undefined",
    );
  });

  test("startingRef mismatch against result.git.ref yields ref warning", () => {
    const result = {
      git: { branches: [{ repoUrl: "github.com/acme/sandbox" }], ref: "main" },
      id: "run-ref",
      status: "finished",
    } as unknown as RunResult;
    const spec = {
      repos: [{ url: "https://github.com/acme/sandbox", startingRef: "ship-l3-fixture" }],
    } as CloudRunSpec;
    expect(deriveCloudWarnings(spec, result)).toContain(
      "startingRef 'ship-l3-fixture' was requested but result.git reports ref 'main'",
    );
  });
});

describe("mapTerminalResult warnings field", () => {
  test("omits warnings when deriveCloudWarnings returns empty", () => {
    const mapped = mapTerminalResult({ status: "finished" } as RunResult, "succeeded");
    expect(mapped).not.toHaveProperty("warnings");
  });

  test("includes warnings at top level when deriveCloudWarnings is non-empty", () => {
    const result = {
      git: { branches: [{ repoUrl: "github.com/acme/sandbox" }] },
      status: "finished",
    } as RunResult;
    const spec = { ...baseSpec, autoCreatePR: true } as CloudRunSpec;
    const mapped = mapTerminalResult(result, "succeeded", spec);
    expect(mapped.warnings).toEqual([
      "autoCreatePR was requested but result.branches[0].prUrl is undefined",
      "a new branch was expected (workOnCurrentBranch !== true) but result.branches[0].branch is undefined",
    ]);
  });

  test("suppresses warnings on cancelled runs even with a diverging spec", () => {
    // A cancelled run has no branch / no PR by construction — derivation
    // would emit uniformly false-positive divergence warnings.
    const result = {
      git: { branches: [{ repoUrl: "github.com/acme/sandbox" }] },
      status: "cancelled",
    } as RunResult;
    const spec = { ...baseSpec, autoCreatePR: true } as CloudRunSpec;
    const mapped = mapTerminalResult(result, "cancelled", spec);
    expect(mapped).not.toHaveProperty("warnings");
    expect(mapped.status).toBe("cancelled");
  });
});

describe("mapRunResult cloud-spec gating", () => {
  test("local-style call (no third arg) does NOT derive warnings even when input.cloud is set", () => {
    // Regression guard: a CursorRunInput with a stray .cloud field handed to
    // the local runtime must not surface cloud-divergence warnings on the
    // persisted local result.
    const result = {
      durationMs: 50,
      git: { branches: [{ repoUrl: "github.com/acme/sandbox" }] },
      status: "finished",
    } as RunResult;
    const input = {
      cloud: { autoCreatePR: true, repos: [{ url: "https://github.com/acme/sandbox" }] },
      cwd: "/tmp",
      model: { id: "composer-2.5" },
      onEvent: () => undefined,
      prompt: "noop",
      runtime: "local",
    } as unknown as CursorRunInput;
    const mapped = mapRunResult(result, input);
    expect(mapped).not.toHaveProperty("warnings");
  });
});

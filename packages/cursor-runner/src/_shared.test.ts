/** Tests for `deriveCloudWarnings` and `mapTerminalResult` warning wiring. */

import type { RunResult, SDKMessage } from "@cursor/sdk";

import { describe, expect, test } from "vitest";

import type { CloudRunSpec, CursorRunInput } from "./runner.js";

import {
  buildTerminalErrorMessage,
  deriveCloudWarnings,
  mapRunResult,
  mapTerminalResult,
} from "./_shared.js";

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

describe("buildTerminalErrorMessage", () => {
  test("prefers RunResult.result when present", () => {
    const msg = buildTerminalErrorMessage(
      { status: "error", result: "model rejected" } as RunResult,
      [],
    );
    expect(msg).toBe("model rejected");
  });

  test("folds last tool_call error and SDK status", () => {
    const toolErr = {
      type: "tool_call",
      status: "error",
      result: "database is locked",
    } as unknown as SDKMessage;
    const msg = buildTerminalErrorMessage(
      { durationMs: 27 * 60 * 1000, status: "error" } as RunResult,
      [toolErr],
      30 * 60 * 1000,
    );
    expect(msg).toContain("database is locked");
    expect(msg).toMatch(/SDK status ERROR/);
    expect(msg).toMatch(/27m.*cap 30m/);
  });

  test("prefers the tool_call detail over a trailing terminal status event", () => {
    // Natural stream order: the tool_call error precedes the terminal
    // status:ERROR. The specific detail must win — guards the regression where
    // the trailing status event overwrote it with the bare "ERROR" enum.
    const toolErr = {
      type: "tool_call",
      status: "error",
      result: "database is locked",
    } as unknown as SDKMessage;
    const statusErr = { type: "status", status: "ERROR" } as unknown as SDKMessage;
    const msg = buildTerminalErrorMessage({ durationMs: 1000, status: "error" } as RunResult, [
      toolErr,
      statusErr,
    ]);
    expect(msg).toContain("last tool_call errored: database is locked");
    expect(msg).not.toMatch(/errored: ERROR/);
  });

  test("falls back to a terminal status message when no tool_call error is present", () => {
    const statusErr = {
      type: "status",
      status: "EXPIRED",
      message: "run exceeded time budget",
    } as unknown as SDKMessage;
    const msg = buildTerminalErrorMessage({ durationMs: 1000, status: "error" } as RunResult, [
      statusErr,
    ]);
    expect(msg).toContain("detail: run exceeded time budget");
    expect(msg).toMatch(/SDK status EXPIRED/);
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

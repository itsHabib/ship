/** Triage-floor classifier tests — parse, orchestration, and the spawn seam. */

import { execPath } from "node:process";
import { describe, expect, test } from "vitest";

import type { TriageExec, TriageFloorResult, TriageOutcome } from "./triage.js";

import { createExecTriageClassifier, parseTriageTier, spawnWithStdin } from "./triage.js";

// A binary guaranteed not to exist on PATH — the missing-classifier case.
const MISSING_BIN = "triage-floor-does-not-exist-xyz-123";

// Narrow an outcome to its error reason, failing loudly when it classified.
function errorReason(outcome: TriageOutcome): string {
  expect(outcome.kind).toBe("error");
  if (outcome.kind !== "error") throw new Error("expected a classifier error");
  return outcome.reason;
}

describe("parseTriageTier", () => {
  test.each(["T0", "T1", "T2", "T3"])("accepts %s", (tier) => {
    expect(parseTriageTier(tier)).toBe(tier);
  });

  test("tolerates trailing newline and whitespace", () => {
    expect(parseTriageTier("  T1  \n")).toBe("T1");
  });

  test("reads the tier off the last non-empty line", () => {
    expect(parseTriageTier("classifying...\n\nT2\n")).toBe("T2");
  });

  test.each([
    ["empty output", ""],
    ["whitespace only", "   \n  "],
    ["prose without a tier", "looks risky"],
    ["out-of-range tier", "T4"],
    ["lowercase", "t1"],
    ["tier with trailing tokens", "T1 high"],
    ["tier not on the last line", "T1\ndone"],
  ])("rejects %s as unparseable", (_label, stdout) => {
    expect(parseTriageTier(stdout)).toBeUndefined();
  });
});

function fakeExec(overrides: Partial<TriageExec>): Partial<TriageExec> {
  return overrides;
}

describe("createExecTriageClassifier (injected seam)", () => {
  test("classifies a parseable tier on exit 0", async () => {
    const classifier = createExecTriageClassifier({
      exec: fakeExec({
        diff: () => Promise.resolve("--- a\n+++ b\n"),
        triageFloor: () => Promise.resolve({ code: 0, stdout: "T1\n" }),
      }),
    });
    await expect(classifier.classify("itsHabib/ship", 42)).resolves.toEqual({
      kind: "classified",
      tier: "T1",
    });
  });

  test("passes the owner/name slug and PR number through to gh pr diff", async () => {
    const seen: { slug?: string; pr?: number } = {};
    const classifier = createExecTriageClassifier({
      exec: fakeExec({
        diff: (slug, pr) => {
          seen.slug = slug;
          seen.pr = pr;
          return Promise.resolve("diff");
        },
        triageFloor: () => Promise.resolve({ code: 0, stdout: "T0" }),
      }),
    });
    await classifier.classify("itsHabib/ship", 7);
    expect(seen).toEqual({ pr: 7, slug: "itsHabib/ship" });
  });

  test("non-zero exit is a classifier error, not a tier", async () => {
    const classifier = createExecTriageClassifier({
      exec: fakeExec({
        diff: () => Promise.resolve("diff"),
        triageFloor: () => Promise.resolve({ code: 1, stdout: "" }),
      }),
    });
    expect(errorReason(await classifier.classify("o/r", 1))).toContain("exited 1");
  });

  test("unparseable stdout on exit 0 is a classifier error", async () => {
    const classifier = createExecTriageClassifier({
      exec: fakeExec({
        diff: () => Promise.resolve("diff"),
        triageFloor: () => Promise.resolve({ code: 0, stdout: "not a tier" }),
      }),
    });
    expect(errorReason(await classifier.classify("o/r", 1))).toContain("unparseable");
  });

  test("a gh pr diff failure is a classifier error", async () => {
    const classifier = createExecTriageClassifier({
      exec: fakeExec({
        diff: () => Promise.reject(new Error("gh not authenticated")),
        triageFloor: () => Promise.resolve({ code: 0, stdout: "T1" }),
      }),
    });
    expect(errorReason(await classifier.classify("o/r", 1))).toContain("gh pr diff failed");
  });

  test("a triage-floor spawn failure is a classifier error", async () => {
    const classifier = createExecTriageClassifier({
      exec: fakeExec({
        diff: () => Promise.resolve("diff"),
        triageFloor: () => Promise.reject(new Error("ENOENT")),
      }),
    });
    expect(errorReason(await classifier.classify("o/r", 1))).toContain("triage-floor failed");
  });
});

describe("createExecTriageClassifier (real spawn)", () => {
  test("a missing triage-floor binary yields a classifier error", async () => {
    const classifier = createExecTriageClassifier({
      triageFloorBin: MISSING_BIN,
      // Inject the diff so the test never shells out to a real gh.
      exec: fakeExec({ diff: () => Promise.resolve("--- a\n+++ b\n") }),
    });
    const outcome = await classifier.classify("itsHabib/ship", 1);
    expect(outcome.kind).toBe("error");
  });

  test("a missing gh binary yields a classifier error", async () => {
    const classifier = createExecTriageClassifier({
      ghBin: "gh-does-not-exist-xyz-123",
      // Never reached — the diff step fails first.
      exec: fakeExec({ triageFloor: () => Promise.resolve({ code: 0, stdout: "T1" }) }),
    });
    expect(errorReason(await classifier.classify("o/r", 1))).toContain("gh pr diff failed");
  });
});

// Cross-platform: drive `node` as the stdin-reading child so the spawn seam's
// success / non-zero-exit / timeout / ENOENT branches are covered without a
// bespoke binary on PATH.
describe("spawnWithStdin", () => {
  const echoStdin =
    "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{process.stdout.write(d)})";

  test("captures stdout and a zero exit code", async () => {
    const result: TriageFloorResult = await spawnWithStdin(
      execPath,
      ["-e", echoStdin],
      "T2\n",
      5000,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("T2\n");
  });

  test("reports a non-zero exit code", async () => {
    const result = await spawnWithStdin(execPath, ["-e", "process.exit(3)"], "x", 5000);
    expect(result.code).toBe(3);
  });

  test("rejects when the binary is missing", async () => {
    await expect(spawnWithStdin(MISSING_BIN, [], "x", 5000)).rejects.toThrow();
  });

  test("rejects when the child outlives the timeout", async () => {
    await expect(
      spawnWithStdin(execPath, ["-e", "setTimeout(()=>{}, 10000)"], "x", 50),
    ).rejects.toThrow(/timed out/);
  });
});

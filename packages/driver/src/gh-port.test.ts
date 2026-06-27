/** Default `gh` CLI adapter — arg-building, JSON parsing, rollup normalization. */

import { describe, expect, test } from "vitest";

import { createExecGhPort, type GhExec } from "./gh-port.js";

interface ExecCall {
  file: string;
  args: readonly string[];
}

/** Records every exec invocation and hands back a fixed stdout. */
function fakeExec(stdout = ""): { calls: ExecCall[]; exec: GhExec } {
  const calls: ExecCall[] = [];
  const exec: GhExec = (file, args) => {
    calls.push({ args, file });
    return Promise.resolve({ stdout });
  };
  return { calls, exec };
}

describe("createExecGhPort — mergePullRequest", () => {
  test("squash-merges and deletes the branch, without --admin by default", async () => {
    const { calls, exec } = fakeExec();
    const gh = createExecGhPort(exec);

    await gh.mergePullRequest("org/repo", 42);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      args: ["pr", "merge", "42", "--squash", "--delete-branch", "-R", "org/repo"],
      file: "gh",
    });
  });

  test("splices --admin before --delete-branch when opts.admin is true", async () => {
    const { calls, exec } = fakeExec();
    const gh = createExecGhPort(exec);

    await gh.mergePullRequest("org/repo", 7, { admin: true });

    expect(calls[0]?.args).toEqual([
      "pr",
      "merge",
      "7",
      "--squash",
      "--admin",
      "--delete-branch",
      "-R",
      "org/repo",
    ]);
  });

  test("opts.admin false keeps the default no-admin path", async () => {
    const { calls, exec } = fakeExec();
    const gh = createExecGhPort(exec);

    await gh.mergePullRequest("org/repo", 9, { admin: false });

    expect(calls[0]?.args).not.toContain("--admin");
  });

  test("normalizes a full github URL repo to OWNER/REPO for -R", async () => {
    const { calls, exec } = fakeExec();
    const gh = createExecGhPort(exec);

    await gh.mergePullRequest("https://github.com/itsHabib/ship", 1);

    expect(calls[0]?.args.slice(-2)).toEqual(["-R", "itsHabib/ship"]);
  });
});

describe("createExecGhPort — viewPullRequest", () => {
  test("parses state, mergeCommit, and mergedAt from gh JSON", async () => {
    const { calls, exec } = fakeExec(
      JSON.stringify({
        mergeCommit: { oid: "abc123" },
        mergedAt: "2026-06-19T12:00:00Z",
        state: "MERGED",
      }),
    );
    const gh = createExecGhPort(exec);

    const view = await gh.viewPullRequest("org/repo", 42);

    expect(view).toEqual({
      mergeCommit: { oid: "abc123" },
      mergedAt: "2026-06-19T12:00:00Z",
      state: "MERGED",
    });
    expect(calls[0]).toEqual({
      args: ["pr", "view", "42", "--json", "mergeCommit,mergedAt,state", "-R", "org/repo"],
      file: "gh",
    });
  });

  test("defaults missing mergeCommit and mergedAt to null", async () => {
    const { exec } = fakeExec(JSON.stringify({ state: "OPEN" }));
    const gh = createExecGhPort(exec);

    const view = await gh.viewPullRequest("org/repo", 5);

    expect(view).toEqual({ mergeCommit: null, mergedAt: null, state: "OPEN" });
  });
});

describe("createExecGhPort — fetchPrReadiness", () => {
  test("parses readiness facts and a check-run rollup node", async () => {
    const { calls, exec } = fakeExec(
      JSON.stringify({
        isDraft: false,
        mergeable: "MERGEABLE",
        state: "OPEN",
        statusCheckRollup: [{ conclusion: "SUCCESS", name: "ci", status: "COMPLETED" }],
      }),
    );
    const gh = createExecGhPort(exec);

    const readiness = await gh.fetchPrReadiness("org/repo", 42);

    expect(readiness).toEqual({
      checks: [{ conclusion: "SUCCESS", name: "ci", status: "COMPLETED" }],
      isDraft: false,
      mergeable: "MERGEABLE",
      state: "OPEN",
    });
    expect(calls[0]).toEqual({
      args: [
        "pr",
        "view",
        "42",
        "--json",
        "state,isDraft,mergeable,statusCheckRollup,reviews,commits",
        "-R",
        "org/repo",
      ],
      file: "gh",
    });
  });

  test("a check-run node with null conclusion normalizes to an empty conclusion", async () => {
    const { exec } = fakeExec(
      JSON.stringify({
        state: "OPEN",
        statusCheckRollup: [{ conclusion: null, name: "build", status: "IN_PROGRESS" }],
      }),
    );
    const gh = createExecGhPort(exec);

    const readiness = await gh.fetchPrReadiness("org/repo", 1);

    expect(readiness.checks).toEqual([{ conclusion: "", name: "build", status: "IN_PROGRESS" }]);
  });

  test("a legacy commit-status node with a terminal state folds to COMPLETED", async () => {
    const { exec } = fakeExec(
      JSON.stringify({
        state: "OPEN",
        statusCheckRollup: [{ context: "legacy/ci", state: "SUCCESS" }],
      }),
    );
    const gh = createExecGhPort(exec);

    const readiness = await gh.fetchPrReadiness("org/repo", 1);

    expect(readiness.checks).toEqual([
      { conclusion: "SUCCESS", name: "legacy/ci", status: "COMPLETED" },
    ]);
  });

  test.each(["PENDING", "EXPECTED"])(
    "a legacy commit-status node with state %s stays non-terminal",
    async (state) => {
      const { exec } = fakeExec(
        JSON.stringify({
          state: "OPEN",
          statusCheckRollup: [{ context: "legacy/ci", state }],
        }),
      );
      const gh = createExecGhPort(exec);

      const readiness = await gh.fetchPrReadiness("org/repo", 1);

      expect(readiness.checks).toEqual([{ conclusion: "", name: "legacy/ci", status: state }]);
    },
  );

  test("a commit-status node missing both status and state folds to an empty terminal check", async () => {
    const { exec } = fakeExec(
      JSON.stringify({
        state: "OPEN",
        statusCheckRollup: [{ context: "legacy/ci" }],
      }),
    );
    const gh = createExecGhPort(exec);

    const readiness = await gh.fetchPrReadiness("org/repo", 1);

    expect(readiness.checks).toEqual([{ conclusion: "", name: "legacy/ci", status: "COMPLETED" }]);
  });

  test("a node with neither name nor context is labeled (unnamed check)", async () => {
    const { exec } = fakeExec(
      JSON.stringify({
        state: "OPEN",
        statusCheckRollup: [{ conclusion: "SUCCESS", status: "COMPLETED" }],
      }),
    );
    const gh = createExecGhPort(exec);

    const readiness = await gh.fetchPrReadiness("org/repo", 1);

    expect(readiness.checks[0]?.name).toBe("(unnamed check)");
  });

  test("defaults missing isDraft to false, mergeable to UNKNOWN, and rollup to empty", async () => {
    const { exec } = fakeExec(JSON.stringify({ state: "OPEN" }));
    const gh = createExecGhPort(exec);

    const readiness = await gh.fetchPrReadiness("org/repo", 1);

    expect(readiness).toEqual({ checks: [], isDraft: false, mergeable: "UNKNOWN", state: "OPEN" });
  });

  test("passes through isDraft and a CONFLICTING mergeable", async () => {
    const { exec } = fakeExec(
      JSON.stringify({
        isDraft: true,
        mergeable: "CONFLICTING",
        state: "OPEN",
        statusCheckRollup: [],
      }),
    );
    const gh = createExecGhPort(exec);

    const readiness = await gh.fetchPrReadiness("org/repo", 1);

    expect(readiness.isDraft).toBe(true);
    expect(readiness.mergeable).toBe("CONFLICTING");
  });
});

describe("createExecGhPort — fetchPrMergeGateFacts", () => {
  test("parses reviews and head commit oid for merge-gate assembly", async () => {
    const { exec } = fakeExec(
      JSON.stringify({
        commits: [{ oid: "head123" }, { oid: "head456" }],
        isDraft: false,
        mergeable: "MERGEABLE",
        reviews: [
          { author: { login: "chatgpt-codex-connector[bot]" }, state: "APPROVED" },
          { author: { login: "claude-bot" }, state: "APPROVED" },
        ],
        state: "OPEN",
        statusCheckRollup: [{ conclusion: "NEUTRAL", name: "advisory", status: "COMPLETED" }],
      }),
    );
    const gh = createExecGhPort(exec);

    const facts = await gh.fetchPrMergeGateFacts("org/repo", 9);

    expect(facts.ciSha).toBe("head456");
    expect(facts.reviews).toEqual([
      { authorLogin: "chatgpt-codex-connector[bot]", state: "APPROVED" },
      { authorLogin: "claude-bot", state: "APPROVED" },
    ]);
    expect(facts.readiness.checks).toEqual([
      { conclusion: "NEUTRAL", name: "advisory", status: "COMPLETED" },
    ]);
  });
});

/**
 * Tests for `cloud-branch-reconstruct.ts` — the L3 reconstruction gate.
 * Pure functions + an injectable `gh` fake; no SDK, no host shell.
 */

import { describe, expect, test } from "vitest";

import type { BranchReconstructState, GhResult, GhRunner } from "./cloud-branch-reconstruct.js";
import type { CloudStreamEvent } from "./cloud-session.js";

import {
  branchNotFoundResult,
  buildDispatchPrompt,
  newBranchReconstructState,
  reconstructBranches,
  repoSlugFromUrl,
} from "./cloud-branch-reconstruct.js";

function ev(obj: Record<string, unknown>): CloudStreamEvent {
  return obj as unknown as CloudStreamEvent;
}

function toolUse(id: string, name: string): CloudStreamEvent {
  return ev({ id, type: "agent.mcp_tool_use", mcp_server_name: "github", name, input: {} });
}

function toolResult(useId: string, body: unknown, isError = false): CloudStreamEvent {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return ev({
    id: `res-${useId}`,
    type: "agent.mcp_tool_result",
    mcp_tool_use_id: useId,
    is_error: isError,
    content: [{ type: "text", text }],
  });
}

function feed(events: readonly CloudStreamEvent[]): BranchReconstructState {
  const state = newBranchReconstructState();
  for (const e of events) state.observe(e);
  return state;
}

function gh(routes: { prList?: GhResult; branch?: GhResult } = {}): GhRunner {
  return (args) => {
    if (args[0] === "pr" && args[1] === "list") {
      return Promise.resolve(routes.prList ?? { stdout: "[]", exitCode: 0 });
    }
    if (args[0] === "api") return Promise.resolve(routes.branch ?? { stdout: "", exitCode: 1 });
    return Promise.resolve({ stdout: "", exitCode: 1 });
  };
}

describe("BranchReconstructState — stream parse", () => {
  test("parses html_url + headRefName from the create_pull_request result", () => {
    const state = feed([
      toolUse("u1", "create_pull_request"),
      toolResult("u1", { html_url: "https://github.com/acme/test/pull/5", headRefName: "ship/x" }),
    ]);
    expect(state.result()).toEqual({
      prUrl: "https://github.com/acme/test/pull/5",
      branch: "ship/x",
    });
  });

  test("reads nested head.ref + url when headRefName/html_url absent", () => {
    const state = feed([
      toolUse("u1", "create_pull_request"),
      toolResult("u1", { url: "https://github.com/acme/test/pull/6", head: { ref: "ship/y" } }),
    ]);
    expect(state.result()).toEqual({
      prUrl: "https://github.com/acme/test/pull/6",
      branch: "ship/y",
    });
  });

  test("falls back to a PR-URL regex when the result is plain text", () => {
    const state = feed([
      toolUse("u1", "create_pull_request"),
      toolResult("u1", "Opened https://github.com/acme/test/pull/8 successfully"),
    ]);
    expect(state.result()).toEqual({ prUrl: "https://github.com/acme/test/pull/8" });
  });

  test("ignores tool uses that are not the PR-create tool", () => {
    const state = feed([
      toolUse("u1", "list_issues"),
      toolResult("u1", { html_url: "https://github.com/acme/test/pull/1" }),
    ]);
    expect(state.result()).toBeUndefined();
  });

  test("ignores a result whose mcp_tool_use_id does not match the PR-create use", () => {
    const state = feed([
      toolUse("u1", "create_pull_request"),
      toolResult("other", { html_url: "https://github.com/acme/test/pull/1" }),
    ]);
    expect(state.result()).toBeUndefined();
  });

  test("ignores an errored PR-create result (lets the fallback handle it)", () => {
    const state = feed([
      toolUse("u1", "create_pull_request"),
      toolResult("u1", { message: "permission denied" }, true),
    ]);
    expect(state.result()).toBeUndefined();
  });

  test("last successful PR-create wins (retry)", () => {
    const state = feed([
      toolUse("u1", "create_pull_request"),
      toolResult("u1", { html_url: "https://github.com/acme/test/pull/1", headRefName: "ship/x" }),
      toolUse("u2", "create_pull_request"),
      toolResult("u2", { html_url: "https://github.com/acme/test/pull/2", headRefName: "ship/x" }),
    ]);
    expect(state.result()?.prUrl).toBe("https://github.com/acme/test/pull/2");
  });
});

describe("reconstructBranches", () => {
  const repoUrl = "https://github.com/acme/test";
  const prBranch = "ship/x";

  test("PRIMARY: parsed PR url wins; gh is never consulted", async () => {
    const result = await reconstructBranches({
      parsed: { prUrl: "https://github.com/acme/test/pull/5", branch: "ship/x" },
      repoUrl,
      prBranch,
      gh: () => Promise.reject(new Error("gh must not run on a primary hit")),
    });
    expect(result).toEqual({
      repoUrl,
      branch: "ship/x",
      prUrl: "https://github.com/acme/test/pull/5",
    });
  });

  test("PRIMARY: branch defaults to prBranch when the parse omits the head ref", async () => {
    const result = await reconstructBranches({
      parsed: { prUrl: "https://github.com/acme/test/pull/5" },
      repoUrl,
      prBranch,
      gh: gh(),
    });
    expect(result).toEqual({
      repoUrl,
      branch: "ship/x",
      prUrl: "https://github.com/acme/test/pull/5",
    });
  });

  test("FALLBACK: gh pr list yields the PR when the stream had none", async () => {
    const result = await reconstructBranches({
      parsed: undefined,
      repoUrl,
      prBranch,
      gh: gh({
        prList: {
          stdout: JSON.stringify([
            { url: "https://github.com/acme/test/pull/9", headRefName: "ship/x" },
          ]),
          exitCode: 0,
        },
      }),
    });
    expect(result).toEqual({
      repoUrl,
      branch: "ship/x",
      prUrl: "https://github.com/acme/test/pull/9",
    });
  });

  test("FALLBACK: branch exists but no PR → branch without prUrl", async () => {
    const result = await reconstructBranches({
      parsed: undefined,
      repoUrl,
      prBranch,
      gh: gh({ prList: { stdout: "[]", exitCode: 0 }, branch: { stdout: "{}", exitCode: 0 } }),
    });
    expect(result).toEqual({ repoUrl, branch: "ship/x" });
  });

  test("NONE: no PR + no branch → undefined (→ branch-not-found)", async () => {
    const result = await reconstructBranches({ parsed: undefined, repoUrl, prBranch, gh: gh() });
    expect(result).toBeUndefined();
  });

  test("unparseable repo URL → undefined (no gh call possible)", async () => {
    const result = await reconstructBranches({
      parsed: undefined,
      repoUrl: "not a url",
      prBranch,
      gh: () => Promise.reject(new Error("gh must not run without a slug")),
    });
    expect(result).toBeUndefined();
  });
});

describe("repoSlugFromUrl", () => {
  test.each([
    ["https://github.com/acme/test", "acme/test"],
    ["https://github.com/acme/test.git", "acme/test"],
    ["https://github.com/acme/test/", "acme/test"],
    ["git@github.com:acme/test.git", "acme/test"],
  ])("%s → %s", (url, slug) => {
    expect(repoSlugFromUrl(url)).toBe(slug);
  });

  test("non-github URL → undefined", () => {
    expect(repoSlugFromUrl("https://example.com/x/y")).toBeUndefined();
  });
});

describe("buildDispatchPrompt", () => {
  test("no prBranch → base prompt unchanged (3a / cursor shape)", () => {
    expect(buildDispatchPrompt("do the work", { githubMcpAvailable: true })).toBe("do the work");
  });

  test("with prBranch + MCP → names the branch, base ref, and the MCP PR tool", () => {
    const out = buildDispatchPrompt("do the work", {
      prBranch: "ship/x",
      baseRef: "main",
      githubMcpAvailable: true,
    });
    expect(out).toContain("ship/x");
    expect(out).toContain("main");
    expect(out).toContain("create_pull_request");
    expect(out).toContain("github");
  });

  test("with prBranch, no MCP → still prescribes branch + PR, omits the MCP tool", () => {
    const out = buildDispatchPrompt("do the work", {
      prBranch: "ship/x",
      githubMcpAvailable: false,
    });
    expect(out).toContain("ship/x");
    expect(out).toContain("pull request");
    expect(out).not.toContain("create_pull_request");
    expect(out).toContain("default branch");
  });
});

describe("branchNotFoundResult", () => {
  test("failed shape with the logic category + the branch in the message", () => {
    const result = branchNotFoundResult("ship/x", 1234, [{ a: 1 }]);
    expect(result.status).toBe("failed");
    expect(result.failureCategory).toBe("logic");
    expect(result.sdkTerminalStatus).toBe("branch-not-found");
    expect(result.durationMs).toBe(1234);
    expect(result.errorMessage).toContain("ship/x");
    expect(result.branches).toEqual([]);
  });
});

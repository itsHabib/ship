// Smoke tests for the `open_pr` test helpers — the fake GhClient,
// fake GitRemote, and `createOpenPrServiceFromHarness` bundle. The
// helpers themselves are exercised exhaustively from
// `@ship/core/src/open-pr.test.ts`; this file pins their direct
// contracts so any future tweak shows up on the right blast radius.

import { describe, expect, test } from "vitest";

import { createHarness } from "./harness.js";
import {
  createFakeGhClient,
  createFakeGitRemote,
  createOpenPrServiceFromHarness,
} from "./open-pr.js";

describe("createFakeGhClient", () => {
  test("records calls in order with the same args the service passed", async () => {
    const gh = createFakeGhClient();
    await gh.listOpenPrsForBranch({ owner: "o", repo: "r", head: "h", base: "b" });
    await gh.createPr({
      owner: "o",
      repo: "r",
      base: "b",
      head: "h",
      title: "t",
      body: "x",
      draft: false,
    });
    expect(gh.calls).toHaveLength(2);
    expect(gh.calls[0]?.kind).toBe("listOpenPrsForBranch");
    expect(gh.calls[1]?.kind).toBe("createPr");
  });

  test("setOpenPrs seeds the listOpenPrsForBranch response", async () => {
    const gh = createFakeGhClient();
    gh.setOpenPrs([{ number: 7, url: "https://github.com/o/r/pull/7" }]);
    const result = await gh.listOpenPrsForBranch({
      owner: "o",
      repo: "r",
      head: "h",
      base: "b",
    });
    expect(result).toEqual([{ number: 7, url: "https://github.com/o/r/pull/7" }]);
  });

  test("setCreatedPr seeds the createPr response", async () => {
    const gh = createFakeGhClient();
    gh.setCreatedPr({ number: 99, url: "https://github.com/o/r/pull/99" });
    const out = await gh.createPr({
      owner: "o",
      repo: "r",
      base: "b",
      head: "h",
      title: "t",
      body: "x",
      draft: false,
    });
    expect(out).toEqual({ number: 99, url: "https://github.com/o/r/pull/99" });
  });

  test("setCreateError throws once then resets to default", async () => {
    const gh = createFakeGhClient();
    gh.setCreateError(new Error("boom"));
    await expect(
      gh.createPr({
        owner: "o",
        repo: "r",
        base: "b",
        head: "h",
        title: "t",
        body: "x",
        draft: false,
      }),
    ).rejects.toThrow(/boom/);
    // Second call must resolve cleanly — the seeded error is consumed.
    await expect(
      gh.createPr({
        owner: "o",
        repo: "r",
        base: "b",
        head: "h",
        title: "t",
        body: "x",
        draft: false,
      }),
    ).resolves.toBeDefined();
  });
});

describe("createFakeGitRemote", () => {
  test("readConfig defaults to null and reflects setConfigValue", async () => {
    const git = createFakeGitRemote();
    expect(await git.readConfig({ workdir: "/w", key: "k" })).toBeNull();
    git.setConfigValue("v");
    expect(await git.readConfig({ workdir: "/w", key: "k" })).toBe("v");
  });

  test("readDefaultBranch defaults to main; setDefaultBranch(Error) rejects", async () => {
    const git = createFakeGitRemote();
    expect(await git.readDefaultBranch({ workdir: "/w" })).toBe("main");
    git.setDefaultBranch(new Error("no remote"));
    await expect(git.readDefaultBranch({ workdir: "/w" })).rejects.toThrow(/no remote/);
  });

  test("readCurrentBranch / setCurrentBranch round-trip", async () => {
    const git = createFakeGitRemote();
    expect(await git.readCurrentBranch({ workdir: "/w" })).toBeNull();
    git.setCurrentBranch("feat/x");
    expect(await git.readCurrentBranch({ workdir: "/w" })).toBe("feat/x");
  });

  test("readOriginRepo defaults to test/test; setOriginRepo(null) returns null", async () => {
    const git = createFakeGitRemote();
    expect(await git.readOriginRepo({ workdir: "/w" })).toEqual({
      owner: "test",
      repo: "test",
    });
    git.setOriginRepo(null);
    expect(await git.readOriginRepo({ workdir: "/w" })).toBeNull();
  });

  test("listCommitSubjects honors setCommitSubjects", async () => {
    const git = createFakeGitRemote();
    git.setCommitSubjects(["a", "b"]);
    expect(await git.listCommitSubjects({ workdir: "/w", head: "h", base: "b" })).toEqual([
      "a",
      "b",
    ]);
  });

  test("pushBranch resolves by default; setPushError makes it reject", async () => {
    const git = createFakeGitRemote();
    await expect(git.pushBranch({ workdir: "/w", branch: "x" })).resolves.toBeUndefined();
    git.setPushError(new Error("push denied"));
    await expect(git.pushBranch({ workdir: "/w", branch: "x" })).rejects.toThrow(/push denied/);
  });
});

describe("createOpenPrServiceFromHarness", () => {
  test("wires the harness store + fake gh + fake git into a working OpenPrService", () => {
    const h = createHarness();
    const bundle = createOpenPrServiceFromHarness(h);
    expect(typeof bundle.service.openPr).toBe("function");
    expect(bundle.gh.calls).toEqual([]);
    expect(bundle.git.calls).toEqual([]);
    h.close();
  });
});

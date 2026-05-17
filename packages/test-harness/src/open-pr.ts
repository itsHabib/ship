// Test helpers for the `open_pr` phase. Pairs a `Harness` (shared
// with the `ShipService` test bundle) with stub `GhClient` +
// `GitRemote` impls so unit / scenario tests can exercise
// `OpenPrService` without hitting GitHub or shelling out to git.

import type { GhClient, GhPrRef, GitRemote, OpenPrService } from "@ship/core";

import { createMemoryShipFs, createOpenPrService, type MemoryShipFs } from "@ship/core";

import type { Harness } from "./harness.js";

/** Recorded call to a `FakeGhClient` method — surfaces args + ordering for assertions. */
export type FakeGhCall =
  | {
      readonly kind: "listOpenPrsForBranch";
      readonly owner: string;
      readonly repo: string;
      readonly head: string;
      readonly base: string;
    }
  | {
      readonly kind: "createPr";
      readonly owner: string;
      readonly repo: string;
      readonly head: string;
      readonly base: string;
      readonly title: string;
      readonly body: string;
      readonly draft: boolean;
    };

/** `GhClient` stub with assertion-friendly call log. */
export interface FakeGhClient extends GhClient {
  readonly calls: readonly FakeGhCall[];
  // Pre-seed: what `listOpenPrsForBranch` returns. Default `[]`.
  setOpenPrs(prs: GhPrRef[]): void;
  // Pre-seed: what `createPr` returns. Default
  // `{ number: 1, url: "https://github.com/test/test/pull/1" }`.
  setCreatedPr(pr: GhPrRef): void;
  // Pre-seed an error to throw from `createPr` once (consumed on use).
  // Default: no error.
  setCreateError(err: Error | null): void;
}

export function createFakeGhClient(): FakeGhClient {
  const calls: FakeGhCall[] = [];
  let openPrs: GhPrRef[] = [];
  let createdPr: GhPrRef = { number: 1, url: "https://github.com/test/test/pull/1" };
  let createError: Error | null = null;
  return {
    calls,
    setOpenPrs: (prs) => {
      openPrs = prs.slice();
    },
    setCreatedPr: (pr) => {
      createdPr = pr;
    },
    setCreateError: (err) => {
      createError = err;
    },
    listOpenPrsForBranch: ({ owner, repo, head, base }) => {
      calls.push({ kind: "listOpenPrsForBranch", owner, repo, head, base });
      return Promise.resolve(openPrs.slice());
    },
    createPr: ({ owner, repo, head, base, title, body, draft }) => {
      calls.push({ kind: "createPr", owner, repo, head, base, title, body, draft });
      if (createError !== null) {
        const e = createError;
        createError = null;
        return Promise.reject(e);
      }
      return Promise.resolve(createdPr);
    },
  };
}

/** Recorded call to a `FakeGitRemote` method. */
export type FakeGitCall =
  | { readonly kind: "readConfig"; readonly workdir: string; readonly key: string }
  | { readonly kind: "readDefaultBranch"; readonly workdir: string }
  | { readonly kind: "readCurrentBranch"; readonly workdir: string }
  | { readonly kind: "readOriginRepo"; readonly workdir: string }
  | {
      readonly kind: "listCommitSubjects";
      readonly workdir: string;
      readonly head: string;
      readonly base: string;
    }
  | { readonly kind: "pushBranch"; readonly workdir: string; readonly branch: string };

/**
 * `GitRemote` stub with assertion-friendly call log + per-method seeds.
 *
 * `setOriginRepo` accepts three shapes:
 * - `{ owner, repo }` — happy path, fake returns `{ slug: ..., rawUrl }`.
 * - `null` — `git remote get-url origin` itself failed (no remote, no
 *   repo); the fake returns `null` directly.
 * - `{ rawUrl }` — the URL was returned but unparseable; the fake
 *   returns `{ slug: null, rawUrl }`.
 */
export interface FakeGitRemote extends GitRemote {
  readonly calls: readonly FakeGitCall[];
  setConfigValue(value: string | null): void;
  setDefaultBranch(branch: string | Error): void;
  setCurrentBranch(branch: string | null): void;
  setOriginRepo(value: { owner: string; repo: string } | { rawUrl: string } | null): void;
  setCommitSubjects(subjects: string[]): void;
  setPushError(err: Error | null): void;
}

type FakeOriginSeed = { owner: string; repo: string } | { rawUrl: string } | null;

export function createFakeGitRemote(): FakeGitRemote {
  const calls: FakeGitCall[] = [];
  let configValue: string | null = null;
  let defaultBranch: string | Error = "main";
  let currentBranch: string | null = null;
  let originSeed: FakeOriginSeed = { owner: "test", repo: "test" };
  let commitSubjects: string[] = ["initial commit on feature branch"];
  let pushError: Error | null = null;
  return {
    calls,
    setConfigValue: (v) => {
      configValue = v;
    },
    setDefaultBranch: (b) => {
      defaultBranch = b;
    },
    setCurrentBranch: (b) => {
      currentBranch = b;
    },
    setOriginRepo: (s) => {
      originSeed = s;
    },
    setCommitSubjects: (s) => {
      commitSubjects = s.slice();
    },
    setPushError: (e) => {
      pushError = e;
    },
    readConfig: ({ workdir, key }) => {
      calls.push({ kind: "readConfig", workdir, key });
      return Promise.resolve(configValue);
    },
    readDefaultBranch: ({ workdir }) => {
      calls.push({ kind: "readDefaultBranch", workdir });
      return defaultBranch instanceof Error
        ? Promise.reject(defaultBranch)
        : Promise.resolve(defaultBranch);
    },
    readCurrentBranch: ({ workdir }) => {
      calls.push({ kind: "readCurrentBranch", workdir });
      return Promise.resolve(currentBranch);
    },
    readOriginRepo: ({ workdir }) => {
      calls.push({ kind: "readOriginRepo", workdir });
      if (originSeed === null) return Promise.resolve(null);
      if ("rawUrl" in originSeed) {
        return Promise.resolve({ slug: null, rawUrl: originSeed.rawUrl });
      }
      return Promise.resolve({
        slug: originSeed,
        rawUrl: `https://github.com/${originSeed.owner}/${originSeed.repo}.git`,
      });
    },
    listCommitSubjects: ({ workdir, head, base }) => {
      calls.push({ kind: "listCommitSubjects", workdir, head, base });
      return Promise.resolve(commitSubjects.slice());
    },
    pushBranch: ({ workdir, branch }) => {
      calls.push({ kind: "pushBranch", workdir, branch });
      return pushError === null ? Promise.resolve() : Promise.reject(pushError);
    },
  };
}

/** Bundle returned by `createOpenPrServiceFromHarness`. */
export interface OpenPrServiceBundle {
  readonly service: OpenPrService;
  readonly fs: MemoryShipFs;
  readonly gh: FakeGhClient;
  readonly git: FakeGitRemote;
}

/**
 * Wires a `Harness` (store + clock + ids + active-runs) with a fresh
 * memory FS, a `FakeGhClient`, and a `FakeGitRemote` into an
 * `OpenPrService`. Mirrors `createServiceFromHarness` for `ShipService`.
 */
export function createOpenPrServiceFromHarness(h: Harness): OpenPrServiceBundle {
  const fs = createMemoryShipFs();
  const gh = createFakeGhClient();
  const git = createFakeGitRemote();
  const service = createOpenPrService({
    store: h.store,
    fs,
    clock: h.clock,
    gh,
    git,
    ids: { phase: h.ids.phase },
  });
  return { service, fs, gh, git };
}

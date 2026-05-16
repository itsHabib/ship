// Unit tests for `OpenPrService`. Pairs the harness-backed store +
// clock + ids with the FakeGhClient / FakeGitRemote shipped by
// `@ship/test-harness`. Covers the explicit Validation § scenarios
// from docs/features/ship-v2/phases/02-open-pr.md.

import type { CreateWorkflowRunInput, Store } from "@ship/store";
import type { OpenPrServiceBundle } from "@ship/test-harness";
import type { WorkflowRun } from "@ship/workflow";

import { WorkflowRunNotFoundError } from "@ship/store";
import {
  createHarness,
  createOpenPrServiceFromHarness,
  createSampleAppendPhaseInput,
  createSampleWorkflowRunInput,
  type Harness,
} from "@ship/test-harness";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  BaseBranchUnresolvedError,
  BranchPushFailedError,
  EmptyBranchError,
  GhCreatePrFailedError,
  ImplementPhaseNotSucceededError,
  OriginHeadUnsetError,
  OriginRepoUnresolvedError,
  WorkdirNotGitError,
} from "./errors.js";

const WORKDIR = "/repo/.worktrees/sample-task";
const HEAD = "tower/sample-task";

let h: Harness;
let b: OpenPrServiceBundle;

beforeEach(async () => {
  h = createHarness();
  b = createOpenPrServiceFromHarness(h);
  // Default workdir setup: `.git` exists, docs/ exists, default base
  // is `main`. The memory fs requires parents to exist before
  // writeFile — pre-mkdir keeps the doc-derivation tests terse.
  await b.fs.mkdir(`${WORKDIR}/.git`, { recursive: true });
  await b.fs.mkdir(`${WORKDIR}/docs`, { recursive: true });
});

afterEach(() => {
  h.close();
});

interface SeedOpts {
  readonly implementStatus?: "succeeded" | "failed" | "cancelled" | "running";
  readonly branch?: string;
  readonly docPath?: string;
}

function seedRun(opts: SeedOpts = {}): WorkflowRun {
  const workflowRunId = h.ids.workflowRun();
  const input: CreateWorkflowRunInput = createSampleWorkflowRunInput(workflowRunId, {
    worktree: {
      repo: "ship",
      name: "sample-task",
      branch: opts.branch ?? HEAD,
      path: WORKDIR,
      baseRef: "main",
    },
    docPath: opts.docPath ?? "docs/sample.md",
  });
  h.store.createWorkflowRun(input);
  const phaseId = h.ids.phase();
  h.store.appendPhase(createSampleAppendPhaseInput(phaseId, workflowRunId, { kind: "implement" }));
  const status = opts.implementStatus ?? "succeeded";
  h.store.updatePhase(phaseId, { status, endedAt: h.clock() });
  const updated = h.store.getRun(workflowRunId);
  if (updated === null) throw new Error("seed produced no run");
  return updated;
}

describe("openPr — happy path + idempotency (Validation §)", () => {
  test("happy path: pushes, opens PR, writes succeeded phase, returns alreadyExisted=false", async () => {
    const run = seedRun();
    const out = await b.service.openPr({ workflowRunId: run.id });

    expect(out.status).toBe("succeeded");
    expect(out.alreadyExisted).toBe(false);
    expect(out.prNumber).toBe(1);
    expect(out.head).toBe(HEAD);
    expect(out.base).toBe("main");
    // One push, one create — no second invocation slipping in.
    expect(b.git.calls.filter((c) => c.kind === "pushBranch")).toHaveLength(1);
    expect(b.gh.calls.filter((c) => c.kind === "createPr")).toHaveLength(1);
    expect(b.gh.calls.filter((c) => c.kind === "listOpenPrsForBranch")).toHaveLength(1);

    const persisted = h.store.getRun(run.id);
    const openPrPhase = persisted?.phases.find((p) => p.kind === "open_pr");
    expect(openPrPhase?.status).toBe("succeeded");
    expect(openPrPhase?.outputJson).toBeDefined();
    const parsed = JSON.parse(openPrPhase?.outputJson ?? "{}") as {
      prUrl: string;
      alreadyExisted: boolean;
    };
    expect(parsed.alreadyExisted).toBe(false);
    expect(parsed.prUrl).toMatch(/\/pull\/1/);
  });

  test("idempotent re-open: existing PR → alreadyExisted=true, no push or create", async () => {
    const run = seedRun();
    b.gh.setOpenPrs([{ number: 42, url: "https://github.com/x/y/pull/42" }]);

    const out = await b.service.openPr({ workflowRunId: run.id });

    expect(out.alreadyExisted).toBe(true);
    expect(out.prNumber).toBe(42);
    expect(b.git.calls.filter((c) => c.kind === "pushBranch")).toHaveLength(0);
    expect(b.gh.calls.filter((c) => c.kind === "createPr")).toHaveLength(0);
  });

  test("idempotency-before-empty-branch ordering — cherry-picked branch with existing PR resolves", async () => {
    // The realistic regression: branch is now empty against base
    // (commits cherry-picked in), but the original PR is still open.
    // Inverting the order would throw EmptyBranchError; F5 says we
    // must return the existing PR.
    const run = seedRun();
    b.git.setCommitSubjects([]);
    b.gh.setOpenPrs([{ number: 7, url: "https://github.com/x/y/pull/7" }]);

    const out = await b.service.openPr({ workflowRunId: run.id });

    expect(out.alreadyExisted).toBe(true);
    expect(out.prNumber).toBe(7);
    // The empty-branch check is short-circuited — we never even call
    // listCommitSubjects.
    expect(b.git.calls.filter((c) => c.kind === "listCommitSubjects")).toHaveLength(0);
  });
});

describe("openPr — preconditions (no phase row created on failure)", () => {
  function openPrPhaseCount(store: Store, workflowRunId: string): number {
    const r = store.getRun(workflowRunId);
    return r?.phases.filter((p) => p.kind === "open_pr").length ?? 0;
  }

  test("run-not-found → WorkflowRunNotFoundError, no phase created", async () => {
    await expect(
      b.service.openPr({ workflowRunId: "wf_01ARZ3NDEKTSV4RRFFQ69G5FAV" }),
    ).rejects.toBeInstanceOf(WorkflowRunNotFoundError);
  });

  test("implement-not-succeeded → ImplementPhaseNotSucceededError, no phase created", async () => {
    const run = seedRun({ implementStatus: "failed" });
    await expect(b.service.openPr({ workflowRunId: run.id })).rejects.toBeInstanceOf(
      ImplementPhaseNotSucceededError,
    );
    expect(openPrPhaseCount(h.store, run.id)).toBe(0);
  });

  test("workdir-not-git → WorkdirNotGitError, no phase created", async () => {
    const run = seedRun();
    // Reset fs so `.git` no longer exists.
    h.close();
    h = createHarness();
    b = createOpenPrServiceFromHarness(h);
    h.store.createWorkflowRun(
      createSampleWorkflowRunInput(run.id, {
        worktree: {
          repo: "ship",
          name: "sample-task",
          branch: HEAD,
          path: WORKDIR,
          baseRef: "main",
        },
      }),
    );
    const phaseId = h.ids.phase();
    h.store.appendPhase(createSampleAppendPhaseInput(phaseId, run.id, { kind: "implement" }));
    h.store.updatePhase(phaseId, { status: "succeeded", endedAt: h.clock() });

    await expect(b.service.openPr({ workflowRunId: run.id })).rejects.toBeInstanceOf(
      WorkdirNotGitError,
    );
    expect(openPrPhaseCount(h.store, run.id)).toBe(0);
  });

  test("empty branch (no existing PR) → EmptyBranchError, no phase created", async () => {
    const run = seedRun();
    b.git.setCommitSubjects([]);
    await expect(b.service.openPr({ workflowRunId: run.id })).rejects.toBeInstanceOf(
      EmptyBranchError,
    );
    expect(openPrPhaseCount(h.store, run.id)).toBe(0);
  });

  test("base-branch unresolvable → BaseBranchUnresolvedError, no phase created", async () => {
    const run = seedRun();
    b.git.setConfigValue(null);
    b.git.setDefaultBranch(new OriginHeadUnsetError(WORKDIR));
    await expect(b.service.openPr({ workflowRunId: run.id })).rejects.toBeInstanceOf(
      BaseBranchUnresolvedError,
    );
    expect(openPrPhaseCount(h.store, run.id)).toBe(0);
  });

  test("origin remote unparseable → OriginRepoUnresolvedError, no phase created", async () => {
    const run = seedRun();
    b.git.setOriginRepo(null);
    await expect(b.service.openPr({ workflowRunId: run.id })).rejects.toBeInstanceOf(
      OriginRepoUnresolvedError,
    );
    expect(openPrPhaseCount(h.store, run.id)).toBe(0);
  });

  test("origin URL present but unparseable → OriginRepoUnresolvedError quotes the URL", async () => {
    const run = seedRun();
    b.git.setOriginRepo({ rawUrl: "ftp://example.com/owner/repo" });
    await expect(b.service.openPr({ workflowRunId: run.id })).rejects.toThrow(
      /ftp:\/\/example\.com\/owner\/repo/,
    );
    expect(openPrPhaseCount(h.store, run.id)).toBe(0);
  });
});

describe("openPr — base-branch resolution order (Validation §)", () => {
  test("input.base wins over both GitRemote reads", async () => {
    const run = seedRun();
    b.git.setConfigValue("release/v2");
    b.git.setDefaultBranch("main");
    const out = await b.service.openPr({ workflowRunId: run.id, base: "develop" });
    expect(out.base).toBe("develop");
    // Neither readConfig nor readDefaultBranch should have been called.
    expect(b.git.calls.some((c) => c.kind === "readConfig")).toBe(false);
    expect(b.git.calls.some((c) => c.kind === "readDefaultBranch")).toBe(false);
  });

  test("gh-merge-base config wins over default branch when input.base absent", async () => {
    const run = seedRun();
    b.git.setConfigValue("release/v2");
    b.git.setDefaultBranch("main");
    const out = await b.service.openPr({ workflowRunId: run.id });
    expect(out.base).toBe("release/v2");
    expect(b.git.calls.some((c) => c.kind === "readDefaultBranch")).toBe(false);
  });

  test("default branch is the final fallback when config is unset", async () => {
    const run = seedRun();
    b.git.setConfigValue(null);
    b.git.setDefaultBranch("main");
    const out = await b.service.openPr({ workflowRunId: run.id });
    expect(out.base).toBe("main");
  });
});

describe("openPr — failure paths", () => {
  test("push failure → phase row transitions running → failed; throws", async () => {
    const run = seedRun();
    b.git.setPushError(new BranchPushFailedError(HEAD, "permission denied"));

    await expect(b.service.openPr({ workflowRunId: run.id })).rejects.toBeInstanceOf(
      BranchPushFailedError,
    );

    const persisted = h.store.getRun(run.id);
    const openPrPhase = persisted?.phases.find((p) => p.kind === "open_pr");
    expect(openPrPhase?.status).toBe("failed");
    expect(openPrPhase?.errorMessage).toMatch(/permission denied/);
  });

  test("create failure → phase row transitions running → failed; throws", async () => {
    const run = seedRun();
    b.gh.setCreateError(new GhCreatePrFailedError("rate limited"));

    await expect(b.service.openPr({ workflowRunId: run.id })).rejects.toBeInstanceOf(
      GhCreatePrFailedError,
    );

    const persisted = h.store.getRun(run.id);
    expect(persisted?.phases.find((p) => p.kind === "open_pr")?.status).toBe("failed");
  });
});

describe("openPr — cancellation registers + clears activeRuns (ED-8)", () => {
  test("clears activeRuns on success (single workflowRunId)", async () => {
    const run = seedRun();
    await b.service.openPr({ workflowRunId: run.id });
    // Re-call must not throw "still active" — the registry was cleared.
    await expect(b.service.openPr({ workflowRunId: run.id })).resolves.toBeDefined();
  });

  test("clears activeRuns on failure path so a retry isn't blocked", async () => {
    const run = seedRun();
    b.git.setPushError(new BranchPushFailedError(HEAD, "first attempt"));
    await expect(b.service.openPr({ workflowRunId: run.id })).rejects.toBeInstanceOf(
      BranchPushFailedError,
    );
    // Reset the push error; retry must succeed without "still active".
    b.git.setPushError(null);
    const out = await b.service.openPr({ workflowRunId: run.id });
    expect(out.status).toBe("succeeded");
  });
});

describe("openPr — title/body derivation (ED-5)", () => {
  test("derives title from doc H1 with conventional-commit prefix verbatim", async () => {
    const run = seedRun({ docPath: "docs/task.md" });
    await b.fs.writeFile(`${WORKDIR}/docs/task.md`, "# fix: handle empty branch\n\nbody");
    await b.service.openPr({ workflowRunId: run.id });
    const createCall = b.gh.calls.find((c) => c.kind === "createPr");
    expect(createCall && "title" in createCall ? createCall.title : "").toBe(
      "fix: handle empty branch",
    );
  });

  test("infers fix: prefix from fix/ branch when H1 has no CC prefix", async () => {
    const run = seedRun({ docPath: "docs/task.md", branch: "fix/empty-branch" });
    await b.fs.writeFile(`${WORKDIR}/docs/task.md`, "# Empty branch handling\n");
    await b.service.openPr({ workflowRunId: run.id });
    const createCall = b.gh.calls.find((c) => c.kind === "createPr");
    expect(createCall && "title" in createCall ? createCall.title : "").toBe(
      "fix: Empty branch handling",
    );
  });

  test("falls back to feat: prefix on a tower/ branch", async () => {
    const run = seedRun({ docPath: "docs/task.md", branch: "tower/new-thing" });
    await b.fs.writeFile(`${WORKDIR}/docs/task.md`, "# Add new thing\n");
    await b.service.openPr({ workflowRunId: run.id });
    const createCall = b.gh.calls.find((c) => c.kind === "createPr");
    expect(createCall && "title" in createCall ? createCall.title : "").toBe("feat: Add new thing");
  });

  test("doc has no H1 → branch-name fallback with CC inference", async () => {
    const run = seedRun({ docPath: "docs/task.md", branch: "fix/no-h1" });
    await b.fs.writeFile(`${WORKDIR}/docs/task.md`, "no h1 here\nbody\n");
    await b.service.openPr({ workflowRunId: run.id });
    const createCall = b.gh.calls.find((c) => c.kind === "createPr");
    expect(createCall && "title" in createCall ? createCall.title : "").toBe("fix: no h1");
  });

  test("explicit input.title bypasses doc derivation entirely", async () => {
    const run = seedRun();
    await b.service.openPr({ workflowRunId: run.id, title: "custom title" });
    const createCall = b.gh.calls.find((c) => c.kind === "createPr");
    expect(createCall && "title" in createCall ? createCall.title : "").toBe("custom title");
  });

  test("body derivation puts each commit subject on its own bullet", async () => {
    const run = seedRun();
    b.git.setCommitSubjects(["first commit", "second commit"]);
    await b.service.openPr({ workflowRunId: run.id });
    const createCall = b.gh.calls.find((c) => c.kind === "createPr");
    const body = createCall && "body" in createCall ? createCall.body : "";
    expect(body).toMatch(/- first commit/);
    expect(body).toMatch(/- second commit/);
  });

  test("explicit input.body bypasses derivation", async () => {
    const run = seedRun();
    await b.service.openPr({ workflowRunId: run.id, body: "explicit body" });
    const createCall = b.gh.calls.find((c) => c.kind === "createPr");
    expect(createCall && "body" in createCall ? createCall.body : "").toBe("explicit body");
  });
});

describe("openPr — branch resolution from (unknown)", () => {
  test("recorded branch is (unknown) → falls back to git.readCurrentBranch", async () => {
    const run = seedRun({ branch: "(unknown)" });
    b.git.setCurrentBranch("fix/recovered");
    const out = await b.service.openPr({ workflowRunId: run.id });
    expect(out.head).toBe("fix/recovered");
  });

  test("recorded (unknown) + git.readCurrentBranch returns null → EmptyBranchError", async () => {
    const run = seedRun({ branch: "(unknown)" });
    b.git.setCurrentBranch(null);
    await expect(b.service.openPr({ workflowRunId: run.id })).rejects.toBeInstanceOf(
      EmptyBranchError,
    );
  });
});

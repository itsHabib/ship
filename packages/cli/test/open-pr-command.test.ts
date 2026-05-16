// `ship open-pr` argv → service → stdout / exit-code plumbing.

import type { CreateWorkflowRunInput } from "@ship/store";
import type { FakeGhCall } from "@ship/test-harness";

import { createSampleAppendPhaseInput, createSampleWorkflowRunInput } from "@ship/test-harness";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { CliHarness } from "./cli-harness.js";

import { createCliHarness, runArgv } from "./cli-harness.js";

type CreatePrCall = Extract<FakeGhCall, { kind: "createPr" }>;
const isCreatePr = (c: FakeGhCall): c is CreatePrCall => c.kind === "createPr";

const WORKDIR = "/work/wt/feat";
const BRANCH = "tower/sample";

let h: CliHarness;
let WF_ID: string;

beforeEach(async () => {
  h = await createCliHarness();
  WF_ID = h.harness.ids.workflowRun();
  const input: CreateWorkflowRunInput = createSampleWorkflowRunInput(WF_ID, {
    worktree: {
      repo: "ship",
      name: "sample",
      branch: BRANCH,
      path: WORKDIR,
      baseRef: "main",
    },
  });
  h.harness.store.createWorkflowRun(input);
  const phaseId = h.harness.ids.phase();
  h.harness.store.appendPhase(createSampleAppendPhaseInput(phaseId, WF_ID, { kind: "implement" }));
  h.harness.store.updatePhase(phaseId, { status: "succeeded", endedAt: h.harness.clock() });
  await h.openPrBundle.fs.mkdir(`${WORKDIR}/.git`, { recursive: true });
});

afterEach(() => {
  h.close();
});

describe("ship open-pr", () => {
  test("happy path: argv → service.openPr → exit 0; pretty stdout includes prUrl", async () => {
    const { code } = await runArgv(h.program, ["open-pr", WF_ID]);
    expect(code).toBe(0);
    const out = h.stdout.join("");
    expect(out).toContain("status:        succeeded");
    expect(out).toContain("prUrl:");
    expect(out).toContain("alreadyExisted: false");
  });

  test("--json emits parseable OpenPrOutput on stdout", async () => {
    const { code } = await runArgv(h.program, ["open-pr", WF_ID, "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(h.stdout.join("").trim()) as { status: string; prNumber: number };
    expect(parsed.status).toBe("succeeded");
    expect(parsed.prNumber).toBe(1);
  });

  test("--draft passes through to the service", async () => {
    await runArgv(h.program, ["open-pr", WF_ID, "--draft"]);
    const createCall = h.gh.calls.find(isCreatePr);
    expect(createCall?.draft).toBe(true);
  });

  test("--base / --title / --body override the derived values", async () => {
    await runArgv(h.program, [
      "open-pr",
      WF_ID,
      "--base",
      "release",
      "--title",
      "feat: explicit",
      "--body",
      "explicit body",
    ]);
    const createCall = h.gh.calls.find(isCreatePr);
    if (createCall === undefined) throw new Error("expected createPr call");
    expect(createCall.base).toBe("release");
    expect(createCall.title).toBe("feat: explicit");
    expect(createCall.body).toBe("explicit body");
  });

  test("WorkflowRunNotFoundError → exit 1, stderr names the bad id", async () => {
    const { code } = await runArgv(h.program, ["open-pr", "wf_01ARZ3NDEKTSV4RRFFQ69G5FAV"]);
    expect(code).toBe(1);
    expect(h.stderr.join("")).toMatch(/workflow run not found/i);
  });

  test("missing positional argument → exit 1", async () => {
    const { code } = await runArgv(h.program, ["open-pr"]);
    expect(code).toBe(1);
  });
});

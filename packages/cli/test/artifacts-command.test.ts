/** Argv → service.listArtifacts/downloadArtifact plumbing for `ship artifacts`. */

import { FakeCursorRunner } from "@ship/cursor-runner/test/fake";
import { afterEach, beforeEach, expect, test } from "vitest";

import type { CliHarness } from "./cli-harness.js";

import { createCliHarness, runArgv, TEST_WORKDIR } from "./cli-harness.js";

const ARTIFACT = { path: "out/report.txt", sizeBytes: 14, updatedAt: "2026-05-29T00:00:00.000Z" };

let h: CliHarness;
let cloudCursor: FakeCursorRunner;

beforeEach(async () => {
  cloudCursor = new FakeCursorRunner();
  h = await createCliHarness({ cloudCursor });
});

afterEach(() => {
  h.close();
});

// Runs a cloud ship that produces ARTIFACT (manifest + bytes), returns the wf id.
async function shipWithArtifact(): Promise<string> {
  cloudCursor.enqueue({
    events: [],
    result: { status: "succeeded", durationMs: 1, branches: [], artifacts: [ARTIFACT] },
    artifactBytes: { [ARTIFACT.path]: Buffer.from("hello, report!") },
  });
  const out = await h.service.ship({
    workdir: TEST_WORKDIR,
    repo: "ship",
    docPath: "docs.md",
    runtime: "cloud",
    cloud: { repos: [{ url: "https://github.com/acme/repo" }] },
  });
  return out.workflowRunId;
}

test("artifacts list renders a table of persisted refs", async () => {
  const wf = await shipWithArtifact();
  h.stdout.length = 0;
  const { code } = await runArgv(h.program, ["artifacts", "list", wf]);
  expect(code).toBe(0);
  const printed = h.stdout.join("");
  expect(printed).toContain("PATH");
  expect(printed).toContain(ARTIFACT.path);
});

test("artifacts list --json emits { artifacts: [...] }", async () => {
  const wf = await shipWithArtifact();
  h.stdout.length = 0;
  await runArgv(h.program, ["artifacts", "list", wf, "--json"]);
  const parsed = JSON.parse(h.stdout.join("").trim()) as { artifacts: unknown[] };
  expect(parsed.artifacts).toHaveLength(1);
});

test("artifacts list of a run with no artifacts prints (no artifacts)", async () => {
  cloudCursor.enqueue({
    events: [],
    result: { status: "succeeded", durationMs: 1, branches: [], artifacts: [] },
  });
  const out = await h.service.ship({
    workdir: TEST_WORKDIR,
    repo: "ship",
    docPath: "docs.md",
    runtime: "cloud",
    cloud: { repos: [{ url: "https://github.com/acme/repo" }] },
  });
  h.stdout.length = 0;
  const { code } = await runArgv(h.program, ["artifacts", "list", out.workflowRunId]);
  expect(code).toBe(0);
  expect(h.stdout.join("")).toContain("(no artifacts)");
});

test("artifacts list of a missing run exits non-zero with a message", async () => {
  const { code } = await runArgv(h.program, ["artifacts", "list", "wf_does_not_exist"]);
  expect(code).toBeGreaterThan(0);
  expect(h.stderr.join("").length).toBeGreaterThan(0);
});

test("artifacts download writes bytes and prints the local path", async () => {
  const wf = await shipWithArtifact();
  h.stdout.length = 0;
  const { code } = await runArgv(h.program, ["artifacts", "download", wf, ARTIFACT.path]);
  expect(code).toBe(0);
  expect(h.stdout.join("").trim().length).toBeGreaterThan(0);
});

test("artifacts download --json emits localPath + sizeBytes", async () => {
  const wf = await shipWithArtifact();
  h.stdout.length = 0;
  await runArgv(h.program, ["artifacts", "download", wf, ARTIFACT.path, "--json"]);
  const parsed = JSON.parse(h.stdout.join("").trim()) as { localPath: string; sizeBytes: number };
  expect(parsed.sizeBytes).toBe(ARTIFACT.sizeBytes);
});

test("artifacts download of a missing run exits non-zero with a message", async () => {
  const { code } = await runArgv(h.program, ["artifacts", "download", "wf_missing", "x/y.txt"]);
  expect(code).toBeGreaterThan(0);
  expect(h.stderr.join("").length).toBeGreaterThan(0);
});

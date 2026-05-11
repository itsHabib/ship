/** Argv → service.ship plumbing for the `ship ship` subcommand. */

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { CliHarness } from "./cli-harness.js";

import { createCliHarness, parseAndCatch, TEST_WORKDIR } from "./cli-harness.js";

let h: CliHarness;

beforeEach(async () => {
  h = await createCliHarness();
});

afterEach(() => {
  h.close();
});

describe("ship ship", () => {
  test("happy path: argv → service.ship → exit 0; pretty stdout includes id + summary", async () => {
    h.harness.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, summary: "ok", branches: [] },
    });
    const { code } = await parseAndCatch(h.program, [
      "ship",
      "docs.md",
      "--workdir",
      TEST_WORKDIR,
      "--repo",
      "ship",
    ]);
    expect(code).toBe(0);
    const out = h.stdout.join("");
    expect(out).toContain("status:        succeeded");
    expect(out).toMatch(/workflowRunId: wf_/);
    expect(out).toContain("summary:       ok");
    expect(h.harness.cursor.calls).toHaveLength(1);
  });

  test("--json emits parseable ShipOutput on stdout", async () => {
    h.harness.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    const { code } = await parseAndCatch(h.program, [
      "ship",
      "docs.md",
      "--workdir",
      TEST_WORKDIR,
      "--repo",
      "ship",
      "--json",
    ]);
    expect(code).toBe(0);
    const parsed = JSON.parse(h.stdout.join("").trim()) as { status: string };
    expect(parsed.status).toBe("succeeded");
  });

  test("missing --repo → exit 1; stderr names the missing option", async () => {
    const { code } = await parseAndCatch(h.program, ["ship", "docs.md", "--workdir", TEST_WORKDIR]);
    expect(code).toBe(1);
    expect(h.stderr.join("") + h.stdout.join("")).toMatch(/required.*--repo/i);
  });

  test("WorkdirNotFoundError from service → exit 1; stderr names the workdir", async () => {
    const { code } = await parseAndCatch(h.program, [
      "ship",
      "docs.md",
      "--workdir",
      "/does/not/exist",
      "--repo",
      "ship",
    ]);
    expect(code).toBe(1);
    expect(h.stderr.join("")).toMatch(/workdir.*not found|\/does\/not\/exist/i);
  });

  test("optional flags pass through to ShipService", async () => {
    h.harness.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    await parseAndCatch(h.program, [
      "ship",
      "docs.md",
      "--workdir",
      TEST_WORKDIR,
      "--repo",
      "ship",
      "--branch",
      "feat/x",
      "--base-ref",
      "main",
      "--worktree-name",
      "feat-x",
      "--model",
      "composer-2-thinking",
    ]);
    expect(h.harness.cursor.calls[0]?.input.model).toEqual({ id: "composer-2-thinking" });
  });

  test("--thinking low passes through to ShipService and overrides the wiring default", async () => {
    h.harness.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    const { code } = await parseAndCatch(h.program, [
      "ship",
      "docs.md",
      "--workdir",
      TEST_WORKDIR,
      "--repo",
      "ship",
      "--thinking",
      "low",
    ]);
    expect(code).toBe(0);
    expect(h.harness.cursor.calls[0]?.input.model).toEqual({
      id: "composer-2",
      params: [{ id: "thinking", value: "low" }],
    });
  });

  test("--thinking high passes through to ShipService", async () => {
    h.harness.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    const { code } = await parseAndCatch(h.program, [
      "ship",
      "docs.md",
      "--workdir",
      TEST_WORKDIR,
      "--repo",
      "ship",
      "--thinking",
      "high",
    ]);
    expect(code).toBe(0);
    expect(h.harness.cursor.calls[0]?.input.model).toEqual({
      id: "composer-2",
      params: [{ id: "thinking", value: "high" }],
    });
  });

  test("--thinking absent → no thinking field forwarded (wiring default applies)", async () => {
    h.harness.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    const { code } = await parseAndCatch(h.program, [
      "ship",
      "docs.md",
      "--workdir",
      TEST_WORKDIR,
      "--repo",
      "ship",
    ]);
    expect(code).toBe(0);
    // CLI harness's `createServiceFromHarness` uses a thinking-less
    // default model — so absence of `--thinking` lands as `{ id: "composer-2" }`,
    // not an injected high. The "default belongs in core, not the CLI"
    // invariant: the CLI never invents a thinking value of its own.
    expect(h.harness.cursor.calls[0]?.input.model).toEqual({ id: "composer-2" });
  });

  test("--thinking medium rejected with the standard input-validation message → exit 1", async () => {
    const { code } = await parseAndCatch(h.program, [
      "ship",
      "docs.md",
      "--workdir",
      TEST_WORKDIR,
      "--repo",
      "ship",
      "--thinking",
      "medium",
    ]);
    expect(code).toBe(1);
    expect(h.stderr.join("")).toMatch(/invalid --thinking: medium/);
    expect(h.harness.cursor.calls).toHaveLength(0);
  });

  test("--thinking + --model combine in the synthesized ModelSelection", async () => {
    h.harness.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    await parseAndCatch(h.program, [
      "ship",
      "docs.md",
      "--workdir",
      TEST_WORKDIR,
      "--repo",
      "ship",
      "--model",
      "composer-2-thinking",
      "--thinking",
      "low",
    ]);
    expect(h.harness.cursor.calls[0]?.input.model).toEqual({
      id: "composer-2-thinking",
      params: [{ id: "thinking", value: "low" }],
    });
  });
});

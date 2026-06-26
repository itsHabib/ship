/** Argv → service.ship plumbing for the `ship ship` subcommand. */

import { FakeCursorRunner } from "@ship/cursor-runner/test/fake";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { CliHarness } from "./cli-harness.js";

import { createCliHarness, runArgv, TEST_WORKDIR } from "./cli-harness.js";

let h: CliHarness;

beforeEach(async () => {
  h = await createCliHarness();
});

afterEach(() => {
  h.close();
});

const CLOUD_SCRIPT = {
  events: [],
  result: { status: "succeeded" as const, durationMs: 0, branches: [] },
};

describe("ship ship", () => {
  test("happy path: argv → service.ship → exit 0; pretty stdout includes id + summary", async () => {
    h.harness.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, summary: "ok", branches: [] },
    });
    const { code } = await runArgv(h.program, [
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
    const { code } = await runArgv(h.program, [
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
    const { code } = await runArgv(h.program, ["ship", "docs.md", "--workdir", TEST_WORKDIR]);
    expect(code).toBe(1);
    expect(h.stderr.join("") + h.stdout.join("")).toMatch(/required.*--repo/i);
  });

  test("WorkdirNotFoundError from service → exit 1; stderr names the workdir", async () => {
    const { code } = await runArgv(h.program, [
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
    await runArgv(h.program, [
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

  test("--model-param overrides wiring default params (last pair wins)", async () => {
    h.close();
    h = await createCliHarness({
      defaultModel: { id: "composer-2.5", params: [{ id: "fast", value: "true" }] },
    });
    h.harness.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    const { code } = await runArgv(h.program, [
      "ship",
      "docs.md",
      "--workdir",
      TEST_WORKDIR,
      "--repo",
      "ship",
      "--model-param",
      "fast=false",
    ]);
    expect(code).toBe(0);
    expect(h.harness.cursor.calls[0]?.input.model).toEqual({
      id: "composer-2.5",
      params: [{ id: "fast", value: false }],
    });
  });

  test("--model-param boolean parsing for literal true/false", async () => {
    h.harness.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    const { code } = await runArgv(h.program, [
      "ship",
      "docs.md",
      "--workdir",
      TEST_WORKDIR,
      "--repo",
      "ship",
      "--model-param",
      "fast=false",
      "--model-param",
      "other=stay",
    ]);
    expect(code).toBe(0);
    expect(h.harness.cursor.calls[0]?.input.model).toEqual({
      id: "composer-2.5",
      params: [
        { id: "fast", value: false },
        { id: "other", value: "stay" },
      ],
    });
  });

  test("--model-param absent Service gets no modelParams field (defaults apply)", async () => {
    h.harness.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    const { code } = await runArgv(h.program, [
      "ship",
      "docs.md",
      "--workdir",
      TEST_WORKDIR,
      "--repo",
      "ship",
    ]);
    expect(code).toBe(0);
    expect(h.harness.cursor.calls[0]?.input.model).toEqual({
      id: "composer-2.5",
      params: [{ id: "fast", value: "true" }],
    });
  });

  test("--model-param without '=' rejected", async () => {
    const { code } = await runArgv(h.program, [
      "ship",
      "docs.md",
      "--workdir",
      TEST_WORKDIR,
      "--repo",
      "ship",
      "--model-param",
      "KEY",
    ]);
    expect(code).toBe(1);
    expect(h.stderr.join("")).toMatch(/invalid --model-param: KEY/);
    expect(h.harness.cursor.calls).toHaveLength(0);
  });

  test("--model-param with empty value (KEY=) rejected at parse time", async () => {
    // CLI bypasses shipInputSchema and reaches ShipService directly, so without
    // this guard the empty string surfaces as a downstream modelSelectionSchema
    // failure at run-time instead of an immediate argument error.
    const { code } = await runArgv(h.program, [
      "ship",
      "docs.md",
      "--workdir",
      TEST_WORKDIR,
      "--repo",
      "ship",
      "--model-param",
      "fast=",
    ]);
    expect(code).toBe(1);
    expect(h.stderr.join("")).toMatch(/invalid --model-param: fast= \(empty value/);
    expect(h.harness.cursor.calls).toHaveLength(0);
  });

  test("--model-param + --model combine in synthesized ModelSelection", async () => {
    h.harness.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    await runArgv(h.program, [
      "ship",
      "docs.md",
      "--workdir",
      TEST_WORKDIR,
      "--repo",
      "ship",
      "--model",
      "composer-2-thinking",
      "--model-param",
      "fast=true",
    ]);
    expect(h.harness.cursor.calls[0]?.input.model).toEqual({
      id: "composer-2-thinking",
      params: [{ id: "fast", value: true }],
    });
  });

  test("--model-param duplicates last key wins", async () => {
    h.harness.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    await runArgv(h.program, [
      "ship",
      "docs.md",
      "--workdir",
      TEST_WORKDIR,
      "--repo",
      "ship",
      "--model-param",
      "fast=false",
      "--model-param",
      "fast=true",
    ]);
    expect(h.harness.cursor.calls[0]?.input.model).toEqual({
      id: "composer-2.5",
      params: [{ id: "fast", value: true }],
    });
  });

  test("--runtime cloud --cloud-repo forwards runtime + cloud.repos[0].url to cloud runner", async () => {
    const cloud = new FakeCursorRunner();
    h.close();
    h = await createCliHarness({ cloudCursor: cloud });
    cloud.enqueue(CLOUD_SCRIPT);
    const { code } = await runArgv(h.program, [
      "ship",
      "docs.md",
      "--workdir",
      TEST_WORKDIR,
      "--repo",
      "ship",
      "--runtime",
      "cloud",
      "--cloud-repo",
      "https://github.com/o/r",
    ]);
    expect(code).toBe(0);
    expect(cloud.calls).toHaveLength(1);
    expect(cloud.calls[0]?.input.runtime).toBe("cloud");
    expect(cloud.calls[0]?.input.cloud?.repos[0]?.url).toBe("https://github.com/o/r");
    expect(h.harness.cursor.calls).toHaveLength(0);
  });

  test("--runtime local forwards runtime local and does not pass cloud to runner", async () => {
    h.harness.cursor.enqueue(CLOUD_SCRIPT);
    await runArgv(h.program, [
      "ship",
      "docs.md",
      "--workdir",
      TEST_WORKDIR,
      "--repo",
      "ship",
      "--runtime",
      "local",
      "--cloud-repo",
      "https://github.com/o/r",
    ]);
    // CLI passes `{ runtime: "local", cloud: { repos: [...] } }` to the
    // service — the CLI doesn't pre-strip cloud-flag input when runtime is
    // local. The service's local-routing path then drops the cloud field
    // before invoking the runner, which is why the runner sees cloud
    // undefined here. This test asserts the end-to-end behavior; the
    // CLI-to-service contract is covered by the cloud-routed test above.
    expect(h.harness.cursor.calls[0]?.input.runtime).toBe("local");
    expect(h.harness.cursor.calls[0]?.input.cloud).toBeUndefined();
  });

  test("--runtime cloud without cloud spec → exit 1; stderr names cloud-repo", async () => {
    const { code } = await runArgv(h.program, [
      "ship",
      "docs.md",
      "--workdir",
      TEST_WORKDIR,
      "--repo",
      "ship",
      "--runtime",
      "cloud",
    ]);
    expect(code).toBe(1);
    expect(h.stderr.join("")).toMatch(/--cloud-repo|--cloud </);
    expect(h.harness.cursor.calls).toHaveLength(0);
  });

  test("--runtime omitted → runner input has no runtime field (service default)", async () => {
    h.harness.cursor.enqueue(CLOUD_SCRIPT);
    await runArgv(h.program, ["ship", "docs.md", "--workdir", TEST_WORKDIR, "--repo", "ship"]);
    expect(h.harness.cursor.calls[0]?.input.runtime).toBeUndefined();
  });

  test("invalid --runtime → exit 1; stderr names the bad value", async () => {
    const { code } = await runArgv(h.program, [
      "ship",
      "docs.md",
      "--workdir",
      TEST_WORKDIR,
      "--repo",
      "ship",
      "--runtime",
      "cloud2",
    ]);
    expect(code).toBe(1);
    expect(h.stderr.join("")).toMatch(/invalid --runtime: cloud2/);
    expect(h.harness.cursor.calls).toHaveLength(0);
  });

  test("--cloud-auto-create-pr and --cloud-skip-reviewer-request forward as true", async () => {
    const cloud = new FakeCursorRunner();
    h.close();
    h = await createCliHarness({ cloudCursor: cloud });
    cloud.enqueue(CLOUD_SCRIPT);
    await runArgv(h.program, [
      "ship",
      "docs.md",
      "--workdir",
      TEST_WORKDIR,
      "--repo",
      "ship",
      "--runtime",
      "cloud",
      "--cloud-repo",
      "https://github.com/o/r",
      "--cloud-auto-create-pr",
      "--cloud-skip-reviewer-request",
    ]);
    expect(cloud.calls[0]?.input.cloud?.autoCreatePR).toBe(true);
    expect(cloud.calls[0]?.input.cloud?.skipReviewerRequest).toBe(true);
  });

  test("--cloud-env-var accumulates envVars (last key wins)", async () => {
    const cloud = new FakeCursorRunner();
    h.close();
    h = await createCliHarness({ cloudCursor: cloud });
    cloud.enqueue(CLOUD_SCRIPT);
    await runArgv(h.program, [
      "ship",
      "docs.md",
      "--workdir",
      TEST_WORKDIR,
      "--repo",
      "ship",
      "--runtime",
      "cloud",
      "--cloud-repo",
      "https://github.com/o/r",
      "--cloud-env-var",
      "FOO=bar",
      "--cloud-env-var",
      "BAZ=qux",
      "--cloud-env-var",
      "FOO=override",
    ]);
    expect(cloud.calls[0]?.input.cloud?.envVars).toEqual({
      FOO: "override",
      BAZ: "qux",
    });
  });

  test("--cloud-env-var KEY= accepts empty value", async () => {
    const cloud = new FakeCursorRunner();
    h.close();
    h = await createCliHarness({ cloudCursor: cloud });
    cloud.enqueue(CLOUD_SCRIPT);
    await runArgv(h.program, [
      "ship",
      "docs.md",
      "--workdir",
      TEST_WORKDIR,
      "--repo",
      "ship",
      "--runtime",
      "cloud",
      "--cloud-repo",
      "https://github.com/o/r",
      "--cloud-env-var",
      "FOO=",
    ]);
    expect(cloud.calls[0]?.input.cloud?.envVars?.["FOO"]).toBe("");
  });

  test("--cloud-env-var without '=' → exit 1", async () => {
    const { code } = await runArgv(h.program, [
      "ship",
      "docs.md",
      "--workdir",
      TEST_WORKDIR,
      "--repo",
      "ship",
      "--runtime",
      "cloud",
      "--cloud-repo",
      "https://github.com/o/r",
      "--cloud-env-var",
      "KEY",
    ]);
    expect(code).toBe(1);
    expect(h.stderr.join("")).toMatch(/invalid --cloud-env-var: KEY/);
    expect(h.harness.cursor.calls).toHaveLength(0);
  });

  test("--cloud <path> loads JSON spec from disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-cloud-json-"));
    const cloudPath = join(dir, "spec.json");
    writeFileSync(
      cloudPath,
      JSON.stringify({
        repos: [{ url: "https://github.com/from/file" }],
        autoCreatePR: false,
      }),
    );
    try {
      const cloud = new FakeCursorRunner();
      h.close();
      h = await createCliHarness({ cloudCursor: cloud });
      cloud.enqueue(CLOUD_SCRIPT);
      const { code } = await runArgv(h.program, [
        "ship",
        "docs.md",
        "--workdir",
        TEST_WORKDIR,
        "--repo",
        "ship",
        "--runtime",
        "cloud",
        "--cloud",
        cloudPath,
      ]);
      expect(code).toBe(0);
      expect(cloud.calls[0]?.input.cloud?.repos[0]?.url).toBe("https://github.com/from/file");
      expect(cloud.calls[0]?.input.cloud?.autoCreatePR).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--cloud missing file → exit 1; stderr names the path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-cloud-miss-"));
    const cloudPath = join(dir, "nope.json");
    rmSync(dir, { recursive: true, force: true });
    const { code } = await runArgv(h.program, [
      "ship",
      "docs.md",
      "--workdir",
      TEST_WORKDIR,
      "--repo",
      "ship",
      "--runtime",
      "cloud",
      "--cloud",
      cloudPath,
    ]);
    expect(code).toBe(1);
    expect(h.stderr.join("")).toContain(cloudPath);
  });

  test("--cloud malformed JSON → exit 1; stderr includes parse error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-cloud-badjson-"));
    const cloudPath = join(dir, "spec.json");
    writeFileSync(cloudPath, "{ not json");
    try {
      const { code } = await runArgv(h.program, [
        "ship",
        "docs.md",
        "--workdir",
        TEST_WORKDIR,
        "--repo",
        "ship",
        "--runtime",
        "cloud",
        "--cloud",
        cloudPath,
      ]);
      expect(code).toBe(1);
      expect(h.stderr.join("")).toMatch(/invalid JSON in --cloud file:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--cloud JSON shape mismatch → exit 1; stderr includes Zod message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-cloud-zod-"));
    const cloudPath = join(dir, "spec.json");
    writeFileSync(cloudPath, JSON.stringify({ repos: [] }));
    try {
      const { code } = await runArgv(h.program, [
        "ship",
        "docs.md",
        "--workdir",
        TEST_WORKDIR,
        "--repo",
        "ship",
        "--runtime",
        "cloud",
        "--cloud",
        cloudPath,
      ]);
      expect(code).toBe(1);
      expect(h.stderr.join()).toMatch(/repos/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--cloud file wins over --cloud-auto-create-pr field flag", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-cloud-prec-"));
    const cloudPath = join(dir, "spec.json");
    writeFileSync(
      cloudPath,
      JSON.stringify({
        repos: [{ url: "https://github.com/from/file" }],
        autoCreatePR: false,
      }),
    );
    try {
      const cloud = new FakeCursorRunner();
      h.close();
      h = await createCliHarness({ cloudCursor: cloud });
      cloud.enqueue(CLOUD_SCRIPT);
      const { code } = await runArgv(h.program, [
        "ship",
        "docs.md",
        "--workdir",
        TEST_WORKDIR,
        "--repo",
        "ship",
        "--runtime",
        "cloud",
        "--cloud",
        cloudPath,
        "--cloud-auto-create-pr",
      ]);
      expect(code).toBe(0);
      expect(cloud.calls[0]?.input.cloud?.autoCreatePR).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--provider claude --runtime local forwards to claude runner", async () => {
    const claude = new FakeCursorRunner();
    h.close();
    h = await createCliHarness({ claude });
    claude.enqueue(CLOUD_SCRIPT);
    const { code } = await runArgv(h.program, [
      "ship",
      "docs.md",
      "--workdir",
      TEST_WORKDIR,
      "--repo",
      "ship",
      "--provider",
      "claude",
      "--runtime",
      "local",
    ]);
    expect(code).toBe(0);
    expect(claude.calls).toHaveLength(1);
    expect(h.harness.cursor.calls).toHaveLength(0);
  });

  test("--provider claude --runtime cloud fails fast at CLI boundary", async () => {
    const { code } = await runArgv(h.program, [
      "ship",
      "docs.md",
      "--workdir",
      TEST_WORKDIR,
      "--repo",
      "ship",
      "--provider",
      "claude",
      "--runtime",
      "cloud",
      "--cloud-repo",
      "https://github.com/o/r",
    ]);
    expect(code).toBe(1);
    expect(h.stderr.join("")).toMatch(/claude provider supports only runtime 'local'/);
    expect(h.harness.cursor.calls).toHaveLength(0);
  });

  test("invalid --provider → exit 1; stderr names the bad value", async () => {
    const { code } = await runArgv(h.program, [
      "ship",
      "docs.md",
      "--workdir",
      TEST_WORKDIR,
      "--repo",
      "ship",
      "--provider",
      "bogus",
    ]);
    expect(code).toBe(1);
    expect(h.stderr.join("")).toMatch(/invalid --provider: bogus/);
    expect(h.harness.cursor.calls).toHaveLength(0);
  });
});

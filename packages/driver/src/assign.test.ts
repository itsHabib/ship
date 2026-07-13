/** Tests for model-pool assignment (spec §4). */

import { describe, expect, test } from "vitest";

import { assignModelPoolToManifest } from "./assign-writeback.js";
import { computeAssignments, isLegalCell, parseModelPool } from "./assign.js";
import { AssignError } from "./errors.js";
import { type DriverManifest, parseManifest } from "./manifest.js";

interface ManifestOpts {
  // Default "cloud" so bare cursor fixtures form valid cloud/cursor cells
  // (cursor cloud needs repo_url, not branch_name — provided below).
  defaultRuntime?: string;
  repoUrl?: string | null;
}

function manifestText(streamsYaml: string, opts: ManifestOpts = {}): string {
  const runtime = opts.defaultRuntime ?? "cloud";
  const repoUrl = opts.repoUrl === undefined ? "https://github.com/itsHabib/ship" : opts.repoUrl;
  const lines = [
    "---",
    "driver_version: 1",
    "generated_at: 2026-07-13T00:00:00Z",
    "generated_by: work-driver-prep",
    "source:",
    "  project: ship",
    "  phase: assign-test",
    "repo: ship",
  ];
  if (repoUrl !== null) lines.push(`repo_url: ${repoUrl}`);
  lines.push(`default_runtime: ${runtime}`, "batches:", streamsYaml, "---", "");
  return lines.join("\n");
}

function parsedManifest(streamsYaml: string, opts: ManifestOpts = {}): DriverManifest {
  const result = parseManifest(manifestText(streamsYaml, opts));
  if (!result.ok) {
    throw new Error(`fixture manifest failed to parse: ${result.errors[0]?.message ?? "unknown"}`);
  }
  return result.manifest;
}

const THREE_STREAMS_ONE_BATCH = [
  "  - id: 1",
  "    depends_on: []",
  "    streams:",
  "      - spec_path: docs/a.md",
  "      - spec_path: docs/b.md",
  "      - spec_path: docs/c.md",
].join("\n");

describe("parseModelPool", () => {
  test("parses a single provider:model member", () => {
    expect(parseModelPool("cursor:grok-4.5")).toEqual([
      { provider: "cursor", modelId: "grok-4.5" },
    ]);
  });

  test("parses multiple members and a runtime prefix", () => {
    expect(parseModelPool("cursor:grok-4.5, local/claude:claude-opus-4-8")).toEqual([
      { provider: "cursor", modelId: "grok-4.5" },
      { provider: "claude", modelId: "claude-opus-4-8", runtime: "local" },
    ]);
  });

  test("rejects an empty pool", () => {
    expect(() => parseModelPool("   ")).toThrow(AssignError);
  });

  test("rejects a member without a colon", () => {
    expect(() => parseModelPool("cursor")).toThrow(/expected "\[runtime\/\]provider:model_id"/);
  });

  test("rejects an empty model id", () => {
    expect(() => parseModelPool("cursor:")).toThrow(AssignError);
  });

  test("rejects an empty provider", () => {
    expect(() => parseModelPool(":grok-4.5")).toThrow(AssignError);
  });

  test("rejects an unknown provider", () => {
    expect(() => parseModelPool("bogus:model")).toThrow(/unknown provider/);
  });

  test("rejects an unknown runtime prefix", () => {
    expect(() => parseModelPool("sky/cursor:grok-4.5")).toThrow(/unknown runtime/);
  });
});

describe("isLegalCell", () => {
  test("accepts wired cells", () => {
    expect(isLegalCell("cursor", "rooms")).toBe(true);
    expect(isLegalCell("claude", "cloud")).toBe(true);
    expect(isLegalCell("codex", "local")).toBe(true);
  });

  test("rejects illegal cells", () => {
    expect(isLegalCell("codex", "cloud")).toBe(false);
    expect(isLegalCell("claude", "rooms")).toBe(false);
  });
});

describe("computeAssignments", () => {
  test("round-robins the pool over streams in order", () => {
    const pool = parseModelPool("cursor:grok-4.5,cursor:claude-opus-4-8,cursor:composer-2.5");
    const plan = computeAssignments(parsedManifest(THREE_STREAMS_ONE_BATCH), pool);
    expect(plan.assignments.map((a) => a.modelId)).toEqual([
      "grok-4.5",
      "claude-opus-4-8",
      "composer-2.5",
    ]);
    expect(plan.assignments.map((a) => a.specPath)).toEqual([
      "docs/a.md",
      "docs/b.md",
      "docs/c.md",
    ]);
  });

  test("wraps when the pool is smaller than the stream count", () => {
    const pool = parseModelPool("cursor:grok-4.5,cursor:composer-2.5");
    const plan = computeAssignments(parsedManifest(THREE_STREAMS_ONE_BATCH), pool);
    expect(plan.assignments.map((a) => a.modelId)).toEqual([
      "grok-4.5",
      "composer-2.5",
      "grok-4.5",
    ]);
  });

  test("stops when the pool is larger than the stream count", () => {
    const twoStreams = [
      "  - id: 1",
      "    depends_on: []",
      "    streams:",
      "      - spec_path: docs/a.md",
      "      - spec_path: docs/b.md",
    ].join("\n");
    const pool = parseModelPool("cursor:grok-4.5,cursor:composer-2.5,cursor:claude-opus-4-8");
    const plan = computeAssignments(parsedManifest(twoStreams), pool);
    expect(plan.assignments.map((a) => a.modelId)).toEqual(["grok-4.5", "composer-2.5"]);
  });

  test("uses one global counter across batches (no per-batch reset)", () => {
    const twoBatches = [
      "  - id: 1",
      "    depends_on: []",
      "    streams:",
      "      - spec_path: docs/a.md",
      "  - id: 2",
      "    depends_on: [1]",
      "    streams:",
      "      - spec_path: docs/b.md",
      "      - spec_path: docs/c.md",
    ].join("\n");
    const pool = parseModelPool("cursor:grok-4.5,cursor:composer-2.5");
    const plan = computeAssignments(parsedManifest(twoBatches), pool);
    // Global counter: a->grok(0), b->composer(1), c->grok(2). A per-batch
    // reset would give a->grok, b->grok, c->composer.
    expect(plan.assignments.map((a) => a.modelId)).toEqual([
      "grok-4.5",
      "composer-2.5",
      "grok-4.5",
    ]);
  });

  test("skips terminal streams without consuming a rotation slot", () => {
    const withDone = [
      "  - id: 1",
      "    depends_on: []",
      "    streams:",
      "      - spec_path: docs/a.md",
      "        status: done",
      "      - spec_path: docs/b.md",
      "      - spec_path: docs/c.md",
    ].join("\n");
    const pool = parseModelPool("cursor:grok-4.5,cursor:composer-2.5");
    const plan = computeAssignments(parsedManifest(withDone), pool);
    // done stream skipped; b->grok(0), c->composer(1).
    expect(plan.assignments.map((a) => a.specPath)).toEqual(["docs/b.md", "docs/c.md"]);
    expect(plan.assignments.map((a) => a.modelId)).toEqual(["grok-4.5", "composer-2.5"]);
    expect(plan.skipped).toEqual([{ specPath: "docs/a.md", status: "done" }]);
  });

  test("stamps runtime only for a prefixed member; resolves the rest", () => {
    const pool = parseModelPool("cloud/cursor:grok-4.5,cursor:composer-2.5");
    const plan = computeAssignments(
      parsedManifest(THREE_STREAMS_ONE_BATCH, { defaultRuntime: "cloud" }),
      pool,
    );
    // a: prefixed cloud → stamped; b: unprefixed → resolves to default cloud;
    // c: wraps to prefixed cloud again.
    expect(plan.assignments[0]?.stampRuntime).toBe("cloud");
    expect(plan.assignments[0]?.resolvedRuntime).toBe("cloud");
    expect(plan.assignments[1]?.stampRuntime).toBeUndefined();
    expect(plan.assignments[1]?.resolvedRuntime).toBe("cloud");
  });

  test("rejects illegal cells with the full list, mutating nothing", () => {
    const pool = parseModelPool("cloud/codex:gpt-5.2-codex,cloud/codex:gpt-5.2-codex");
    expect(() => computeAssignments(parsedManifest(THREE_STREAMS_ONE_BATCH), pool)).toThrow(
      /unwired dispatch cell/,
    );
  });

  test("rejects an empty pool", () => {
    expect(() => computeAssignments(parsedManifest(THREE_STREAMS_ONE_BATCH), [])).toThrow(
      AssignError,
    );
  });

  test("rejects a local target on a branchless stream (engine preflight rule)", () => {
    const pool = parseModelPool("cursor:grok-4.5");
    const manifest = parsedManifest(THREE_STREAMS_ONE_BATCH, { defaultRuntime: "local" });
    expect(() => computeAssignments(manifest, pool)).toThrow(/requires branch_name/);
  });

  test("rejects claude/cloud on a branchless stream (import rule)", () => {
    const pool = parseModelPool("claude:claude-opus-4-8");
    // default cloud + claude provider + no branch_name -> import would reject.
    expect(() => computeAssignments(parsedManifest(THREE_STREAMS_ONE_BATCH), pool)).toThrow(
      /requires branch_name/,
    );
  });

  test("accepts a local target when the stream carries branch_name", () => {
    const withBranch = [
      "  - id: 1",
      "    depends_on: []",
      "    streams:",
      "      - spec_path: docs/a.md",
      "        branch_name: feat-a",
    ].join("\n");
    const pool = parseModelPool("cursor:grok-4.5");
    const plan = computeAssignments(parsedManifest(withBranch, { defaultRuntime: "local" }), pool);
    expect(plan.assignments[0]?.resolvedRuntime).toBe("local");
  });

  test("rejects a cloud target when the manifest lacks repo_url", () => {
    const pool = parseModelPool("cursor:grok-4.5");
    const manifest = parsedManifest(THREE_STREAMS_ONE_BATCH, { repoUrl: null });
    expect(() => computeAssignments(manifest, pool)).toThrow(/repo_url/);
  });
});

describe("assignModelPoolToManifest", () => {
  test("stamps provider + model_id and records the pool, re-parsing cleanly", () => {
    const text = manifestText(THREE_STREAMS_ONE_BATCH);
    const result = assignModelPoolToManifest(text, "cursor:grok-4.5,cursor:composer-2.5");
    const reparsed = parseManifest(result.text);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    const streams = reparsed.manifest.batches[0]?.streams ?? [];
    expect(streams[0]?.provider).toBe("cursor");
    expect(streams[0]?.model_id).toBe("grok-4.5");
    expect(streams[1]?.model_id).toBe("composer-2.5");
    expect(streams[2]?.model_id).toBe("grok-4.5");
    expect(reparsed.manifest.assignment).toEqual({
      pool: ["cursor:grok-4.5", "cursor:composer-2.5"],
    });
  });

  test("is idempotent for the same pool", () => {
    const text = manifestText(THREE_STREAMS_ONE_BATCH);
    const once = assignModelPoolToManifest(text, "cursor:grok-4.5,cursor:composer-2.5");
    const twice = assignModelPoolToManifest(once.text, "cursor:grok-4.5,cursor:composer-2.5");
    expect(twice.text).toBe(once.text);
  });

  test("throws on a malformed manifest", () => {
    expect(() => assignModelPoolToManifest("not a manifest", "cursor:grok-4.5")).toThrow(
      AssignError,
    );
  });

  test("leaves terminal streams unstamped in the written manifest", () => {
    const withDone = [
      "  - id: 1",
      "    depends_on: []",
      "    streams:",
      "      - spec_path: docs/a.md",
      "        status: done",
      "      - spec_path: docs/b.md",
    ].join("\n");
    const result = assignModelPoolToManifest(manifestText(withDone), "cursor:grok-4.5");
    const reparsed = parseManifest(result.text);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    const streams = reparsed.manifest.batches[0]?.streams ?? [];
    expect(streams[0]?.provider).toBeUndefined();
    expect(streams[0]?.model_id).toBeUndefined();
    expect(streams[1]?.provider).toBe("cursor");
    expect(streams[1]?.model_id).toBe("grok-4.5");
  });

  test("preserves CRLF line endings", () => {
    const crlf = manifestText(THREE_STREAMS_ONE_BATCH).replace(/\n/g, "\r\n");
    const result = assignModelPoolToManifest(crlf, "cursor:grok-4.5");
    expect(result.text).toContain("\r\n");
    expect(result.text).not.toMatch(/[^\r]\n/);
    expect(parseManifest(result.text).ok).toBe(true);
  });
});

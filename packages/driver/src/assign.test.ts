/** Tests for model-pool assignment (spec §4). */

import { describe, expect, test } from "vitest";

import type { ViabilityDeps } from "./viability.js";

import { assignModelPoolToManifest } from "./assign-writeback.js";
import { computeAssignments, isLegalCell, parseModelPool } from "./assign.js";
import { AssignError } from "./errors.js";
import { type DriverManifest, parseManifest } from "./manifest.js";

const NOW = "2026-07-13T00:00:00.000Z";
const fixedNow = (): string => NOW;

// A catalog that lists `models`; every cursor id outside it is dropped.
function stubDeps(models: string[], env: ViabilityDeps["env"] = {}): ViabilityDeps {
  return { env, listCursorModels: () => Promise.resolve(models) };
}

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
  test("stamps provider + model_id and records the pool, re-parsing cleanly", async () => {
    const text = manifestText(THREE_STREAMS_ONE_BATCH);
    const result = await assignModelPoolToManifest(text, "cursor:grok-4.5,cursor:composer-2.5", {
      now: fixedNow,
    });
    const reparsed = parseManifest(result.text);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    const streams = reparsed.manifest.batches[0]?.streams ?? [];
    expect(streams[0]?.provider).toBe("cursor");
    expect(streams[0]?.model_id).toBe("grok-4.5");
    expect(streams[1]?.model_id).toBe("composer-2.5");
    expect(streams[2]?.model_id).toBe("grok-4.5");
    expect(reparsed.manifest.assignment).toEqual({
      assigned_at: NOW,
      dropped: [],
      effective_pool: ["cursor:grok-4.5", "cursor:composer-2.5"],
      pool: ["cursor:grok-4.5", "cursor:composer-2.5"],
    });
  });

  test("is idempotent for the same pool", async () => {
    const text = manifestText(THREE_STREAMS_ONE_BATCH);
    const once = await assignModelPoolToManifest(text, "cursor:grok-4.5,cursor:composer-2.5", {
      now: fixedNow,
    });
    const twice = await assignModelPoolToManifest(
      once.text,
      "cursor:grok-4.5,cursor:composer-2.5",
      {
        now: fixedNow,
      },
    );
    expect(twice.text).toBe(once.text);
  });

  test("rejects a malformed manifest", async () => {
    await expect(assignModelPoolToManifest("not a manifest", "cursor:grok-4.5")).rejects.toThrow(
      AssignError,
    );
  });

  test("leaves terminal streams unstamped in the written manifest", async () => {
    const withDone = [
      "  - id: 1",
      "    depends_on: []",
      "    streams:",
      "      - spec_path: docs/a.md",
      "        status: done",
      "      - spec_path: docs/b.md",
    ].join("\n");
    const result = await assignModelPoolToManifest(manifestText(withDone), "cursor:grok-4.5", {
      now: fixedNow,
    });
    const reparsed = parseManifest(result.text);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    const streams = reparsed.manifest.batches[0]?.streams ?? [];
    expect(streams[0]?.provider).toBeUndefined();
    expect(streams[0]?.model_id).toBeUndefined();
    expect(streams[1]?.provider).toBe("cursor");
    expect(streams[1]?.model_id).toBe("grok-4.5");
  });

  test("preserves CRLF line endings", async () => {
    const crlf = manifestText(THREE_STREAMS_ONE_BATCH).replace(/\n/g, "\r\n");
    const result = await assignModelPoolToManifest(crlf, "cursor:grok-4.5", { now: fixedNow });
    expect(result.text).toContain("\r\n");
    expect(result.text).not.toMatch(/[^\r]\n/);
    expect(parseManifest(result.text).ok).toBe(true);
  });

  test("preflight drops an unreachable member and records it", async () => {
    const text = manifestText(THREE_STREAMS_ONE_BATCH);
    // Catalog lists grok but not composer → composer is dropped.
    const result = await assignModelPoolToManifest(text, "cursor:grok-4.5,cursor:composer-2.5", {
      deps: stubDeps(["grok-4.5"]),
      now: fixedNow,
      preflight: true,
    });
    expect(result.effectivePool.map((member) => member.modelId)).toEqual(["grok-4.5"]);
    expect(result.dropped.map((drop) => drop.member.modelId)).toEqual(["composer-2.5"]);
    // Effective pool of one → every stream gets grok.
    expect(result.assignments.map((a) => a.modelId)).toEqual(["grok-4.5", "grok-4.5", "grok-4.5"]);
    const reparsed = parseManifest(result.text);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.manifest.assignment).toEqual({
      assigned_at: NOW,
      dropped: [
        {
          member: "cursor:composer-2.5",
          reason: 'cursor model "composer-2.5" is not in /v1/models',
        },
      ],
      effective_pool: ["cursor:grok-4.5"],
      pool: ["cursor:grok-4.5", "cursor:composer-2.5"],
    });
  });

  test("aborts before write-back when preflight empties the pool", async () => {
    await expect(
      assignModelPoolToManifest(
        manifestText(THREE_STREAMS_ONE_BATCH),
        "cursor:grok-4.5,cursor:composer-2.5",
        { deps: stubDeps([]), preflight: true },
      ),
    ).rejects.toThrow(/preflight dropped every pool member/);
  });

  test("skips the probe when preflight is off, even with a would-drop catalog", async () => {
    const result = await assignModelPoolToManifest(
      manifestText(THREE_STREAMS_ONE_BATCH),
      "cursor:grok-4.5,cursor:composer-2.5",
      { deps: stubDeps([]), now: fixedNow, preflight: false },
    );
    expect(result.dropped).toEqual([]);
    expect(result.effectivePool.map((member) => member.modelId)).toEqual([
      "grok-4.5",
      "composer-2.5",
    ]);
  });

  test("propagates a catalog fetch failure as a hard error", async () => {
    const deps: ViabilityDeps = {
      env: {},
      listCursorModels: () =>
        Promise.reject(new AssignError("cursor /v1/models unreachable: boom")),
    };
    await expect(
      assignModelPoolToManifest(manifestText(THREE_STREAMS_ONE_BATCH), "cursor:grok-4.5", {
        deps,
        preflight: true,
      }),
    ).rejects.toThrow(/unreachable/);
  });
});

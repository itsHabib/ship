import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseManifest } from "./manifest.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "../test/fixtures");
const repoRoot = join(here, "../../..");

function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), "utf8");
}

function minimalManifest(overrides = ""): string {
  return [
    "---",
    "driver_version: 1",
    "generated_at: 2026-06-10T00:00:00Z",
    "generated_by: work-driver-prep",
    "source:",
    "  project: ship",
    "  phase: test",
    "repo: ship",
    "batches: []",
    overrides,
    "---",
    "",
  ].join("\n");
}

function expectOk(text: string): void {
  const result = parseManifest(text);
  expect(result.ok).toBe(true);
}

function expectError(text: string, matcher: RegExp | string): void {
  const result = parseManifest(text);
  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }
  const messages = result.errors.map((error) => error.message).join("\n");
  if (typeof matcher === "string") {
    expect(messages).toContain(matcher);
    return;
  }
  expect(messages).toMatch(matcher);
}

describe("parseManifest valid manifests", () => {
  it("parses a minimal manifest with only required fields", () => {
    const result = parseManifest(minimalManifest());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.manifest.batches).toEqual([]);
    expect(result.manifest.driver_version).toBe(1);
  });

  it("parses the synthetic full fixture", () => {
    expectOk(loadFixture("synthetic-full.driver.md"));
  });

  it("parses the real hygiene-followups historical fixture", () => {
    expectOk(loadFixture("hygiene-followups.driver.md"));
  });

  it("parses empty batches and empty streams", () => {
    const text = [
      "---",
      "driver_version: 1",
      "generated_at: 2026-06-10T00:00:00Z",
      "generated_by: work-driver-prep",
      "source:",
      "  project: ship",
      "  phase: test",
      "repo: ship",
      "batches:",
      "  - id: 1",
      "    depends_on: []",
      "    streams: []",
      "---",
    ].join("\n");
    expectOk(text);
  });

  it("parses a stream with only spec_path", () => {
    const text = [
      "---",
      "driver_version: 1",
      "generated_at: 2026-06-10T00:00:00Z",
      "generated_by: work-driver-prep",
      "source:",
      "  project: ship",
      "  phase: test",
      "repo: ship",
      "batches:",
      "  - id: 1",
      "    depends_on: []",
      "    streams:",
      "      - spec_path: docs/features/test/spec.md",
      "---",
    ].join("\n");
    const result = parseManifest(text);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.manifest.batches[0]?.streams[0]?.spec_path).toBe("docs/features/test/spec.md");
    expect(result.manifest.batches[0]?.streams[0]?.touches).toEqual([]);
  });

  it("preserves rawFrontmatter byte-identical to the input frontmatter block", () => {
    const fixture = loadFixture("synthetic-full.driver.md");
    const result = parseManifest(fixture);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const body = fixture.startsWith("\ufeff") ? fixture.slice(1) : fixture;
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body);
    expect(match?.[1]).toBe(result.rawFrontmatter);
  });
});

describe("parseManifest invalid manifests", () => {
  it("rejects missing frontmatter", () => {
    expectError("# no frontmatter", "missing driver manifest frontmatter");
  });

  it("rejects unterminated frontmatter fence", () => {
    expectError("---\ndriver_version: 1\n", "unterminated driver manifest frontmatter");
  });

  it("rejects missing driver_version", () => {
    const text = minimalManifest().replace("driver_version: 1\n", "");
    const result = parseManifest(text);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.some((error) => error.path === "driver_version")).toBe(true);
  });

  it("rejects missing generated_at", () => {
    const text = minimalManifest().replace("generated_at: 2026-06-10T00:00:00Z\n", "");
    const result = parseManifest(text);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.some((error) => error.path === "generated_at")).toBe(true);
  });

  it("rejects missing generated_by", () => {
    const text = minimalManifest().replace("generated_by: work-driver-prep\n", "");
    const result = parseManifest(text);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.some((error) => error.path === "generated_by")).toBe(true);
  });

  it("rejects missing source", () => {
    const text = minimalManifest().replace("source:\n  project: ship\n  phase: test\n", "");
    const result = parseManifest(text);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.some((error) => error.path === "source")).toBe(true);
  });

  it("rejects missing repo", () => {
    const text = minimalManifest().replace("repo: ship\n", "");
    const result = parseManifest(text);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.some((error) => error.path === "repo")).toBe(true);
  });

  it("rejects missing batches", () => {
    const text = minimalManifest().replace("batches: []\n", "");
    const result = parseManifest(text);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.some((error) => error.path === "batches")).toBe(true);
  });

  it("rejects missing batch id", () => {
    const text = [
      "---",
      "driver_version: 1",
      "generated_at: 2026-06-10T00:00:00Z",
      "generated_by: work-driver-prep",
      "source:",
      "  project: ship",
      "  phase: test",
      "repo: ship",
      "batches:",
      "  - depends_on: []",
      "    streams: []",
      "---",
    ].join("\n");
    const result = parseManifest(text);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.some((error) => error.path?.includes("id"))).toBe(true);
  });

  it("rejects empty stream spec_path", () => {
    const text = [
      "---",
      "driver_version: 1",
      "generated_at: 2026-06-10T00:00:00Z",
      "generated_by: work-driver-prep",
      "source:",
      "  project: ship",
      "  phase: test",
      "repo: ship",
      "batches:",
      "  - id: 1",
      "    depends_on: []",
      "    streams:",
      '      - spec_path: ""',
      "---",
    ].join("\n");
    const result = parseManifest(text);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.some((error) => error.path === "batches[0].streams[0].spec_path")).toBe(
      true,
    );
  });

  it("rejects missing stream spec_path", () => {
    const text = [
      "---",
      "driver_version: 1",
      "generated_at: 2026-06-10T00:00:00Z",
      "generated_by: work-driver-prep",
      "source:",
      "  project: ship",
      "  phase: test",
      "repo: ship",
      "batches:",
      "  - id: 1",
      "    depends_on: []",
      "    streams:",
      "      - task_slug: no-spec",
      "---",
    ].join("\n");
    const result = parseManifest(text);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.some((error) => error.path?.includes("spec_path"))).toBe(true);
  });

  it("rejects unsupported driver_version", () => {
    const text = minimalManifest().replace("driver_version: 1", "driver_version: 2");
    expectError(text, "unsupported driver_version 2");
  });

  it("rejects unknown top-level field", () => {
    const text = minimalManifest("unknown_top: true");
    const result = parseManifest(text);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(
      result.errors.some((error) => error.message.includes('unknown field "unknown_top"')),
    ).toBe(true);
  });

  it("rejects unknown batch field", () => {
    const text = [
      "---",
      "driver_version: 1",
      "generated_at: 2026-06-10T00:00:00Z",
      "generated_by: work-driver-prep",
      "source:",
      "  project: ship",
      "  phase: test",
      "repo: ship",
      "batches:",
      "  - id: 1",
      "    depends_on: []",
      "    streams: []",
      "    batch_prefx: oops",
      "---",
    ].join("\n");
    const result = parseManifest(text);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(
      result.errors.some((error) => error.message.includes('unknown field "batch_prefx"')),
    ).toBe(true);
  });

  it("rejects unknown stream field", () => {
    const text = [
      "---",
      "driver_version: 1",
      "generated_at: 2026-06-10T00:00:00Z",
      "generated_by: work-driver-prep",
      "source:",
      "  project: ship",
      "  phase: test",
      "repo: ship",
      "batches:",
      "  - id: 1",
      "    depends_on: []",
      "    streams:",
      "      - spec_path: docs/x.md",
      "        branch_prefx: oops",
      "---",
    ].join("\n");
    const result = parseManifest(text);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(
      result.errors.some((error) => error.message.includes('unknown field "branch_prefx"')),
    ).toBe(true);
  });

  it("rejects non-object yaml at top level", () => {
    expectError("---\n- just\n- a\n- list\n---\n", "must be a yaml mapping");
  });

  it("reports malformed yaml with line and column", () => {
    const text = [
      "---",
      "driver_version: 1",
      "generated_at: 2026-06-10T00:00:00Z",
      "generated_by: work-driver-prep",
      "source:",
      "  project: ship",
      "  phase: test",
      "repo: ship",
      "batches: [unterminated",
      "---",
    ].join("\n");
    const result = parseManifest(text);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors[0]?.line).toBeTypeOf("number");
    expect(result.errors[0]?.column).toBeTypeOf("number");
  });

  it("rejects invalid runtime enum with path", () => {
    const text = [
      "---",
      "driver_version: 1",
      "generated_at: 2026-06-10T00:00:00Z",
      "generated_by: work-driver-prep",
      "source:",
      "  project: ship",
      "  phase: test",
      "repo: ship",
      "default_runtime: satellite",
      "batches: []",
      "---",
    ].join("\n");
    const result = parseManifest(text);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.some((error) => error.path === "default_runtime")).toBe(true);
  });

  it("rejects invalid batch status enum", () => {
    const text = [
      "---",
      "driver_version: 1",
      "generated_at: 2026-06-10T00:00:00Z",
      "generated_by: work-driver-prep",
      "source:",
      "  project: ship",
      "  phase: test",
      "repo: ship",
      "batches:",
      "  - id: 1",
      "    depends_on: []",
      "    status: blocked",
      "    streams: []",
      "---",
    ].join("\n");
    const result = parseManifest(text);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.some((error) => error.path === "batches[0].status")).toBe(true);
  });

  it("rejects invalid stream status enum", () => {
    const text = [
      "---",
      "driver_version: 1",
      "generated_at: 2026-06-10T00:00:00Z",
      "generated_by: work-driver-prep",
      "source:",
      "  project: ship",
      "  phase: test",
      "repo: ship",
      "batches:",
      "  - id: 1",
      "    depends_on: []",
      "    streams:",
      "      - spec_path: docs/x.md",
      "        status: blocked",
      "---",
    ].join("\n");
    const result = parseManifest(text);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.some((error) => error.path === "batches[0].streams[0].status")).toBe(true);
  });

  it("rejects wrong type for repo", () => {
    const text = minimalManifest().replace("repo: ship", "repo: 42");
    const result = parseManifest(text);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.some((error) => error.path === "repo")).toBe(true);
  });

  it("rejects unknown source field", () => {
    const text = minimalManifest().replace("  phase: test", "  phase: test\n  extra: true");
    const result = parseManifest(text);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.some((error) => error.message.includes('unknown field "extra"'))).toBe(
      true,
    );
  });

  it("rejects missing depends_on on a batch", () => {
    const text = [
      "---",
      "driver_version: 1",
      "generated_at: 2026-06-10T00:00:00Z",
      "generated_by: work-driver-prep",
      "source:",
      "  project: ship",
      "  phase: test",
      "repo: ship",
      "batches:",
      "  - id: 1",
      "    streams: []",
      "---",
    ].join("\n");
    const result = parseManifest(text);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.some((error) => error.path === "batches[0].depends_on")).toBe(true);
  });

  it("rejects a two-batch dependency cycle", () => {
    const text = [
      "---",
      "driver_version: 1",
      "generated_at: 2026-06-10T00:00:00Z",
      "generated_by: work-driver-prep",
      "source:",
      "  project: ship",
      "  phase: test",
      "repo: ship",
      "batches:",
      "  - id: 1",
      "    depends_on: [2]",
      "    streams: []",
      "  - id: 2",
      "    depends_on: [1]",
      "    streams: []",
      "---",
    ].join("\n");
    const result = parseManifest(text);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.some((error) => error.message.includes("1 → 2 → 1"))).toBe(true);
  });

  it("includes line numbers for unknown stream fields when feasible", () => {
    const text = [
      "---",
      "driver_version: 1",
      "generated_at: 2026-06-10T00:00:00Z",
      "generated_by: work-driver-prep",
      "source:",
      "  project: ship",
      "  phase: test",
      "repo: ship",
      "batches:",
      "  - id: 1",
      "    depends_on: []",
      "    streams:",
      "      - spec_path: docs/x.md",
      "        branch_prefx: oops",
      "---",
    ].join("\n");
    const result = parseManifest(text);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    const error = result.errors.find((entry) =>
      entry.message.includes('unknown field "branch_prefx"'),
    );
    expect(error?.line).toBeTypeOf("number");
    expect(error?.column).toBeTypeOf("number");
  });
});

describe("parseManifest referential validation", () => {
  it("rejects duplicate batch ids", () => {
    const text = [
      "---",
      "driver_version: 1",
      "generated_at: 2026-06-10T00:00:00Z",
      "generated_by: work-driver-prep",
      "source:",
      "  project: ship",
      "  phase: test",
      "repo: ship",
      "batches:",
      "  - id: 1",
      "    depends_on: []",
      "    streams: []",
      "  - id: 1",
      "    depends_on: []",
      "    streams: []",
      "---",
    ].join("\n");
    const result = parseManifest(text);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    const error = result.errors.find((entry) => entry.message.includes("duplicate batch id 1"));
    expect(error?.line).toBeTypeOf("number");
    expect(error?.path).toBe("batches[1].id");
  });

  it("rejects unknown depends_on reference", () => {
    const text = [
      "---",
      "driver_version: 1",
      "generated_at: 2026-06-10T00:00:00Z",
      "generated_by: work-driver-prep",
      "source:",
      "  project: ship",
      "  phase: test",
      "repo: ship",
      "batches:",
      "  - id: 1",
      "    depends_on: []",
      "    streams: []",
      "  - id: 2",
      "    depends_on: [1, 99]",
      "    streams: []",
      "---",
    ].join("\n");
    const result = parseManifest(text);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    const error = result.errors.find((entry) =>
      entry.message.includes("depends_on references unknown batch id 99"),
    );
    expect(error?.line).toBeTypeOf("number");
    expect(error?.path).toBe("batches[1].depends_on");
  });

  it("rejects self-dependency", () => {
    const text = [
      "---",
      "driver_version: 1",
      "generated_at: 2026-06-10T00:00:00Z",
      "generated_by: work-driver-prep",
      "source:",
      "  project: ship",
      "  phase: test",
      "repo: ship",
      "batches:",
      "  - id: 1",
      "    depends_on: [1]",
      "    streams: []",
      "---",
    ].join("\n");
    const result = parseManifest(text);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    const error = result.errors.find((entry) =>
      entry.message.includes("batch 1 depends on itself"),
    );
    expect(error?.line).toBeTypeOf("number");
    expect(error?.path).toBe("batches[0].depends_on");
  });

  it("rejects a three-batch dependency cycle", () => {
    const text = [
      "---",
      "driver_version: 1",
      "generated_at: 2026-06-10T00:00:00Z",
      "generated_by: work-driver-prep",
      "source:",
      "  project: ship",
      "  phase: test",
      "repo: ship",
      "batches:",
      "  - id: 1",
      "    depends_on: [3]",
      "    streams: []",
      "  - id: 2",
      "    depends_on: [1]",
      "    streams: []",
      "  - id: 3",
      "    depends_on: [2]",
      "    streams: []",
      "---",
    ].join("\n");
    const result = parseManifest(text);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.some((error) => error.message.includes("dependency cycle detected"))).toBe(
      true,
    );
    expect(result.errors.some((error) => error.message.includes("1 → 3 → 2 → 1"))).toBe(true);
    const error = result.errors.find((entry) =>
      entry.message.includes("dependency cycle detected"),
    );
    expect(error?.line).toBeTypeOf("number");
    expect(error?.path).toBe("batches[0].depends_on");
  });
});

describe("parseManifest edge cases", () => {
  it("parses BOM-prefixed input identically to clean input", () => {
    const clean = minimalManifest();
    const withBom = `\ufeff${clean}`;
    const cleanResult = parseManifest(clean);
    const bomResult = parseManifest(withBom);
    expect(cleanResult.ok).toBe(true);
    expect(bomResult.ok).toBe(true);
    if (!cleanResult.ok || !bomResult.ok) {
      return;
    }
    expect(bomResult.manifest).toEqual(cleanResult.manifest);
  });

  it("parses CRLF input identically to LF input", () => {
    const lf = minimalManifest();
    const crlf = lf.replace(/\n/g, "\r\n");
    const lfResult = parseManifest(lf);
    const crlfResult = parseManifest(crlf);
    expect(lfResult.ok).toBe(true);
    expect(crlfResult.ok).toBe(true);
    if (!lfResult.ok || !crlfResult.ok) {
      return;
    }
    expect(crlfResult.manifest).toEqual(lfResult.manifest);
  });

  it("parses CRLF+BOM input", () => {
    const crlf = minimalManifest().replace(/\n/g, "\r\n");
    expectOk(`\ufeff${crlf}`);
  });
});

describe("parseManifest totality", () => {
  it("never throws on arbitrary string input", () => {
    const samples = [
      "",
      "---",
      "not yaml at all",
      "---\nfoo: [\n---",
      minimalManifest(),
      loadFixture("synthetic-full.driver.md"),
      "\x00\x01binary",
      "a".repeat(10_000),
    ];

    for (let index = 0; index < 200; index += 1) {
      const random = Array.from({ length: index }, () =>
        String.fromCharCode(32 + (index % 95)),
      ).join("");
      samples.push(random);
    }

    for (const sample of samples) {
      expect(() => parseManifest(sample)).not.toThrow();
    }
  });
});

function collectDriverManifests(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      results.push(...collectDriverManifests(fullPath));
      continue;
    }
    if (entry === "driver.md") {
      results.push(fullPath);
    }
  }
  return results;
}

describe("repo sweep — every in-tree docs/features/**/driver.md parses clean", () => {
  const manifests = collectDriverManifests(join(repoRoot, "docs/features"));

  it("finds at least one in-repo driver manifest", () => {
    expect(manifests.length).toBeGreaterThan(0);
  });

  it.each(manifests)("parses %s", (manifestPath) => {
    const text = readFileSync(manifestPath, "utf8");
    const result = parseManifest(text);
    const label = relative(repoRoot, manifestPath);
    if (!result.ok) {
      throw new Error(
        `${label} failed to parse:\n${result.errors.map((error) => error.message).join("\n")}`,
      );
    }
    expect(result.ok).toBe(true);
  });
});

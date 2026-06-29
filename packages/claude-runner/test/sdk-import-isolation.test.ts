/**
 * SDK isolation: both `@anthropic-ai/claude-agent-sdk` (local runner) and
 * `@anthropic-ai/sdk` (cloud Managed Agents runner) are imported in exactly one
 * package — `@ship/claude-runner`. No other package may name either SDK.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// `@anthropic-ai/sdk` allows subpaths (cloud-session.ts imports
// `@anthropic-ai/sdk/resources/...`); the `claude-agent-sdk` import is bare.
// The two are mutually exclusive — `@anthropic-ai/sdk` never matches
// `@anthropic-ai/claude-agent-sdk` (different package segment).
const SDKS = [
  {
    label: "@anthropic-ai/claude-agent-sdk",
    pattern:
      /\b(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["']@anthropic-ai\/claude-agent-sdk["']/,
  },
  {
    // Trailing `["'/]` matches a bare specifier (closing quote) or a subpath
    // (`@anthropic-ai/sdk/resources/...`) without a complexity-heavy nested group.
    label: "@anthropic-ai/sdk",
    pattern: /\b(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["']@anthropic-ai\/sdk["'/]/,
  },
] as const;

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = resolve(HERE, "..", "..");
const REPO_ROOT = resolve(PACKAGES_DIR, "..");

const ALLOWED_PACKAGE = "claude-runner";
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".turbo", ".tsbuildinfo"]);

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function listPackageDirs(): string[] {
  return readdirSync(PACKAGES_DIR)
    .map((name) => join(PACKAGES_DIR, name))
    .filter((p) => safeIsDir(p));
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function walkTsFiles(root: string): string[] {
  if (!safeIsDir(root)) return [];
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      handleDirent(entry, join(dir, entry.name), stack, out);
    }
  }
  return out;
}

function handleDirent(
  entry: { isDirectory(): boolean; isFile(): boolean; name: string },
  full: string,
  stack: string[],
  out: string[],
): void {
  if (entry.isDirectory()) {
    if (!SKIP_DIRS.has(entry.name)) stack.push(full);
    return;
  }
  if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
}

function findHits(filePath: string, pattern: RegExp): Hit[] {
  const content = readFileSync(filePath, "utf-8");
  const hits: Hit[] = [];
  const lines = content.split(/\r?\n/);
  for (const [idx, raw] of lines.entries()) {
    if (pattern.test(raw)) {
      hits.push({
        file: relative(REPO_ROOT, filePath).split(sep).join("/"),
        line: idx + 1,
        text: raw.trim(),
      });
    }
  }
  return hits;
}

describe("SDK isolation — provider SDKs are imported in @ship/claude-runner only", () => {
  for (const sdk of SDKS) {
    test(`no other package imports from ${sdk.label}`, () => {
      const packageDirs = listPackageDirs().filter((p) => p.split(sep).at(-1) !== ALLOWED_PACKAGE);
      const hits: Hit[] = [];
      for (const pkg of packageDirs) {
        for (const file of walkTsFiles(pkg)) {
          hits.push(...findHits(file, sdk.pattern));
        }
      }

      if (hits.length > 0) {
        const detail = hits.map((h) => `  ${h.file}:${String(h.line)}  ${h.text}`).join("\n");
        throw new Error(
          `SDK isolation violated: ${String(hits.length)} import(s) of ${sdk.label} found outside @ship/claude-runner:\n${detail}`,
        );
      }
      expect(hits).toEqual([]);
    });

    test(`sanity: walker finds ${sdk.label} imports in the allowed package`, () => {
      const claudeRunnerDir = join(PACKAGES_DIR, ALLOWED_PACKAGE);
      const ownHits = walkTsFiles(claudeRunnerDir).flatMap((f) => findHits(f, sdk.pattern));
      expect(ownHits.length).toBeGreaterThan(0);
    });
  }

  test("claude-runner src/index.ts only type-re-exports SDKMessage from claude-agent-sdk", () => {
    const indexPath = join(PACKAGES_DIR, ALLOWED_PACKAGE, "src", "index.ts");
    const content = readFileSync(indexPath, "utf-8");
    if (
      /export\s+(?!type\s)\{[^}]+\}\s*from\s*["']@anthropic-ai\/claude-agent-sdk["']/.test(content)
    ) {
      throw new Error(
        "value re-exports from @anthropic-ai/claude-agent-sdk are forbidden in index.ts",
      );
    }
    const names: string[] = [];
    const typeExportRe =
      /export\s+type\s*\{([^}]+)\}\s*from\s*["']@anthropic-ai\/claude-agent-sdk["']/g;
    let m: RegExpExecArray | null;
    while ((m = typeExportRe.exec(content)) !== null) {
      const chunk = m[1] ?? "";
      for (const part of chunk.split(",")) {
        const name = part.trim().split(/\s+/)[0];
        if (name !== undefined && name.length > 0) names.push(name);
      }
    }
    expect(new Set(names)).toEqual(new Set(["SDKMessage"]));
  });

  test("claude-runner src/index.ts does not re-export the base @anthropic-ai/sdk", () => {
    const indexPath = join(PACKAGES_DIR, ALLOWED_PACKAGE, "src", "index.ts");
    const content = readFileSync(indexPath, "utf-8");
    // The base SDK is isolated to cloud-session.ts; the barrel exposes only
    // CloudClaudeRunner + neutral types, never the SDK itself.
    const baseSdkPattern = /\bfrom\s*["']@anthropic-ai\/sdk["'/]/;
    expect(baseSdkPattern.test(content)).toBe(false);
  });
});

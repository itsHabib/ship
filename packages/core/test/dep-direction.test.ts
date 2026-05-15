/**
 * Dep-direction invariant: `@ship/core` must NOT import from
 * `@ship/cli` or `@ship/mcp-server`. Both packages depend on `core`;
 * the reverse is a circular reference. Static grep across `core/src`
 * + `core/test`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(HERE, "..");
const REPO_ROOT = resolve(PACKAGE_DIR, "..", "..");

const FORBIDDEN_PATTERNS: { pattern: RegExp; specifier: string }[] = [
  {
    pattern: /\b(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["']@ship\/cli["']/,
    specifier: "@ship/cli",
  },
  {
    pattern: /\b(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["']@ship\/mcp-server["']/,
    specifier: "@ship/mcp-server",
  },
];

const SCAN_ROOTS = ["src", "test"] as const;
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".turbo"]);

interface Hit {
  file: string;
  line: number;
  text: string;
  specifier: string;
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

// Stack-pushing branch for one readdir entry. Lifted out of walkTsFiles
// so the directory loop stays at max-depth 3 under strict lint.
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

function findHits(filePath: string): Hit[] {
  const content = readFileSync(filePath, "utf-8");
  const hits: Hit[] = [];
  const lines = content.split(/\r?\n/);
  for (const [idx, raw] of lines.entries()) {
    for (const { pattern, specifier } of FORBIDDEN_PATTERNS) {
      if (pattern.test(raw)) {
        hits.push({
          file: relative(REPO_ROOT, filePath).split(sep).join("/"),
          line: idx + 1,
          text: raw.trim(),
          specifier,
        });
      }
    }
  }
  return hits;
}

describe("dep direction — @ship/core does not import its consumers", () => {
  test("no imports of @ship/cli or @ship/mcp-server inside @ship/core", () => {
    const hits: Hit[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of walkTsFiles(join(PACKAGE_DIR, root))) {
        hits.push(...findHits(file));
      }
    }
    if (hits.length > 0) {
      const detail = hits
        .map((h) => `  ${h.file}:${String(h.line)}  [${h.specifier}]  ${h.text}`)
        .join("\n");
      throw new Error(
        `Dep-direction violated: ${String(hits.length)} import(s) inside @ship/core point at consumer packages:\n${detail}`,
      );
    }
    expect(hits).toEqual([]);
  });
});

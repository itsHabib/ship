/**
 * ED-2 enforcement: `@cursor/sdk` is imported in exactly one package.
 * Walks every `.ts` file under each `packages/*` (excluding this
 * package's own dir, plus `node_modules` / `dist` / coverage outputs)
 * and asserts none of them import from `@cursor/sdk` — any form
 * (static, type-only, side-effect, dynamic, require, export-from).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Catches every form: `from "..."`, `import "..."`, `import("...")`,
// `require("...")`, `export ... from "..."`. Bare keyword references
// in comments don't match (no quoted module specifier follows).
const SDK_IMPORT_PATTERN =
  /\b(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["']@cursor\/sdk["']/;

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = resolve(HERE, "..", "..");
const REPO_ROOT = resolve(PACKAGES_DIR, "..");

const ALLOWED_PACKAGE = "cursor-runner";
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
    if (SDK_IMPORT_PATTERN.test(raw)) {
      hits.push({
        file: relative(REPO_ROOT, filePath).split(sep).join("/"),
        line: idx + 1,
        text: raw.trim(),
      });
    }
  }
  return hits;
}

describe("ED-2 — @cursor/sdk is imported in @ship/cursor-runner only", () => {
  test("no other package imports from @cursor/sdk (any kind, including type-only)", () => {
    const packageDirs = listPackageDirs().filter((p) => p.split(sep).at(-1) !== ALLOWED_PACKAGE);
    const hits: Hit[] = [];
    for (const pkg of packageDirs) {
      for (const file of walkTsFiles(pkg)) {
        hits.push(...findHits(file));
      }
    }

    if (hits.length > 0) {
      const detail = hits.map((h) => `  ${h.file}:${String(h.line)}  ${h.text}`).join("\n");
      throw new Error(
        `ED-2 violated: ${String(hits.length)} import(s) of @cursor/sdk found outside @ship/cursor-runner:\n${detail}`,
      );
    }
    expect(hits).toEqual([]);
  });

  test("the test would catch a violation if one existed (sanity check on the scan)", () => {
    // Two-part: walker finds files AND finds at least one SDK import in
    // the allowed package. Both must hold for the scan to be trusted.
    const cursorRunnerDir = join(PACKAGES_DIR, ALLOWED_PACKAGE);
    const ownFiles = walkTsFiles(cursorRunnerDir);
    expect(ownFiles.length).toBeGreaterThan(0);
    const ownHits = ownFiles.flatMap(findHits);
    expect(ownHits.length).toBeGreaterThan(0);
  });

  test("cursor-runner src/index.ts only type-re-exports the allowlisted @cursor/sdk names", () => {
    const indexPath = join(PACKAGES_DIR, ALLOWED_PACKAGE, "src", "index.ts");
    const content = readFileSync(indexPath, "utf-8");
    if (/export\s+(?!type\s)\{[^}]+\}\s*from\s*["']@cursor\/sdk["']/.test(content)) {
      throw new Error("ED-3 violated: value re-exports from @cursor/sdk are forbidden in index.ts");
    }
    const names: string[] = [];
    const typeExportRe = /export\s+type\s*\{([^}]+)\}\s*from\s*["']@cursor\/sdk["']/g;
    let m: RegExpExecArray | null;
    while ((m = typeExportRe.exec(content)) !== null) {
      const chunk = m[1] ?? "";
      for (const part of chunk.split(",")) {
        const name = part.trim().split(/\s+/)[0];
        if (name !== undefined && name.length > 0) names.push(name);
      }
    }
    const allowed = new Set(["AgentDefinition", "McpServerConfig", "SDKMessage"]);
    expect(new Set(names)).toEqual(allowed);
  });

  test("regex catches every import form (static / type-only / side-effect / dynamic / require / export-from)", () => {
    const samples: { line: string; shouldMatch: boolean }[] = [
      { line: `import { Agent } from "@cursor/sdk";`, shouldMatch: true },
      { line: `import type { SDKMessage } from "@cursor/sdk";`, shouldMatch: true },
      { line: `import * as sdk from "@cursor/sdk";`, shouldMatch: true },
      { line: `import "@cursor/sdk";`, shouldMatch: true },
      { line: `const m = import("@cursor/sdk");`, shouldMatch: true },
      { line: `const m = await import( "@cursor/sdk" );`, shouldMatch: true },
      { line: `const m = require("@cursor/sdk");`, shouldMatch: true },
      { line: `export { Agent } from "@cursor/sdk";`, shouldMatch: true },
      { line: `export type { SDKMessage } from "@cursor/sdk";`, shouldMatch: true },
      { line: `import { Agent } from '@cursor/sdk';`, shouldMatch: true },
      { line: ` * Structurally mirrors \`@cursor/sdk\`'s exported type.`, shouldMatch: false },
      { line: `// see @cursor/sdk for details`, shouldMatch: false },
      { line: `const label = "@cursor/sdk";`, shouldMatch: false },
      { line: `import { foo } from "@ship/cursor-runner";`, shouldMatch: false },
    ];
    for (const s of samples) {
      expect({ line: s.line, matched: SDK_IMPORT_PATTERN.test(s.line) }).toEqual({
        line: s.line,
        matched: s.shouldMatch,
      });
    }
  });
});

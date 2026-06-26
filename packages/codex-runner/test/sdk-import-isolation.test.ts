/**
 * SDK isolation: `@openai/codex-sdk` and `@openai/codex` are imported in exactly one package.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const SDK_IMPORT_PATTERN =
  /\b(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["']@openai\/codex(?:-sdk)?["']/;

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = resolve(HERE, "..", "..");
const REPO_ROOT = resolve(PACKAGES_DIR, "..");

const ALLOWED_PACKAGE = "codex-runner";
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

describe("SDK isolation — @openai/codex-sdk is imported in @ship/codex-runner only", () => {
  test("no other package imports from @openai/codex-sdk or @openai/codex", () => {
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
        `SDK isolation violated: ${String(hits.length)} import(s) of @openai/codex* found outside @ship/codex-runner:\n${detail}`,
      );
    }
    expect(hits).toEqual([]);
  });

  test("sanity: walker finds SDK imports in the allowed package", () => {
    const codexRunnerDir = join(PACKAGES_DIR, ALLOWED_PACKAGE);
    const ownFiles = walkTsFiles(codexRunnerDir);
    expect(ownFiles.length).toBeGreaterThan(0);
    const ownHits = ownFiles.flatMap(findHits);
    expect(ownHits.length).toBeGreaterThan(0);
  });

  test("codex-runner src/index.ts only type-re-exports ThreadEvent", () => {
    const indexPath = join(PACKAGES_DIR, ALLOWED_PACKAGE, "src", "index.ts");
    const content = readFileSync(indexPath, "utf-8");
    if (/export\s+(?!type\s)\{[^}]+\}\s*from\s*["']@openai\/codex-sdk["']/.test(content)) {
      throw new Error("value re-exports from @openai/codex-sdk are forbidden in index.ts");
    }
    const names: string[] = [];
    const typeExportRe = /export\s+type\s*\{([^}]+)\}\s*from\s*["']@openai\/codex-sdk["']/g;
    let m: RegExpExecArray | null;
    while ((m = typeExportRe.exec(content)) !== null) {
      const chunk = m[1] ?? "";
      for (const part of chunk.split(",")) {
        const name = part.trim().split(/\s+/)[0];
        if (name !== undefined && name.length > 0) names.push(name);
      }
    }
    expect(new Set(names)).toEqual(new Set(["ThreadEvent"]));
  });
});

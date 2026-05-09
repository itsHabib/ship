/**
 * ED-2 enforcement: `@cursor/sdk` is imported in exactly one package.
 *
 * The whole point of `@ship/cursor-runner` is that the SDK is invisible
 * to the rest of the monorepo. This test walks every TypeScript file
 * under each `packages/*` directory (excluding this package's own dir,
 * plus `node_modules` / `dist` / coverage outputs) and asserts none of
 * them mention `@cursor/sdk` — including type-only imports and
 * including top-level config files (`vitest.config.ts`, etc.) that
 * aren't under `src/` or `test/`.
 *
 * Why "any kind" rather than "runtime only": even type-only imports
 * couple the importing package to the SDK's release cadence. A mirror
 * type lives in `@ship/workflow` already (`ModelSelection`); SDK
 * envelopes (`SDKMessage`, `McpServerConfig`) are re-exported from
 * `@ship/cursor-runner`'s barrel. Other packages reach those re-exports
 * via `@ship/cursor-runner` imports — never via direct SDK imports —
 * which keeps the SDK seam at one filename.
 *
 * Why a static grep rather than a TS-program-based check: simpler, no
 * tsc invocation needed, and the grep pattern is the literal contract
 * we want enforced. False positives are easy to spot (the matched
 * line + path is included in the assertion message).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const SDK_IMPORT_PATTERN = /from\s+["']@cursor\/sdk["']/;

// Repo root (this file is at <root>/packages/cursor-runner/test/...)
const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = resolve(HERE, "..", "..");
const REPO_ROOT = resolve(PACKAGES_DIR, "..");

const ALLOWED_PACKAGE = "cursor-runner";

// Directories within a package we never walk (build artifacts, deps,
// editor caches). Anything else with a `.ts` file is fair game.
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
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        out.push(full);
      }
    }
  }
  return out;
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
    // Self-test: if we scan our own package, we DO find SDK imports
    // (in `runner.ts`, `index.ts`, etc.). This guards against the scan
    // silently returning [] due to a bug in the walker.
    const cursorRunnerDir = join(PACKAGES_DIR, ALLOWED_PACKAGE);
    const ownHits = walkTsFiles(cursorRunnerDir).flatMap(findHits);
    expect(ownHits.length).toBeGreaterThan(0);
  });
});

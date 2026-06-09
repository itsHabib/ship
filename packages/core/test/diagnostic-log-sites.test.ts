// Grep guard: no ad-hoc console.* or diagnostic process.stderr.write in
// production packages/*/src outside @ship/logger and CLI user-facing exits.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const PACKAGES_DIR = join(REPO_ROOT, "packages");

const CONSOLE_PATTERN = /\bconsole\.(debug|info|log|warn|error)\s*\(/;
const STDERR_WRITE_PATTERN = /\bprocess\.stderr\.write\s*\(/;

/** Paths allowed to use raw stderr for user-facing output (not diagnostics). */
const STDERR_WRITE_ALLOWLIST = new Set([
  "packages/cli/src/bin.ts",
  "packages/cli/src/commands/artifacts.ts",
  "packages/cli/src/commands/cancel.ts",
  "packages/cli/src/commands/list.ts",
  "packages/cli/src/commands/ship.ts",
  "packages/cli/src/commands/status.ts",
  "packages/receipt/src/bin.ts",
]);

const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".turbo"]);

interface Hit {
  file: string;
  line: number;
  text: string;
  kind: "console" | "stderr.write";
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function collectTsFiles(dir: string, out: string[]): void {
  if (!safeIsDir(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectTsFiles(full, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
}

function relPosix(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join("/");
}

function isAllowlistedStderrWrite(relPath: string): boolean {
  if (STDERR_WRITE_ALLOWLIST.has(relPath)) return true;
  if (relPath.startsWith("packages/cli/src/commands/")) return true;
  return false;
}

function scanFile(filePath: string): Hit[] {
  const rel = relPosix(filePath);
  if (!rel.startsWith("packages/") || !rel.includes("/src/")) return [];
  if (rel.startsWith("packages/logger/")) return [];

  const hits: Hit[] = [];
  const lines = readFileSync(filePath, "utf-8").split(/\r?\n/);
  for (const [idx, raw] of lines.entries()) {
    if (CONSOLE_PATTERN.test(raw)) {
      hits.push({ file: rel, line: idx + 1, text: raw.trim(), kind: "console" });
    }
    if (STDERR_WRITE_PATTERN.test(raw) && !isAllowlistedStderrWrite(rel)) {
      hits.push({ file: rel, line: idx + 1, text: raw.trim(), kind: "stderr.write" });
    }
  }
  return hits;
}

function collectPackageSrcHits(): Hit[] {
  const hits: Hit[] = [];
  for (const pkgDir of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!pkgDir.isDirectory()) continue;
    const files: string[] = [];
    collectTsFiles(join(PACKAGES_DIR, pkgDir.name, "src"), files);
    for (const file of files) {
      hits.push(...scanFile(file));
    }
  }
  return hits;
}

describe("diagnostic log sites — no ad-hoc console or stderr.write", () => {
  test("packages/*/src uses @ship/logger instead of console.* / stray stderr.write", () => {
    const hits = collectPackageSrcHits();
    if (hits.length > 0) {
      const detail = hits
        .map((h) => `  ${h.file}:${String(h.line)} [${h.kind}] ${h.text}`)
        .join("\n");
      throw new Error(`Ad-hoc diagnostic logging found:\n${detail}`);
    }
    expect(hits).toEqual([]);
  });
});

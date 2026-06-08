#!/usr/bin/env node
/**
 * `ship-receipt` CLI — backfill + query the run-receipt dataset.
 *
 *   ship-receipt build  [--manifest <p>]... [--manifests-dir <d>] \
 *                       [--runs-dir <d>] [--no-runs] [--out <f>]
 *   ship-receipt report [--in <f>]
 *
 * `build` is idempotent: it upserts into the existing JSONL keyed on
 * `${source}:${key}`, so re-running over the same artifacts never duplicates a
 * row. This module is the IO/argv shell; all logic lives in the tested core.
 */

import type { Dirent } from "node:fs";

import { readdirSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { upsertReceipts } from "./build.js";
import { readReceiptsFile, writeReceiptsFile } from "./jsonl.js";
import { manifestToReceipts } from "./manifest.js";
import { formatReport, report } from "./report.js";
import { loadShipRunReceipts, resolveDefaultRunsDir } from "./runs.js";

const DEFAULT_OUT = "receipts.jsonl";
const SKIP_DIRS = new Set(["node_modules", ".git", ".claude", ".worktrees", "dist", "coverage"]);

function main(argv: string[]): void {
  const [command, ...rest] = argv;
  if (command === "build") {
    runBuild(rest);
    return;
  }
  if (command === "report") {
    runReport(rest);
    return;
  }
  process.stderr.write(usage());
  process.exitCode = command === undefined || command === "-h" || command === "--help" ? 0 : 1;
}

function runBuild(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      manifest: { type: "string", multiple: true },
      "manifests-dir": { type: "string" },
      "runs-dir": { type: "string" },
      "no-runs": { type: "boolean" },
      out: { type: "string", default: DEFAULT_OUT },
    },
  });

  const out = values.out;
  const manifestPaths = collectManifestPaths(values.manifest ?? [], values["manifests-dir"]);
  const driverReceipts = manifestPaths.flatMap((path) => manifestToReceipts(readText(path)));
  const runReceipts =
    values["no-runs"] === true ? [] : loadShipRunReceipts(runsDir(values["runs-dir"]));

  const merged = upsertReceipts(readReceiptsFile(out), [...driverReceipts, ...runReceipts]);
  writeReceiptsFile(out, merged);
  process.stdout.write(
    `wrote ${String(merged.length)} receipts to ${out} (driver ${String(driverReceipts.length)}, ship-run ${String(runReceipts.length)})\n`,
  );
}

function runReport(args: string[]): void {
  const { values } = parseArgs({ args, options: { in: { type: "string", default: DEFAULT_OUT } } });
  const receipts = readReceiptsFile(values.in);
  process.stdout.write(`${formatReport(report(receipts))}\n`);
}

function runsDir(override: string | undefined): string {
  if (override !== undefined && override !== "") {
    return override;
  }
  return resolveDefaultRunsDir(process.env, platform(), homedir());
}

function collectManifestPaths(explicit: string[], dir: string | undefined): string[] {
  const fromDir = dir === undefined ? [] : findDriverManifests(dir);
  return [...new Set([...explicit, ...fromDir])];
}

function findDriverManifests(root: string): string[] {
  const found: string[] = [];
  walkForManifests(root, found);
  return found.sort((left, right) => left.localeCompare(right));
}

function walkForManifests(dir: string, found: string[]): void {
  for (const entry of safeReaddir(dir)) {
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
      walkForManifests(join(dir, entry.name), found);
    }
    if (entry.isFile() && entry.name === "driver.md") {
      found.push(join(dir, entry.name));
    }
  }
}

function safeReaddir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function usage(): string {
  return [
    "ship-receipt — backfill + query the workbench run-receipt dataset",
    "",
    "  ship-receipt build  [--manifest <p>]... [--manifests-dir <d>] [--runs-dir <d>] [--no-runs] [--out <f>]",
    "  ship-receipt report [--in <f>]",
    "",
  ].join("\n");
}

main(process.argv.slice(2));

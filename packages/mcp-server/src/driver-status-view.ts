/**
 * Shared driver status view builder for MCP tools (mirrors CLI format layer).
 */

import type { DriverStatusOutput } from "@ship/mcp";
import type { DriverRun } from "@ship/store";

import { parseManifest } from "@ship/driver";
import { existsSync, readFileSync } from "node:fs";

export function buildDriverStatusView(run: DriverRun): DriverStatusOutput {
  const view: DriverStatusOutput = {
    batches: run.batches,
    driverRunId: run.id,
    importedAt: run.createdAt,
    manifestPath: run.manifestPath,
    repo: run.repo,
    status: run.status,
  };
  if (run.project !== undefined) view.project = run.project;
  if (run.phase !== undefined) view.phase = run.phase;
  if (detectManifestModified(run)) {
    view.manifestModified = true;
  }
  return view;
}

function detectManifestModified(run: DriverRun): boolean {
  if (!existsSync(run.manifestPath)) {
    return false;
  }
  const stored = parseManifest(run.sourceJson);
  if (!stored.ok) {
    return false;
  }
  let onDiskText: string;
  try {
    onDiskText = readFileSync(run.manifestPath, "utf8");
  } catch {
    return false;
  }
  const onDisk = parseManifest(onDiskText);
  if (!onDisk.ok) {
    return false;
  }
  return stored.rawFrontmatter !== onDisk.rawFrontmatter;
}

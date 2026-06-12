/**
 * Manifest-on-disk vs store helpers for `ship driver status`.
 */

import type { DriverRun } from "@ship/store";

import { parseManifest } from "@ship/driver";
import { existsSync, readFileSync } from "node:fs";

/** True when the on-disk manifest frontmatter differs from the imported copy. */
export function detectManifestDrift(run: DriverRun): boolean {
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
    // A readable manifest that no longer parses was necessarily edited.
    return true;
  }

  return stored.rawFrontmatter !== onDisk.rawFrontmatter;
}

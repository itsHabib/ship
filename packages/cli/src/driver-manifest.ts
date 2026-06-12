/**
 * Manifest-on-disk vs store helpers for `ship driver status`.
 */

import type { DriverRun } from "@ship/store";

import { parseManifest } from "@ship/driver";
import { existsSync, readFileSync } from "node:fs";

export interface ManifestDrift {
  /** Present only when the on-disk frontmatter differs from import. */
  manifestModified?: true;
  importedAt: string;
}

/** Compare stored `source_json` frontmatter to the file at `manifestPath`. */
export function detectManifestDrift(run: DriverRun): ManifestDrift | undefined {
  const importedAt = run.createdAt;
  if (!existsSync(run.manifestPath)) {
    return { importedAt };
  }

  const stored = parseManifest(run.sourceJson);
  if (!stored.ok) {
    return { importedAt };
  }

  let onDiskText: string;
  try {
    onDiskText = readFileSync(run.manifestPath, "utf8");
  } catch {
    return { importedAt };
  }

  const onDisk = parseManifest(onDiskText);
  if (!onDisk.ok) {
    return { importedAt };
  }

  if (stored.rawFrontmatter === onDisk.rawFrontmatter) {
    return { importedAt };
  }

  return { importedAt, manifestModified: true };
}

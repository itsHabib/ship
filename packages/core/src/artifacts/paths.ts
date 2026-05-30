/**
 * Per-run artifact paths. Spec.md § ED-4 pins the layout; this file
 * is the only place those names live in code.
 */

import { isAbsolute, join, resolve } from "node:path";

import type { ShipFs } from "../fs/shape.js";

import { ArtifactPathEscapesRunDirError } from "../errors.js";
import { isDescendantPath } from "../validate.js";

/** File names inside `<runsDir>/<workflowRunId>/`. */
export const ARTIFACT_FILES = {
  prompt: "prompt.md",
  taskDoc: "task-doc.md",
  events: "events.ndjson",
  result: "result.json",
  summary: "summary.md",
} as const;

export type ArtifactName = keyof typeof ARTIFACT_FILES;

export interface RunArtifactPaths {
  readonly dir: string;
  readonly prompt: string;
  readonly taskDoc: string;
  readonly events: string;
  readonly result: string;
  readonly summary: string;
}

export function resolveRunArtifactsDir(runsDir: string, workflowRunId: string): string {
  return join(runsDir, workflowRunId);
}

export function resolveRunArtifactPaths(runsDir: string, workflowRunId: string): RunArtifactPaths {
  const dir = resolveRunArtifactsDir(runsDir, workflowRunId);
  return {
    dir,
    prompt: join(dir, ARTIFACT_FILES.prompt),
    taskDoc: join(dir, ARTIFACT_FILES.taskDoc),
    events: join(dir, ARTIFACT_FILES.events),
    result: join(dir, ARTIFACT_FILES.result),
    summary: join(dir, ARTIFACT_FILES.summary),
  };
}

/** Subdirectory under `<runsDir>/<workflowRunId>/` for downloaded cloud blobs. */
export const CLOUD_ARTIFACT_SUBDIR = "artifacts";

export function resolveCloudArtifactsRoot(runsDir: string, workflowRunId: string): string {
  return join(resolveRunArtifactsDir(runsDir, workflowRunId), CLOUD_ARTIFACT_SUBDIR);
}

/**
 * Lexical destination for a cloud SDK `path` under the run's artifacts root.
 * Does not create directories; rejects absolute paths and `..` segments (F4).
 */
/** Lexical path for `sdkPath` under an artifacts root directory. */
export function resolveCloudArtifactDestUnderRoot(artifactsRoot: string, sdkPath: string): string {
  assertSafeCloudArtifactPath(sdkPath);
  const segments = sdkPath
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s.length > 0 && s !== ".");
  return resolve(artifactsRoot, ...segments);
}

export function resolveCloudArtifactDest(
  runsDir: string,
  workflowRunId: string,
  sdkPath: string,
): string {
  return resolveCloudArtifactDestUnderRoot(
    resolveCloudArtifactsRoot(runsDir, workflowRunId),
    sdkPath,
  );
}

export function assertSafeCloudArtifactPath(sdkPath: string): void {
  if (isAbsolute(sdkPath) || sdkPath.replace(/\\/g, "/").split("/").includes("..")) {
    throw new ArtifactPathEscapesRunDirError(sdkPath);
  }
}

/**
 * Ensures `sdkPath` resolves under the realpath'd artifacts root (F4). Returns
 * the lexical destination path for mkdir/write (destination may not exist yet).
 */
export async function resolveContainedCloudArtifactDest(
  fs: ShipFs,
  runsDir: string,
  workflowRunId: string,
  sdkPath: string,
): Promise<string> {
  const dest = resolveCloudArtifactDest(runsDir, workflowRunId, sdkPath);
  const root = resolveCloudArtifactsRoot(runsDir, workflowRunId);
  await fs.mkdir(root, { recursive: true });
  // `dest` is `resolve()`'d (absolute, OS-native separators, drive-qualified
  // on Windows). Resolve the realpath'd root the same way so the containment
  // check compares like-for-like: a drive-less `runsDir` makes `resolve()`
  // inject the cwd drive onto `dest` but not onto a raw `realpath`, which
  // would false-positive a valid path as an escape on Windows.
  const realRoot = resolve(await fs.realpath(root));
  if (!isDescendantPath(dest, realRoot)) {
    throw new ArtifactPathEscapesRunDirError(sdkPath);
  }
  return dest;
}

/** Default preflight cap for cloud artifact downloads (ED-5). */
export const DEFAULT_ARTIFACT_MAX_BYTES = 100 * 1024 * 1024;

/**
 * Per-run artifact paths. Spec.md § ED-4 pins the layout; this file
 * is the only place those names live in code.
 */

import { isAbsolute, join, relative, resolve } from "node:path";

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
  const root = resolveCloudArtifactsRoot(runsDir, workflowRunId);
  return resolveContainedCloudArtifactDestUnderRoot(fs, root, sdkPath);
}

/** Containment check for a custom artifacts root (e.g. `download --out`). */
export async function resolveContainedCloudArtifactDestUnderRoot(
  fs: ShipFs,
  artifactsRoot: string,
  sdkPath: string,
): Promise<string> {
  const dest = resolveCloudArtifactDestUnderRoot(artifactsRoot, sdkPath);
  await fs.mkdir(artifactsRoot, { recursive: true });
  await assertContainedCloudArtifactDest(fs, artifactsRoot, dest, sdkPath);
  return dest;
}

/**
 * Rejects destinations whose lexical path or any existing intermediate
 * segment resolves outside the realpath'd artifacts root (symlink escape).
 */
export async function assertContainedCloudArtifactDest(
  fs: ShipFs,
  artifactsRoot: string,
  dest: string,
  sdkPath: string,
): Promise<void> {
  // `dest` is `resolve()`'d (absolute, OS-native separators, drive-qualified
  // on Windows). Resolve the realpath'd root the same way so the containment
  // check compares like-for-like: a drive-less `runsDir` makes `resolve()`
  // inject the cwd drive onto `dest` but not onto a raw `realpath`, which
  // would false-positive a valid path as an escape on Windows.
  const realRoot = resolve(await fs.realpath(artifactsRoot));
  const resolvedDest = resolve(dest);
  if (!isDescendantPath(resolvedDest, realRoot)) {
    throw new ArtifactPathEscapesRunDirError(sdkPath);
  }
  await assertExistingPrefixContained(fs, realRoot, resolvedDest, sdkPath);
}

// True when the entry exists per `lstat` (no symlink follow). Used to tell a
// genuinely-missing path apart from a dangling/broken link that `stat` (which
// follows) reports as missing.
async function existsUnfollowed(fs: ShipFs, path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function assertExistingPrefixContained(
  fs: ShipFs,
  realRoot: string,
  dest: string,
  sdkPath: string,
): Promise<void> {
  const rel = relative(realRoot, dest);
  if (rel.length === 0 || rel === ".") return;

  const segments = rel.split(/[/\\]/).filter((s) => s.length > 0 && s !== ".");
  let cursor = realRoot;
  for (const segment of segments) {
    cursor = join(cursor, segment);
    try {
      await fs.stat(cursor);
    } catch {
      // `stat` follows symlinks, so it throws for both a genuinely-missing entry
      // and a dangling link. If `lstat` still sees an entry here, it's a link
      // `stat` couldn't resolve — writing through it could escape the root, so
      // reject rather than treat it as a fresh path under the root.
      if (await existsUnfollowed(fs, cursor)) {
        throw new ArtifactPathEscapesRunDirError(sdkPath);
      }
      return;
    }
    const realCursor = resolve(await fs.realpath(cursor));
    if (!isDescendantPath(realCursor, realRoot)) {
      throw new ArtifactPathEscapesRunDirError(sdkPath);
    }
  }
}

/** Default preflight cap for cloud artifact downloads (ED-5). */
export const DEFAULT_ARTIFACT_MAX_BYTES = 100 * 1024 * 1024;

/**
 * Pre-run validation for `ship()` inputs — workdir existence, docPath
 * resolves to a readable file inside the workdir, no symlink escape.
 */

import { isAbsolute } from "node:path";

import type { DocSource } from "./doc-source/doc-source.js";
import type { ShipFs } from "./fs/shape.js";

import { splitRepoSlug } from "./doc-source/parse-github-url.js";
import {
  DocNotFoundError,
  DocPathEscapesWorkdirError,
  RemoteDocFetchError,
  WorkdirNotFoundError,
} from "./errors.js";

export interface ValidatedDoc {
  /** Absolute path of the resolved doc, post-realpath (local hit). */
  readonly absoluteDocPath: string;
  /** Set on remote fetch — embedded directly; local hits leave this undefined. */
  readonly content?: string;
}

/** Options for cloud doc resolution (local-first, remote-fallback). */
export interface CloudDocResolveOptions {
  readonly workdir?: string;
  /** `owner/repo` slug when known. */
  readonly repoSlug?: string;
  readonly startingRef?: string;
  readonly prUrl?: string;
  readonly workOnCurrentBranch?: boolean;
  readonly docSource?: DocSource;
}

/**
 * Validates a task doc for cloud runs — local-first, remote-fallback.
 * Local hit: returns realpath with no `content`. Remote hit: returns
 * repo-relative `absoluteDocPath` + fetched `content`.
 */
export async function resolveValidatedDocForCloud(
  fs: ShipFs,
  docPath: string,
  options: CloudDocResolveOptions = {},
): Promise<ValidatedDoc> {
  const localPath = await tryResolveLocalDoc(fs, docPath, options.workdir);
  if (localPath !== undefined) {
    return { absoluteDocPath: localPath };
  }

  const { docSource, repoSlug } = options;
  if (repoSlug === undefined || docSource === undefined) {
    throw new DocNotFoundError(docPath, { cloud: true });
  }

  return resolveRemoteDoc(docPath, repoSlug, docSource, options);
}

async function resolveRemoteDoc(
  docPath: string,
  repoSlug: string,
  docSource: DocSource,
  options: CloudDocResolveOptions,
): Promise<ValidatedDoc> {
  const { owner, repo } = splitRepoSlug(repoSlug);
  let ref: string;
  try {
    ref = await docSource.resolveRef(buildResolveRefParams(owner, repo, options));
  } catch (err) {
    // Preserve a token hint from ref resolution (e.g. auth failure on the
    // default-branch lookup), mirroring the fetch catch below.
    if (err instanceof RemoteDocFetchError && err.suggestToken) {
      throw err;
    }
    throw toCloudDocNotFound(docPath, repoSlug, "(ref unresolved)", err);
  }

  try {
    const content = await docSource.fetch({ owner, repo, path: docPath, ref });
    return { absoluteDocPath: docPath, content };
  } catch (err) {
    if (err instanceof RemoteDocFetchError && err.suggestToken) {
      throw err;
    }
    if (err instanceof RemoteDocFetchError) {
      throw new DocNotFoundError(docPath, {
        cloudBothMiss: { repoSlug, ref, remoteReason: err.message },
      });
    }
    throw toCloudDocNotFound(docPath, repoSlug, ref, err);
  }
}

function buildResolveRefParams(
  owner: string,
  repo: string,
  options: CloudDocResolveOptions,
): Parameters<DocSource["resolveRef"]>[0] {
  return {
    owner,
    repo,
    ...(options.startingRef !== undefined ? { startingRef: options.startingRef } : {}),
    ...(options.prUrl !== undefined ? { prUrl: options.prUrl } : {}),
    ...(options.workOnCurrentBranch !== undefined
      ? { workOnCurrentBranch: options.workOnCurrentBranch }
      : {}),
  };
}

function toCloudDocNotFound(
  docPath: string,
  repoSlug: string,
  ref: string,
  err: unknown,
): DocNotFoundError {
  const remoteReason = err instanceof Error ? err.message : String(err);
  return new DocNotFoundError(docPath, {
    cloudBothMiss: { repoSlug, ref, remoteReason },
  });
}

async function tryResolveLocalDoc(
  fs: ShipFs,
  docPath: string,
  workdir?: string,
): Promise<string | undefined> {
  let candidate = docPath;
  if (!isAbsolute(docPath) && workdir !== undefined) {
    candidate = joinPath(workdir, docPath);
  }
  try {
    const stat = await fs.stat(candidate);
    if (!stat.isFile()) return undefined;
    return await fs.realpath(candidate);
  } catch {
    return undefined;
  }
}

/**
 * Validates `workdir` exists as a directory, the doc resolves to a
 * file inside it (absolute `docPath` is allowed if it lands inside
 * `workdir`'s realpath), and the realpath of the doc is a descendant
 * of the realpath of the workdir. Throws typed errors per `errors.ts`.
 *
 * Uses string-concat rather than `path.resolve` to compose the full
 * doc path so the memory FS (POSIX-canonical) and platform-native
 * Node FS both work without drive-letter rewriting. Returns the
 * realpath'd absolute doc path so downstream `readFile` calls hit the
 * canonical target — closes a small TOCTOU window between the
 * symlink check and the read.
 */
export async function resolveValidatedDoc(
  fs: ShipFs,
  workdir: string,
  docPath: string,
): Promise<ValidatedDoc> {
  await assertDirectory(fs, workdir);

  const candidate = isAbsolute(docPath) ? docPath : joinPath(workdir, docPath);
  await assertFile(fs, candidate, docPath);

  const realWorkdir = await fs.realpath(workdir);
  const realDoc = await fs.realpath(candidate);

  if (!isDescendantPath(realDoc, realWorkdir)) {
    throw new DocPathEscapesWorkdirError(workdir, docPath);
  }

  return { absoluteDocPath: realDoc };
}

function joinPath(workdir: string, relative: string): string {
  const trailingSep = workdir.endsWith("/") || workdir.endsWith("\\");
  const sep = workdir.includes("\\") && !workdir.includes("/") ? "\\" : "/";
  return trailingSep ? `${workdir}${relative}` : `${workdir}${sep}${relative}`;
}

async function assertDirectory(fs: ShipFs, path: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(path);
  } catch {
    throw new WorkdirNotFoundError(path);
  }
  if (!stat.isDirectory()) throw new WorkdirNotFoundError(path);
}

async function assertFile(
  fs: ShipFs,
  absolutePath: string,
  originalDocPath: string,
): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(absolutePath);
  } catch {
    throw new DocNotFoundError(originalDocPath);
  }
  if (!stat.isFile()) throw new DocNotFoundError(originalDocPath);
}

/** True when `descendant` is `ancestor` or a path under it (prefix-safe). */
export function isDescendantPath(descendant: string, ancestor: string): boolean {
  // Normalize trailing separators on the ancestor so `/foo` doesn't
  // match `/foobar`. The descendant's prefix must equal `ancestor +
  // separator` OR equal `ancestor` itself (the doc IS the workdir;
  // pathological but covered).
  if (descendant === ancestor) return true;
  const withSep = ancestor.endsWith("/") || ancestor.endsWith("\\") ? ancestor : `${ancestor}/`;
  const withWinSep = ancestor.endsWith("\\") ? ancestor : `${ancestor}\\`;
  return descendant.startsWith(withSep) || descendant.startsWith(withWinSep);
}

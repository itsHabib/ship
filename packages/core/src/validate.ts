/**
 * Pre-run validation for `ship()` inputs — workdir existence, docPath
 * resolves to a readable file inside the workdir, no symlink escape.
 */

import { isAbsolute } from "node:path";

import type { ShipFs } from "./fs/shape.js";

import { DocNotFoundError, DocPathEscapesWorkdirError, WorkdirNotFoundError } from "./errors.js";

export interface ValidatedDoc {
  /** Absolute path of the resolved doc, post-realpath. */
  readonly absoluteDocPath: string;
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
export async function validateWorkdirAndDoc(
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

function isDescendantPath(descendant: string, ancestor: string): boolean {
  // Normalize trailing separators on the ancestor so `/foo` doesn't
  // match `/foobar`. The descendant's prefix must equal `ancestor +
  // separator` OR equal `ancestor` itself (the doc IS the workdir;
  // pathological but covered).
  if (descendant === ancestor) return true;
  const withSep = ancestor.endsWith("/") || ancestor.endsWith("\\") ? ancestor : `${ancestor}/`;
  const withWinSep = ancestor.endsWith("\\") ? ancestor : `${ancestor}\\`;
  return descendant.startsWith(withSep) || descendant.startsWith(withWinSep);
}

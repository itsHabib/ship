/**
 * Typed errors thrown by `ShipService`. Pre-run failures (workdir
 * missing, doc invalid) reject `ship()`; post-run-creation failures
 * resolve `ship()` with `ShipOutput.status === "failed"` instead.
 */

export class WorkdirNotFoundError extends Error {
  override readonly name = "WorkdirNotFoundError";
  readonly workdir: string;

  constructor(workdir: string) {
    super(`workdir not found or not a directory: ${workdir}`);
    this.workdir = workdir;
  }
}

export class DocNotFoundError extends Error {
  override readonly name = "DocNotFoundError";
  readonly docPath: string;

  constructor(docPath: string) {
    super(`task doc not found or not a file: ${docPath}`);
    this.docPath = docPath;
  }
}

export class DocPathEscapesWorkdirError extends Error {
  override readonly name = "DocPathEscapesWorkdirError";
  readonly workdir: string;
  readonly docPath: string;

  constructor(workdir: string, docPath: string) {
    super(`docPath resolves outside workdir: workdir=${workdir} docPath=${docPath}`);
    this.workdir = workdir;
    this.docPath = docPath;
  }
}

/** Wraps an underlying fs failure during a post-run-creation artifact write. */
export class ArtifactWriteFailedError extends Error {
  override readonly name = "ArtifactWriteFailedError";
}

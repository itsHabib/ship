/**
 * Typed errors thrown by `ShipService`. Pre-run failures (workdir
 * missing, doc invalid) reject `ship()`; post-run-creation failures
 * resolve `ship()` with `ShipOutput.status === "failed"` instead.
 */

/** Constructed without `cloudCursor` when `input.runtime === "cloud"`. */
export class CloudRunnerNotConfiguredError extends Error {
  override readonly name = "CloudRunnerNotConfiguredError";

  constructor() {
    super("ShipService was constructed without cloudCursor; runtime: 'cloud' cannot be dispatched");
  }
}

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

  constructor(docPath: string, opts?: { readonly cloudBothMiss?: CloudDocBothMissContext }) {
    if (opts?.cloudBothMiss !== undefined) {
      const { repoSlug, ref, remoteReason } = opts.cloudBothMiss;
      const remoteDetail =
        remoteReason !== undefined ? `; not in ${repoSlug}@${ref} (${remoteReason})` : "";
      super(
        `task doc not found locally or remotely: ${docPath} (not on local filesystem${remoteDetail}). ` +
          "For cloud runs without a local copy, commit the doc to the branch or pass workdir with the file locally.",
      );
    } else {
      super(
        `task doc not found or not a file: ${docPath}. ` +
          "For cloud runs, commit the doc to the repo branch or pass a local workdir containing it.",
      );
    }
    this.docPath = docPath;
  }
}

/** Context for the cloud both-miss path (local + remote). */
export interface CloudDocBothMissContext {
  readonly repoSlug: string;
  readonly ref: string;
  readonly remoteReason?: string;
}

/** Network/auth/404 from remote doc fetch — distinct from local `DocNotFoundError`. */
export class RemoteDocFetchError extends Error {
  override readonly name = "RemoteDocFetchError";
  readonly owner: string;
  readonly repo: string;
  readonly ref: string;
  readonly path: string;
  readonly suggestToken: boolean;

  constructor(params: {
    readonly owner: string;
    readonly repo: string;
    readonly ref: string;
    readonly path: string;
    readonly reason: string;
    readonly suggestToken: boolean;
  }) {
    const slug = `${params.owner}/${params.repo}`;
    const hint = params.suggestToken
      ? " Set GITHUB_TOKEN (or GH_TOKEN) or pass the doc locally via workdir."
      : "";
    super(
      `failed to fetch task doc from ${slug}@${params.ref} at ${params.path}: ${params.reason}.${hint}`,
    );
    this.owner = params.owner;
    this.repo = params.repo;
    this.ref = params.ref;
    this.path = params.path;
    this.suggestToken = params.suggestToken;
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

/** Cloud call with no `repo` and an unparseable `cloud.repos[0].url`. */
export class MissingRepoError extends Error {
  override readonly name = "MissingRepoError";

  constructor() {
    super("repo is required when it cannot be derived from cloud.repos[0].url");
  }
}

/** Wraps an underlying fs failure during a post-run-creation artifact write. */
export class ArtifactWriteFailedError extends Error {
  override readonly name = "ArtifactWriteFailedError";
}

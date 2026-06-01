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

const CLOUD_DOC_GUIDANCE =
  "For cloud runs, commit the doc to the repo branch or pass a local workdir containing it.";

export class DocNotFoundError extends Error {
  override readonly name = "DocNotFoundError";
  readonly docPath: string;

  constructor(
    docPath: string,
    opts?: { readonly cloud?: true; readonly cloudBothMiss?: CloudDocBothMissContext },
  ) {
    if (opts?.cloudBothMiss !== undefined) {
      const { repoSlug, ref, remoteReason } = opts.cloudBothMiss;
      const remoteDetail =
        remoteReason !== undefined ? `; not in ${repoSlug}@${ref} (${remoteReason})` : "";
      super(
        `task doc not found locally or remotely: ${docPath} (not on local filesystem${remoteDetail}). ` +
          "For cloud runs without a local copy, commit the doc to the branch or pass workdir with the file locally.",
      );
    } else if (opts?.cloud === true) {
      super(`task doc not found or not a file: ${docPath}. ${CLOUD_DOC_GUIDANCE}`);
    } else {
      super(`task doc not found or not a file: ${docPath}`);
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

/** `download_artifact` on a local-runtime workflow run. */
export class ArtifactsUnavailableLocalError extends Error {
  override readonly name = "ArtifactsUnavailableLocalError";
  readonly workflowRunId: string;

  constructor(workflowRunId: string) {
    super(`cloud artifacts are not available for local workflow run ${workflowRunId}`);
    this.workflowRunId = workflowRunId;
  }
}

/** SDK `path` failed lexical containment checks (absolute or `..`). */
export class ArtifactPathEscapesRunDirError extends Error {
  override readonly name = "ArtifactPathEscapesRunDirError";
  readonly path: string;

  constructor(path: string) {
    super(`artifact path escapes run artifacts directory: ${path}`);
    this.path = path;
  }
}

/** Persisted manifest lists the path but cloud agent bytes are gone. */
export class ArtifactGoneError extends Error {
  override readonly name = "ArtifactGoneError";
  readonly workflowRunId: string;
  readonly path: string;

  constructor(workflowRunId: string, path: string) {
    super(`cloud artifact no longer available: workflowRunId=${workflowRunId} path=${path}`);
    this.workflowRunId = workflowRunId;
    this.path = path;
  }
}

/** Manifest `path` not found for this workflow run. */
export class ArtifactNotInManifestError extends Error {
  override readonly name = "ArtifactNotInManifestError";
  readonly workflowRunId: string;
  readonly path: string;

  constructor(workflowRunId: string, path: string) {
    super(`artifact path not in manifest: workflowRunId=${workflowRunId} path=${path}`);
    this.workflowRunId = workflowRunId;
    this.path = path;
  }
}

/** Preflight size guard tripped (ED-5); no SDK download attempted. */
export class ArtifactTooLargeError extends Error {
  override readonly name = "ArtifactTooLargeError";
  readonly workflowRunId: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly maxBytes: number;

  constructor(args: { workflowRunId: string; path: string; sizeBytes: number; maxBytes: number }) {
    super(
      `artifact exceeds size cap (${String(args.sizeBytes)} > ${String(args.maxBytes)} bytes): workflowRunId=${args.workflowRunId} path=${args.path}`,
    );
    this.workflowRunId = args.workflowRunId;
    this.path = args.path;
    this.sizeBytes = args.sizeBytes;
    this.maxBytes = args.maxBytes;
  }
}

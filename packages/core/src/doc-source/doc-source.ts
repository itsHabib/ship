/**
 * Injectable seam for sourcing task docs from a remote Git host.
 * Default wiring uses GitHub via `@octokit/rest`; tests inject a fake.
 */

/** Parameters for fetching a file blob at a concrete ref. */
export interface DocSourceFetchParams {
  readonly owner: string;
  readonly repo: string;
  /** Repo-root-relative path (POSIX separators). */
  readonly path: string;
  readonly ref: string;
}

/** Parameters for resolving the ref to fetch from (F3 precedence). */
export interface DocSourceResolveRefParams {
  readonly owner: string;
  readonly repo: string;
  readonly startingRef?: string;
  readonly prUrl?: string;
  readonly workOnCurrentBranch?: boolean;
}

export interface DocSource {
  fetch(params: DocSourceFetchParams): Promise<string>;
  resolveRef(params: DocSourceResolveRefParams): Promise<string>;
}

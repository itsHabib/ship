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

// =====================================================================
// open_pr — pre-condition + integration errors.
// Backing impls live in git-remote.ts (local git) and gh.ts (Octokit).
// =====================================================================

// Pre-condition: the workflow run's implement phase is not `succeeded`.
// Opening a PR on a run whose implementation failed or was cancelled
// doesn't make sense — the branch may have partial / no commits.
export class ImplementPhaseNotSucceededError extends Error {
  override readonly name = "ImplementPhaseNotSucceededError";
  readonly workflowRunId: string;
  readonly status: string;

  constructor(workflowRunId: string, status: string) {
    super(
      `cannot open PR: implement phase is ${status} on workflowRunId=${workflowRunId} (expected: succeeded)`,
    );
    this.workflowRunId = workflowRunId;
    this.status = status;
  }
}

// Pre-condition: the run's recorded `workdir` is not a git checkout
// (no `.git` entry). Cheap pre-flight before any push attempt.
export class WorkdirNotGitError extends Error {
  override readonly name = "WorkdirNotGitError";
  readonly workdir: string;

  constructor(workdir: string) {
    super(`workdir is not a git checkout: ${workdir}`);
    this.workdir = workdir;
  }
}

// Pre-condition: the run's branch has no commits ahead of the resolved
// base AND no existing open PR was found by the idempotency probe.
// Surfaced before the GitHub call so the caller distinguishes "nothing
// to PR" from "PR creation failed."
export class EmptyBranchError extends Error {
  override readonly name = "EmptyBranchError";
  readonly head: string;
  readonly base: string;

  constructor(head: string, base: string) {
    super(`no commits on ${head} ahead of ${base}`);
    this.head = head;
    this.base = base;
  }
}

// Pre-condition: none of the three base-branch sources resolved
// (input.base, `branch.<head>.gh-merge-base` git config,
// `origin/HEAD`). Caller can pass `--base` to bypass. Accepts an
// optional `cause` so the underlying `OriginHeadUnsetError` (with
// its remediation hint) survives on the chain.
export class BaseBranchUnresolvedError extends Error {
  override readonly name = "BaseBranchUnresolvedError";
  readonly workdir: string;
  readonly head: string;

  constructor(workdir: string, head: string, options?: { cause?: unknown }) {
    super(
      `could not resolve base branch for head=${head} in workdir=${workdir} ` +
        `(no input override, no branch.${head}.gh-merge-base config, no origin/HEAD)`,
      options,
    );
    this.workdir = workdir;
    this.head = head;
  }
}

// `git symbolic-ref --short refs/remotes/origin/HEAD` returned nothing
// AND `git remote show origin` couldn't parse a HEAD branch. CI authors
// can pre-warm with `git remote set-head origin -a` to get the
// symbolic-ref path; this error is the actionable surface for that.
export class OriginHeadUnsetError extends Error {
  override readonly name = "OriginHeadUnsetError";
  readonly workdir: string;

  constructor(workdir: string) {
    super(
      `origin/HEAD is unset in ${workdir}; ` +
        `run \`git remote set-head origin -a\` to seed it, or pass --base`,
    );
    this.workdir = workdir;
  }
}

// Pre-condition: `git remote get-url origin` returned a URL we
// couldn't parse into an `owner/repo` pair (or the remote is not
// hosted on GitHub). Octokit needs both fields explicitly.
export class OriginRepoUnresolvedError extends Error {
  override readonly name = "OriginRepoUnresolvedError";
  readonly workdir: string;

  constructor(workdir: string, hint?: string) {
    const tail = hint === undefined ? "" : `: ${hint}`;
    super(`could not resolve origin owner/repo for workdir=${workdir}${tail}`);
    this.workdir = workdir;
  }
}

// `git push -u origin <branch>` failed. Captured stderr is preserved on
// the instance + threaded into the message tail so the operator sees
// the actual git error (force-required, branch-protected, etc.).
export class BranchPushFailedError extends Error {
  override readonly name = "BranchPushFailedError";
  readonly branch: string;
  readonly stderr: string;

  constructor(branch: string, stderr: string) {
    const tail = stderr === "" ? "" : `: ${stderr.trim()}`;
    super(`git push failed for branch ${branch}${tail}`);
    this.branch = branch;
    this.stderr = stderr;
  }
}

// GitHub rejected auth — missing `GITHUB_TOKEN`, expired token, or
// 401/403 from the API. The operator's next step is to set or refresh
// the token; the surface stays generic so it covers both cases.
// Accepts an optional `cause` so the original Octokit `RequestError`
// (with `response.data.errors[]`) is preserved on the stack trace.
export class GhAuthError extends Error {
  override readonly name = "GhAuthError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(`GitHub auth failed: ${message}`, options);
  }
}

// Octokit returned non-success for a reason other than auth. Class
// name is historical (created for `pulls.create`) but the type now
// covers any non-auth Octokit failure from `OpenPrService` — callers
// pass an already-operation-qualified message (e.g. "pulls.list
// failed: ...") so the constructor stays a thin pass-through to
// `Error(message, options)` — `options.cause` is forwarded by the
// builtin and surfaces the original Octokit `RequestError` (with
// `response.data.errors[]`) for debugging.
export class GhCreatePrFailedError extends Error {
  override readonly name = "GhCreatePrFailedError";
}

// Defensive: an `open_pr` call landed on a workflowRunId already
// registered in `activeRuns` (e.g. a still-active `ship` run).
// Practically unreachable because the implement-succeeded
// pre-condition filters it, but the typed error keeps the registry
// contract enforceable.
export class WorkflowRunStillActiveError extends Error {
  override readonly name = "WorkflowRunStillActiveError";
  readonly workflowRunId: string;

  constructor(workflowRunId: string) {
    super(`workflow run ${workflowRunId} is already active in the registry`);
    this.workflowRunId = workflowRunId;
  }
}

// Generic "the caller cancelled while we were running" sentinel. Mirrors
// node's built-in `AbortError`/`DOMException` shape (`name === "AbortError"`)
// so test assertions and `instanceof` checks line up uniformly.
export class OpenPrAbortedError extends Error {
  override readonly name = "AbortError";
  readonly workflowRunId: string;

  constructor(workflowRunId: string) {
    super(`open_pr aborted: workflowRunId=${workflowRunId}`);
    this.workflowRunId = workflowRunId;
  }
}

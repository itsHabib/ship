// Git-side shell-out surface for `OpenPrService`. Owns the local-git
// operations a forge-API backend (Octokit, etc.) wouldn't touch:
// push, config read, default-branch resolution, owner/repo parsing
// from `origin` URL, current-branch read, commit-subject listing.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { BranchPushFailedError, OriginHeadUnsetError } from "./errors.js";

const execFileAsync = promisify(execFile);

// Discriminator-bearing result for `readOriginRepo`. `slug` is null
// when `git remote get-url origin` returned a URL we couldn't parse;
// `rawUrl` is always present so the caller's typed error can quote it
// back to the operator.
export interface ReadOriginRepoResult {
  readonly slug: { owner: string; repo: string } | null;
  readonly rawUrl: string;
}

export interface GitRemote {
  // Reads a local git config value. Returns null when unset
  // (git's "exit 1 + no stdout" convention).
  readConfig(opts: { workdir: string; key: string }): Promise<string | null>;

  // Returns the remote default branch (e.g. "main"). Probes
  // `refs/remotes/origin/HEAD` first; on the unset path falls back to
  // `git remote show origin`. Throws `OriginHeadUnsetError` only when
  // both probes return null (shallow clone with no `origin/HEAD` set
  // AND no remote reachable).
  readDefaultBranch(opts: { workdir: string }): Promise<string>;

  // Returns the workdir's current branch (e.g. "tower/open-pr"). Null
  // on detached HEAD. `OpenPrService` falls back to this when the
  // workflow row recorded `branch="(unknown)"` because the original
  // `ship` caller didn't supply one.
  readCurrentBranch(opts: { workdir: string }): Promise<string | null>;

  // Parses `git remote get-url origin` into `{ owner, repo, rawUrl }`.
  // Returns null only when `git` itself failed (no origin remote, not
  // a git repo); when the URL is present but not a recognizable
  // GitHub form, the result has `owner === null` and the caller surfaces
  // a typed error with the unparseable URL on the hint. Octokit needs
  // both fields explicitly — the gh CLI auto-resolved them, but the
  // SDK doesn't.
  readOriginRepo(opts: { workdir: string }): Promise<ReadOriginRepoResult | null>;

  // Returns commit subjects on `head` that are not on `base`, oldest-
  // first. Empty array → branch is empty against base. Used both for
  // the empty-branch precondition (length === 0) and the body
  // derivation (one bullet per subject).
  listCommitSubjects(opts: { workdir: string; head: string; base: string }): Promise<string[]>;

  // Pushes `branch` to `origin` with upstream tracking. Wraps known
  // failure modes in `BranchPushFailedError`.
  pushBranch(opts: { workdir: string; branch: string }): Promise<void>;
}

interface NodeGitRemoteOpts {
  // Override `git` binary path. Used by integration tests via
  // `SHIP_GIT_BINARY=...`; production callers omit and get `"git"`.
  readonly gitBinary?: string;
}

export function createNodeGitRemote(opts: NodeGitRemoteOpts = {}): GitRemote {
  const bin = opts.gitBinary ?? process.env["SHIP_GIT_BINARY"] ?? "git";
  return {
    readConfig: ({ workdir, key }) => readConfig(bin, workdir, key),
    readDefaultBranch: ({ workdir }) => readDefaultBranch(bin, workdir),
    readCurrentBranch: ({ workdir }) => readCurrentBranch(bin, workdir),
    readOriginRepo: ({ workdir }) => readOriginRepo(bin, workdir),
    listCommitSubjects: ({ workdir, head, base }) => listCommitSubjects(bin, workdir, head, base),
    pushBranch: ({ workdir, branch }) => pushBranch(bin, workdir, branch),
  };
}

async function readConfig(bin: string, workdir: string, key: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(bin, ["-C", workdir, "config", "--get", key]);
    const value = stdout.trim();
    return value === "" ? null : value;
  } catch (err) {
    // `git config --get` exits 1 when the key is unset — distinguish that
    // from a real failure (exit 128, e.g. not a git repo) so callers
    // don't see "config unset" surface as a thrown error.
    if (isExitCode(err, 1)) return null;
    throw wrapAsGitError(err, `git config --get ${key}`);
  }
}

async function readDefaultBranch(bin: string, workdir: string): Promise<string> {
  const symref = await trySymbolicRef(bin, workdir);
  if (symref !== null) return symref;
  const remoteShow = await tryRemoteShow(bin, workdir);
  if (remoteShow !== null) return remoteShow;
  throw new OriginHeadUnsetError(workdir);
}

async function trySymbolicRef(bin: string, workdir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(bin, [
      "-C",
      workdir,
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    const trimmed = stdout.trim();
    if (trimmed === "") return null;
    // Strip "origin/" so the caller gets a bare branch name.
    return trimmed.startsWith("origin/") ? trimmed.slice("origin/".length) : trimmed;
  } catch {
    return null;
  }
}

async function tryRemoteShow(bin: string, workdir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(bin, ["-C", workdir, "remote", "show", "origin"]);
    return parseHeadBranchFromRemoteShow(stdout);
  } catch {
    return null;
  }
}

// Exported for unit testing. Scans `git remote show origin`'s stdout
// for the `HEAD branch: <name>` line and returns the name, or null
// when the marker is `(unknown)` / missing. Line-by-line scan rather
// than a multiline regex (scanners flag the trailing `\s*$` form as
// backtracking-vulnerable).
export function parseHeadBranchFromRemoteShow(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("HEAD branch:")) continue;
    const value = trimmed.slice("HEAD branch:".length).trim();
    return value === "" || value === "(unknown)" ? null : value;
  }
  return null;
}

async function readOriginRepo(bin: string, workdir: string): Promise<ReadOriginRepoResult | null> {
  try {
    const { stdout } = await execFileAsync(bin, ["-C", workdir, "remote", "get-url", "origin"]);
    const rawUrl = stdout.trim();
    return { slug: parseOriginRepoFromUrl(rawUrl), rawUrl };
  } catch {
    return null;
  }
}

// Exported for unit testing. Accepts the three URL forms `git remote
// get-url` emits for GitHub remotes:
//   - scp-style SSH:  `git@github.com:<owner>/<repo>(.git)?`
//   - SSH URI:        `ssh://git@github.com/<owner>/<repo>(.git)?`
//   - HTTP(S):        `http(s)://github.com/<owner>/<repo>(.git)?`
// Returns null for any other shape (non-GitHub host, unrecognized
// scheme, missing owner/repo) so the caller can surface a typed
// `OriginRepoUnresolvedError`. Host filter is deliberately strict —
// without it a `gitlab.com` remote would silently get treated as a
// GitHub slug and dispatch to GitHub's API with the wrong repo.
export function parseOriginRepoFromUrl(url: string): { owner: string; repo: string } | null {
  if (url === "") return null;
  const scp = parseScpStyleSsh(url);
  if (scp !== undefined) return scp;
  return parseUriStyle(url);
}

// scp-style SSH: `git@host:tail` (colon, not `://`). Returns
// `undefined` if the URL isn't in this form so the caller falls through
// to URI parsing; `null` if the form matches but is malformed.
function parseScpStyleSsh(url: string): { owner: string; repo: string } | null | undefined {
  if (!url.startsWith("git@") || url.startsWith("git@://")) return undefined;
  const colonIdx = url.indexOf(":");
  if (colonIdx <= "git@".length) return null;
  const host = url.slice("git@".length, colonIdx);
  if (!isGithubHost(host)) return null;
  return splitOwnerRepo(url.slice(colonIdx + 1));
}

// URI-scheme forms: ssh://, https://, http://. All share the
// `scheme://[user@]host/path` layout, so factoring extraction here
// keeps the schemes from drifting.
function parseUriStyle(url: string): { owner: string; repo: string } | null {
  const schemeIdx = url.indexOf("://");
  if (schemeIdx < 0) return null;
  const scheme = url.slice(0, schemeIdx);
  if (scheme !== "ssh" && scheme !== "https" && scheme !== "http") return null;
  const authorityAndPath = url.slice(schemeIdx + 3);
  const firstSlash = authorityAndPath.indexOf("/");
  if (firstSlash < 0) return null;
  const authority = authorityAndPath.slice(0, firstSlash);
  // Strip optional `user@` prefix from the authority (the `ssh://`
  // form typically carries `git@`; HTTPS may carry tokens).
  const atIdx = authority.lastIndexOf("@");
  const host = atIdx < 0 ? authority : authority.slice(atIdx + 1);
  if (!isGithubHost(host)) return null;
  return splitOwnerRepo(authorityAndPath.slice(firstSlash + 1));
}

// Recognized GitHub hosts. `github.com` is the public host; the
// optional Enterprise carve-out is intentionally narrow — operators
// can lift this with a config knob if/when needed. Wildcard subdomain
// matches keep `api.github.com` and similar out (different API base).
function isGithubHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "github.com" || normalized === "www.github.com";
}

function splitOwnerRepo(tail: string): { owner: string; repo: string } | null {
  const cleaned = tail.endsWith(".git") ? tail.slice(0, -4) : tail;
  const slash = cleaned.indexOf("/");
  if (slash <= 0) return null;
  const owner = cleaned.slice(0, slash);
  const repo = cleaned.slice(slash + 1);
  if (owner === "" || repo === "" || repo.includes("/")) return null;
  return { owner, repo };
}

async function pushBranch(bin: string, workdir: string, branch: string): Promise<void> {
  try {
    await execFileAsync(bin, ["-C", workdir, "push", "-u", "origin", branch]);
  } catch (err) {
    throw new BranchPushFailedError(branch, capturedStderr(err));
  }
}

async function readCurrentBranch(bin: string, workdir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(bin, ["-C", workdir, "branch", "--show-current"]);
    const trimmed = stdout.trim();
    return trimmed === "" ? null : trimmed;
  } catch {
    return null;
  }
}

async function listCommitSubjects(
  bin: string,
  workdir: string,
  head: string,
  base: string,
): Promise<string[]> {
  try {
    // `--reverse` → oldest-first so the rendered body reads
    // chronologically (matches how humans author "Changes" lists).
    const { stdout } = await execFileAsync(bin, [
      "-C",
      workdir,
      "log",
      "--reverse",
      "--format=%s",
      `${base}..${head}`,
    ]);
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "");
  } catch (err) {
    // Distinguish "unknown ref" (exit 128) from "no commits matched"
    // — the former should propagate so an operator passing a typo
    // via `--base` gets a real diagnostic, not a misleading
    // EmptyBranchError. The latter naturally yields stdout="" and
    // never throws.
    if (isExitCode(err, 128)) {
      throw wrapAsGitError(err, `git log ${base}..${head}`);
    }
    return [];
  }
}

function isExitCode(err: unknown, code: number): boolean {
  if (typeof err !== "object" || err === null) return false;
  return (err as { code?: unknown }).code === code;
}

function wrapAsGitError(err: unknown, op: string): Error {
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`${op} failed: ${message}`);
}

// stderr cap (8 KB) so a hostile or noisy git failure can't unbound
// the persisted artifact; matches the cursor-run capture cap
// elsewhere in the repo.
const STDERR_CAP = 8 * 1024;

function capturedStderr(err: unknown): string {
  if (typeof err !== "object" || err === null) return "";
  const raw = (err as { stderr?: unknown }).stderr;
  const text = typeof raw === "string" ? raw : "";
  return text.length > STDERR_CAP ? text.slice(0, STDERR_CAP) : text;
}

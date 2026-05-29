/**
 * GitHub-backed `DocSource` using `@octokit/rest`.
 * Token is read from `GITHUB_TOKEN` || `GH_TOKEN`; public repos work tokenless.
 */

import { RequestError } from "@octokit/request-error";
import { Octokit } from "@octokit/rest";

import type { DocSource, DocSourceFetchParams, DocSourceResolveRefParams } from "./doc-source.js";

import { RemoteDocFetchError } from "../errors.js";
import { parseGitHubPullNumber, parseGitHubPullRepoSlug } from "./parse-github-url.js";

export function createRemoteDocSource(token?: string): DocSource {
  const authToken = token ?? process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
  const hasToken = authToken !== undefined && authToken !== "";
  const octokit = new Octokit(hasToken ? { auth: authToken } : {});
  const defaultBranchCache = new Map<string, string>();

  return {
    fetch: (params) => fetchBlob(octokit, params, hasToken),
    resolveRef: (params) => resolveRef(octokit, params, defaultBranchCache, hasToken),
  };
}

async function resolveRef(
  octokit: Octokit,
  params: DocSourceResolveRefParams,
  defaultBranchCache: Map<string, string>,
  hasToken: boolean,
): Promise<string> {
  const { owner, repo, startingRef, prUrl, workOnCurrentBranch } = params;
  if (startingRef !== undefined && startingRef !== "") {
    return startingRef;
  }
  if ((prUrl !== undefined && prUrl !== "") || workOnCurrentBranch === true) {
    if (prUrl !== undefined && prUrl !== "") {
      return resolvePullRequestRef(octokit, owner, repo, prUrl, hasToken);
    }
    return resolveDefaultBranch(octokit, owner, repo, defaultBranchCache, hasToken);
  }
  return resolveDefaultBranch(octokit, owner, repo, defaultBranchCache, hasToken);
}

async function resolvePullRequestRef(
  octokit: Octokit,
  owner: string,
  repo: string,
  prUrl: string,
  hasToken: boolean,
): Promise<string> {
  try {
    const pullSlug = parseGitHubPullRepoSlug(prUrl);
    if (pullSlug !== undefined && pullSlug !== `${owner}/${repo}`) {
      throw new RemoteDocFetchError({
        owner,
        repo,
        ref: prUrl,
        path: "(unknown)",
        reason: `prUrl repo ${pullSlug} does not match configured repo ${owner}/${repo}`,
        suggestToken: false,
      });
    }
    const pullNumber = parseGitHubPullNumber(prUrl);
    const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
    return data.head.ref;
  } catch (err) {
    if (err instanceof RemoteDocFetchError) throw err;
    throw toRemoteDocFetchError(err, { owner, repo, ref: prUrl, hasToken });
  }
}

async function resolveDefaultBranch(
  octokit: Octokit,
  owner: string,
  repo: string,
  cache: Map<string, string>,
  hasToken: boolean,
): Promise<string> {
  const key = `${owner}/${repo}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  try {
    const { data } = await octokit.rest.repos.get({ owner, repo });
    cache.set(key, data.default_branch);
    return data.default_branch;
  } catch (err) {
    throw toRemoteDocFetchError(err, { owner, repo, ref: "(default branch)", hasToken });
  }
}

async function fetchBlob(
  octokit: Octokit,
  params: DocSourceFetchParams,
  hasToken: boolean,
): Promise<string> {
  const { owner, repo, path, ref } = params;
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref });
    if (Array.isArray(data) || data.type !== "file") {
      throw new RemoteDocFetchError({
        owner,
        repo,
        ref,
        path,
        reason: "path is not a file",
        suggestToken: !hasToken,
      });
    }
    if (typeof data.content !== "string" || data.content === "") {
      throw new RemoteDocFetchError({
        owner,
        repo,
        ref,
        path,
        reason: "empty file content",
        suggestToken: !hasToken,
      });
    }
    if (data.encoding === "base64") {
      return Buffer.from(data.content, "base64").toString("utf-8");
    }
    return data.content;
  } catch (err) {
    if (err instanceof RemoteDocFetchError) throw err;
    throw toRemoteDocFetchError(err, { owner, repo, ref, path, hasToken, suggestTokenOn404: true });
  }
}

interface RemoteDocFetchErrorContext {
  readonly owner: string;
  readonly repo: string;
  readonly ref: string;
  readonly path?: string;
  readonly hasToken: boolean;
  /** When true, tokenless 404 on blob fetch suggests setting GITHUB_TOKEN (F4). */
  readonly suggestTokenOn404?: boolean;
}

function toRemoteDocFetchError(err: unknown, ctx: RemoteDocFetchErrorContext): RemoteDocFetchError {
  if (err instanceof RequestError) {
    const reason = requestErrorReason(err);
    const suggestToken =
      !ctx.hasToken &&
      (err.status === 401 ||
        err.status === 403 ||
        (ctx.suggestTokenOn404 === true && err.status === 404));
    return new RemoteDocFetchError({
      owner: ctx.owner,
      repo: ctx.repo,
      ref: ctx.ref,
      path: ctx.path ?? "(unknown)",
      reason,
      suggestToken,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  return new RemoteDocFetchError({
    owner: ctx.owner,
    repo: ctx.repo,
    ref: ctx.ref,
    path: ctx.path ?? "(unknown)",
    reason: message,
    suggestToken: !ctx.hasToken,
  });
}

function requestErrorReason(err: RequestError): string {
  if (err.status === 404) return "not found";
  if (err.status === 401 || err.status === 403) return "authentication or permission denied";
  return err.message;
}

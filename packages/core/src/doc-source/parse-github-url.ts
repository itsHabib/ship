/**
 * Parse `owner` + repo `name` from a GitHub remote URL.
 * Non-GitHub hosts throw — cloud scope is GitHub-only today.
 */

export interface GitHubOwnerRepo {
  readonly owner: string;
  readonly repo: string;
}

/** Parses `owner/repo` slug into components. */
export function splitRepoSlug(slug: string): GitHubOwnerRepo {
  const parts = slug.split("/").filter((p) => p.length > 0);
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
    throw new Error(`invalid repo slug (expected owner/repo): ${slug}`);
  }
  return { owner: parts[0], repo: parts[1] };
}

/**
 * Derives `owner/repo` from an HTTPS or SSH GitHub remote URL.
 * Returns `undefined` when the URL is unparseable (not a hard error).
 */
export function parseGitHubRepoSlug(url: string): string | undefined {
  const parsed = tryParseGitHubOwnerRepo(url);
  if (parsed === undefined) return undefined;
  return `${parsed.owner}/${parsed.repo}`;
}

/** Throws when the URL is not a supported GitHub remote. */
export function parseGitHubOwnerRepo(url: string): GitHubOwnerRepo {
  const parsed = tryParseGitHubOwnerRepo(url);
  if (parsed === undefined) {
    throw new Error(`only github.com remotes are supported for cloud doc sourcing: ${url}`);
  }
  return parsed;
}

function tryParseGitHubOwnerRepo(url: string): GitHubOwnerRepo | undefined {
  const trimmed = url.trim();
  const ssh = parseSshGitHubUrl(trimmed);
  if (ssh !== undefined) return ssh;
  return parseHttpsGitHubUrl(trimmed);
}

function parseSshGitHubUrl(url: string): GitHubOwnerRepo | undefined {
  const m = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url);
  if (m?.[1] === undefined || m[2] === undefined) return undefined;
  return { owner: m[1], repo: stripGitSuffix(m[2]) };
}

function parseHttpsGitHubUrl(url: string): GitHubOwnerRepo | undefined {
  try {
    const u = new URL(url);
    if (u.hostname.toLowerCase() !== "github.com") return undefined;
    return parseGitHubPathname(u.pathname);
  } catch {
    return undefined;
  }
}

function parseGitHubPathname(pathname: string): GitHubOwnerRepo | undefined {
  let path = pathname;
  if (path.startsWith("/")) path = path.slice(1);
  if (path.endsWith("/")) path = path.slice(0, -1);
  const parts = path.split("/").filter((p) => p.length > 0);
  if (parts.length < 2 || parts[0] === undefined || parts[1] === undefined) {
    return undefined;
  }
  return { owner: parts[0], repo: stripGitSuffix(parts[1]) };
}

function stripGitSuffix(name: string): string {
  return name.toLowerCase().endsWith(".git") ? name.slice(0, -4) : name;
}

/** Extracts a pull request number from a GitHub PR URL. */
export function parseGitHubPullNumber(prUrl: string): number {
  const m = /github\.com\/[^/]+\/[^/]+\/pull\/(\d+)\b/i.exec(prUrl);
  if (m?.[1] === undefined) {
    throw new Error(`could not parse pull request number from prUrl: ${prUrl}`);
  }
  return Number(m[1]);
}

/** Parses `owner/repo` from a GitHub pull request URL. */
export function parseGitHubPullRepoSlug(prUrl: string): string | undefined {
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/\d+\b/i.exec(prUrl);
  if (m?.[1] === undefined || m[2] === undefined) return undefined;
  return `${m[1]}/${m[2]}`;
}

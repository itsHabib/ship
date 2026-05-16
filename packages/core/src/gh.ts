// GitHub API surface for `OpenPrService`. Speaks to GitHub via
// `@octokit/rest`: one HTTP call to list open PRs for a head/base
// pair (idempotency probe), one to create a PR. Auth via the
// standard `GITHUB_TOKEN` (or `GH_TOKEN`) env var, or an explicit
// token passed to `createNodeGhClient({ token })` for tests.
//
// The interface stays narrow so a future swap to a different forge
// (GitLab, Gitea) means writing one new `createXGhClient` factory
// against the same shape — no consumer change.

import { Octokit } from "@octokit/rest";

import { GhAuthError, GhCreatePrFailedError } from "./errors.js";

// Subset of `@octokit/core`'s `OctokitOptions` we construct here.
// Importing the full type from `@octokit/core/dist-types/...` would
// reach into Octokit's internal layout; declaring locally is more
// stable across SDK versions and is exactly what we need.
interface OctokitOpts {
  auth: string;
  baseUrl?: string;
}

// Narrowing of the raw `gh pr {list,create}` response: callers only
// consume the two fields needed to record the result. Anything else in
// the GitHub payload is intentionally dropped at this boundary so TS
// catches drift if Ship later starts depending on a third field.
export interface GhPrRef {
  readonly number: number;
  readonly url: string;
}

export interface GhClient {
  // Returns open PRs whose head matches `head` and base matches `base`
  // in the named `owner/repo`. The sole caller (the idempotency probe
  // in `OpenPrService`) checks for length > 0; the `state: "open"`
  // filter is baked into the verb name so the assumption stays
  // visible at every call site.
  listOpenPrsForBranch(opts: {
    owner: string;
    repo: string;
    head: string;
    base: string;
  }): Promise<GhPrRef[]>;

  // Opens a PR. Returns the new PR's number + html_url. Auth /
  // permission failures surface as `GhAuthError`; anything else
  // wraps in `GhCreatePrFailedError` with the API's message.
  createPr(opts: {
    owner: string;
    repo: string;
    base: string;
    head: string;
    title: string;
    body: string;
    draft: boolean;
  }): Promise<GhPrRef>;
}

export interface NodeGhClientOpts {
  // OAuth token. Production reads `GITHUB_TOKEN` (then `GH_TOKEN`)
  // from `process.env`; integration tests pass an explicit token (or
  // a pre-built `octokit` instance) to bypass env-var lookup.
  readonly token?: string;
  // Pre-built `Octokit` instance. Wins over `token`. Used by the
  // integration test (points `baseUrl` at a local HTTP stub) and by
  // unit tests that want to assert on the request log.
  readonly octokit?: Octokit;
  // Override Octokit's `baseUrl` (e.g. for GitHub Enterprise or for
  // an integration-test mock server reachable on localhost). Ignored
  // when `octokit` is provided.
  readonly baseUrl?: string;
}

export function createNodeGhClient(opts: NodeGhClientOpts = {}): GhClient {
  // Lazy build: deferred so a `--help` invocation doesn't construct
  // an Octokit (which loads request middleware) for nothing.
  let octokit: Octokit | undefined;
  const getOctokit = (): Octokit => {
    if (octokit !== undefined) return octokit;
    if (opts.octokit !== undefined) {
      octokit = opts.octokit;
      return octokit;
    }
    const token = opts.token ?? process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
    if (token === undefined || token === "") {
      throw new GhAuthError(
        "missing GITHUB_TOKEN (or GH_TOKEN) — set the env var or pass token to createNodeGhClient",
      );
    }
    const octokitOpts: OctokitOpts = { auth: token };
    // Env-var override is test-scoped on purpose: the `SHIP_TEST_`
    // prefix mirrors `SHIP_TEST_FAKE_CURSOR` and makes the intent
    // visible to operators (an accidentally-set var would otherwise
    // silently redirect every GitHub call to a mock host).
    const baseUrl = opts.baseUrl ?? process.env["SHIP_TEST_OCTOKIT_BASE_URL"];
    if (baseUrl !== undefined && baseUrl !== "") octokitOpts.baseUrl = baseUrl;
    octokit = new Octokit(octokitOpts);
    return octokit;
  };

  return {
    listOpenPrsForBranch: async ({ owner, repo, head, base }) => {
      const client = getOctokit();
      const { data } = await client.pulls.list({
        owner,
        repo,
        head: `${owner}:${head}`,
        base,
        state: "open",
      });
      return data.map((pr) => ({ number: pr.number, url: pr.html_url }));
    },
    createPr: async ({ owner, repo, base, head, title, body, draft }) => {
      const client = getOctokit();
      try {
        const { data } = await client.pulls.create({
          owner,
          repo,
          base,
          head,
          title,
          body,
          draft,
        });
        return { number: data.number, url: data.html_url };
      } catch (err) {
        throw wrapCreatePrError(err);
      }
    },
  };
}

function wrapCreatePrError(err: unknown): Error {
  if (typeof err !== "object" || err === null) {
    return new GhCreatePrFailedError(String(err));
  }
  const status = (err as { status?: unknown }).status;
  const message =
    typeof (err as { message?: unknown }).message === "string"
      ? (err as { message: string }).message
      : "unknown error";
  // Chain the Octokit RequestError as `cause` so callers can inspect
  // `err.cause.response.data.errors[]` for the structured GitHub
  // validation detail (rate-limit headers, per-field errors, etc.).
  if (status === 401 || status === 403) return new GhAuthError(message, { cause: err });
  return new GhCreatePrFailedError(message, { cause: err });
}

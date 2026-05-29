/**
 * Scriptable fake `DocSource` for unit / scenario tests — no network.
 */

import type { DocSource, DocSourceFetchParams, DocSourceResolveRefParams } from "@ship/core";

import { RemoteDocFetchError } from "@ship/core";

export class FakeDocSource implements DocSource {
  readonly fetchCalls: DocSourceFetchParams[] = [];
  readonly resolveRefCalls: DocSourceResolveRefParams[] = [];
  /** Ref returned when no override is installed. */
  defaultRef = "main";
  /** Map key: `${owner}/${repo}@${ref}:${path}` → file contents. */
  readonly files = new Map<string, string>();
  fetchOverride?: (params: DocSourceFetchParams) => Promise<string>;
  resolveRefOverride?: (params: DocSourceResolveRefParams) => Promise<string>;

  async fetch(params: DocSourceFetchParams): Promise<string> {
    this.fetchCalls.push(params);
    if (this.fetchOverride !== undefined) {
      return this.fetchOverride(params);
    }
    const key = `${params.owner}/${params.repo}@${params.ref}:${params.path}`;
    const content = this.files.get(key);
    if (content === undefined) {
      throw new RemoteDocFetchError({
        owner: params.owner,
        repo: params.repo,
        ref: params.ref,
        path: params.path,
        reason: "not found",
        suggestToken: false,
      });
    }
    return content;
  }

  async resolveRef(params: DocSourceResolveRefParams): Promise<string> {
    this.resolveRefCalls.push(params);
    if (this.resolveRefOverride !== undefined) {
      return this.resolveRefOverride(params);
    }
    if (params.startingRef !== undefined && params.startingRef !== "") {
      return params.startingRef;
    }
    if (params.prUrl !== undefined && params.prUrl !== "") {
      return "pr-head-branch";
    }
    return this.defaultRef;
  }

  seedFile(owner: string, repo: string, ref: string, path: string, content: string): void {
    this.files.set(`${owner}/${repo}@${ref}:${path}`, content);
  }
}

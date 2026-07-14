/**
 * Named-field extraction of a Cursor SDK error for durable persistence.
 * Reads non-enumerable own-properties explicitly; redacts secrets before
 * the value leaves the runner. Never persists a raw `util.inspect` blob.
 */

import type { SdkCauseSummary } from "@ship/agent-runner";

import { MAX_SDK_CAUSE_DETAIL_CHARS } from "@ship/agent-runner";

/** Marker used when a token-bearing `GITHUB_MCP_URL` appears in a field. */
export const GH_MCP_URL_REDACTION = "<GITHUB_MCP_URL redacted>";

const AUTH_TOKEN_KEY = "authorization_token";

export interface ExtractSdkCauseOptions {
  /** When set, every occurrence is replaced with {@link GH_MCP_URL_REDACTION}. */
  readonly githubMcpUrl?: string;
  /** Soft length cap applied to string fields before they enter the summary. */
  readonly maxChars?: number;
}

function readOwn(obj: object, key: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return undefined;
  return (obj as Record<string, unknown>)[key];
}

function firstOwn(obj: object, keys: readonly string[]): unknown {
  for (const key of keys) {
    const val = readOwn(obj, key);
    if (val !== undefined) return val;
  }
  return undefined;
}

function redactAuthorizationToken(text: string): string {
  // Handle URL-encoded `=` (`%3D`) before the plain form so `%` is not
  // swallowed as a separator.
  const encoded = text.replace(
    /authorization_token%3D[^\s&"'\\]+/gi,
    `${AUTH_TOKEN_KEY}%3D[redacted]`,
  );
  return encoded.replace(
    /authorization_token(["\s:=]+)([^\s"',}\\]+)/gi,
    (_m, sep: string) => `${AUTH_TOKEN_KEY}${sep}[redacted]`,
  );
}

function redactSecretShapes(text: string): string {
  // Same scrub family as core's sanitizeFailureDetail — GITHUB_MCP_URL may
  // carry a PAT in the query, and SDK echoes sometimes mutate the URL so the
  // exact-substring replace above misses the token itself.
  return (
    text
      .replace(/\b(?:gh[pousr]_|github_pat_)\w+/g, "[token]")
      // `%XX` is a word char boundary for `\b`, so also catch PATs after `%3D`.
      .replace(/(?<=%3D)(?:gh[pousr]_|github_pat_)\w+/gi, "[token]")
      .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [token]")
      .replace(
        /\b([A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*)=[^\s,;]+/gi,
        "$1=[redacted]",
      )
      .replace(/([?&#;](?:token|access_token|api_key|key)=)[^&\s"'\\]+/gi, "$1[redacted]")
      .replace(/([?&#;](?:token|access_token|api_key|key)%3D)[^&\s"'\\]+/gi, "$1[redacted]")
  );
}

function redactText(text: string, githubMcpUrl: string | undefined): string {
  let out = text;
  if (githubMcpUrl !== undefined && githubMcpUrl !== "") {
    out = out.split(githubMcpUrl).join(GH_MCP_URL_REDACTION);
  }
  // Never carry authorization_token values if they leaked into a string field
  // (e.g. an endpoint URL or verbose SDK message).
  return redactSecretShapes(redactAuthorizationToken(out));
}

function asFiniteStatus(val: unknown): number | undefined {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val !== "string" || val.trim() === "") return undefined;
  const n = Number(val);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

function asNonEmptyString(
  val: unknown,
  githubMcpUrl: string | undefined,
  maxChars: number,
): string | undefined {
  if (typeof val !== "string") return undefined;
  const redacted = redactText(val, githubMcpUrl).trim();
  if (redacted === "") return undefined;
  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, Math.max(0, maxChars - 3))}...`;
}

function extractFromObject(
  obj: object,
  githubMcpUrl: string | undefined,
  maxChars: number,
): SdkCauseSummary {
  const status = asFiniteStatus(firstOwn(obj, ["status", "statusCode"]));
  const code = asNonEmptyString(firstOwn(obj, ["code"]), githubMcpUrl, maxChars);
  const type = asNonEmptyString(firstOwn(obj, ["type"]), githubMcpUrl, maxChars);
  const requestId = asNonEmptyString(
    firstOwn(obj, ["request_id", "requestId"]),
    githubMcpUrl,
    maxChars,
  );
  const endpoint = asNonEmptyString(firstOwn(obj, ["endpoint", "url"]), githubMcpUrl, maxChars);
  // `message` is non-enumerable on Error but still an own property.
  const message = asNonEmptyString(readOwn(obj, "message"), githubMcpUrl, maxChars);

  const out: {
    status?: number;
    code?: string;
    type?: string;
    requestId?: string;
    endpoint?: string;
    message?: string;
  } = {};
  if (status !== undefined) out.status = status;
  if (code !== undefined) out.code = code;
  if (type !== undefined) out.type = type;
  if (requestId !== undefined) out.requestId = requestId;
  if (endpoint !== undefined) out.endpoint = endpoint;
  if (message !== undefined) out.message = message;
  return out;
}

function hasDiscriminators(summary: SdkCauseSummary): boolean {
  return (
    summary.status !== undefined ||
    summary.code !== undefined ||
    summary.type !== undefined ||
    summary.requestId !== undefined ||
    summary.endpoint !== undefined
  );
}

function isEmptySummary(summary: SdkCauseSummary): boolean {
  return (
    summary.status === undefined &&
    summary.code === undefined &&
    summary.type === undefined &&
    summary.requestId === undefined &&
    summary.endpoint === undefined &&
    summary.message === undefined
  );
}

function extractPrimitiveCause(
  err: unknown,
  githubMcpUrl: string | undefined,
  maxChars: number,
): SdkCauseSummary | undefined {
  if (typeof err !== "string" || err.trim() === "") return undefined;
  const message = asNonEmptyString(err, githubMcpUrl, maxChars);
  if (message === undefined) return undefined;
  return { message };
}

function extractFromCauseChain(
  err: object,
  githubMcpUrl: string | undefined,
  maxChars: number,
  outer: SdkCauseSummary,
): SdkCauseSummary | undefined {
  const nested = readOwn(err, "cause");
  if (nested === null || typeof nested !== "object") return undefined;
  const nestedSummary = extractFromObject(nested, githubMcpUrl, maxChars);
  if (hasDiscriminators(nestedSummary)) return nestedSummary;
  if (!isEmptySummary(nestedSummary) && isEmptySummary(outer)) return nestedSummary;
  return undefined;
}

/**
 * Pull a small fixed set of discriminating fields off a caught SDK error.
 * Returns `undefined` when nothing useful is present (no fabricated fields).
 */
export function extractSdkCause(
  err: unknown,
  options: ExtractSdkCauseOptions = {},
): SdkCauseSummary | undefined {
  const maxChars = options.maxChars ?? MAX_SDK_CAUSE_DETAIL_CHARS;
  const githubMcpUrl = options.githubMcpUrl;
  if (err === null || typeof err !== "object") {
    return extractPrimitiveCause(err, githubMcpUrl, maxChars);
  }

  const summary = extractFromObject(err, githubMcpUrl, maxChars);
  if (hasDiscriminators(summary)) return summary;

  // One-level cause walk — wrappers often carry only a message while the
  // discriminating fields live on `.cause` (still an own-property read).
  const fromCause = extractFromCauseChain(err, githubMcpUrl, maxChars, summary);
  if (fromCause !== undefined) return fromCause;
  if (isEmptySummary(summary)) return undefined;
  return summary;
}

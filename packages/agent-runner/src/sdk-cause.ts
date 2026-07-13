/**
 * Bounded, redacted SDK-cause summary carried on thrown runner failures
 * and (optionally) on terminal `AgentRunResult`s. Named fields only —
 * never a raw `util.inspect` blob.
 */

/** Discriminating fields plucked from a Cursor / provider SDK error. */
export interface SdkCauseSummary {
  readonly status?: number;
  readonly code?: string;
  readonly type?: string;
  readonly requestId?: string;
  readonly endpoint?: string;
  readonly message?: string;
}

/** Soft cap so a chatty SDK message cannot bloat the phase row. */
export const MAX_SDK_CAUSE_DETAIL_CHARS = 200;

const TRUNCATED_SUFFIX = "...";

function boundText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= TRUNCATED_SUFFIX.length) return text.slice(0, maxChars);
  const keep = maxChars - TRUNCATED_SUFFIX.length;
  return `${text.slice(0, keep)}${TRUNCATED_SUFFIX}`;
}

/**
 * Format the parenthetical / message-only cause detail (no wrapping
 * base message). Empty when the summary has nothing useful.
 */
export function formatSdkCauseSuffix(
  cause: SdkCauseSummary,
  maxChars: number = MAX_SDK_CAUSE_DETAIL_CHARS,
): string {
  const parts: string[] = [];
  if (cause.status !== undefined) parts.push(`HTTP ${String(cause.status)}`);
  if (cause.code !== undefined && cause.code !== "") parts.push(cause.code);
  else if (cause.type !== undefined && cause.type !== "") parts.push(cause.type);

  const tails: string[] = [];
  if (cause.requestId !== undefined && cause.requestId !== "") {
    tails.push(`request_id ${cause.requestId}`);
  }
  if (cause.endpoint !== undefined && cause.endpoint !== "") {
    tails.push(cause.endpoint);
  }

  let head = parts.join(" ");
  if (tails.length > 0) {
    const tail = tails.join(", ");
    head = head === "" ? tail : `${head}, ${tail}`;
  }
  if (head !== "") return boundText(head, maxChars);
  if (cause.message !== undefined && cause.message !== "") {
    return boundText(cause.message, maxChars);
  }
  return "";
}

/**
 * Append a bounded cause suffix onto an existing failure detail
 * (`base (HTTP 400 …)`). No-op when the summary is empty or already
 * present in `detail`.
 */
export function foldSdkCauseIntoDetail(
  detail: string,
  cause: SdkCauseSummary | undefined,
  maxChars: number = MAX_SDK_CAUSE_DETAIL_CHARS,
): string {
  if (cause === undefined) return detail;
  const suffix = formatSdkCauseSuffix(cause, maxChars);
  if (suffix === "") return detail;
  if (detail === "") return suffix;
  if (detail.includes(suffix)) return detail;
  return `${detail} (${suffix})`;
}

/** Read `causeSummary` off an `AgentRunFailedError`-shaped value. */
export function causeSummaryFromThrown(err: unknown): SdkCauseSummary | undefined {
  if (err === null || typeof err !== "object") return undefined;
  if (!("causeSummary" in err)) return undefined;
  const summary = (err as { causeSummary?: unknown }).causeSummary;
  if (summary === null || typeof summary !== "object") return undefined;
  return summary as SdkCauseSummary;
}

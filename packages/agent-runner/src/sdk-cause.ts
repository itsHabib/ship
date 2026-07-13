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

/**
 * Overall detail bound after folding — matches `buildFailureDetail`'s
 * 512-char cap so append cannot bypass the persisted-row invariant.
 */
export const MAX_FOLDED_DETAIL_CHARS = 512;

const TRUNCATED_SUFFIX = "...";

function boundText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= TRUNCATED_SUFFIX.length) return text.slice(0, maxChars);
  const keep = maxChars - TRUNCATED_SUFFIX.length;
  return `${text.slice(0, keep)}${TRUNCATED_SUFFIX}`;
}

function codeOrType(cause: SdkCauseSummary): string | undefined {
  if (cause.code !== undefined && cause.code !== "") return cause.code;
  if (cause.type !== undefined && cause.type !== "") return cause.type;
  return undefined;
}

function formatCauseHead(cause: SdkCauseSummary): string {
  const parts: string[] = [];
  if (cause.status !== undefined) parts.push(`HTTP ${String(cause.status)}`);
  const label = codeOrType(cause);
  if (label !== undefined) parts.push(label);
  return parts.join(" ");
}

function formatCauseTails(cause: SdkCauseSummary): string {
  const tails: string[] = [];
  if (cause.requestId !== undefined && cause.requestId !== "") {
    tails.push(`request_id ${cause.requestId}`);
  }
  if (cause.endpoint !== undefined && cause.endpoint !== "") {
    tails.push(cause.endpoint);
  }
  return tails.join(", ");
}

/**
 * Format the parenthetical / message-only cause detail (no wrapping
 * base message). Empty when the summary has nothing useful.
 */
export function formatSdkCauseSuffix(
  cause: SdkCauseSummary,
  maxChars: number = MAX_SDK_CAUSE_DETAIL_CHARS,
): string {
  const head = formatCauseHead(cause);
  const tail = formatCauseTails(cause);
  if (head !== "" && tail !== "") return boundText(`${head}, ${tail}`, maxChars);
  if (head !== "") return boundText(head, maxChars);
  if (tail !== "") return boundText(tail, maxChars);
  if (cause.message !== undefined && cause.message !== "") {
    return boundText(cause.message, maxChars);
  }
  return "";
}

/**
 * Append a bounded cause suffix onto an existing failure detail
 * (`base (HTTP 400 …)`). No-op when the summary is empty or already
 * present in `detail`. Re-bounds the combined string so fold cannot
 * bypass the 512-char failure-detail invariant.
 */
export function foldSdkCauseIntoDetail(
  detail: string,
  cause: SdkCauseSummary | undefined,
  maxChars: number = MAX_SDK_CAUSE_DETAIL_CHARS,
  maxDetailChars: number = MAX_FOLDED_DETAIL_CHARS,
): string {
  if (cause === undefined) return boundText(detail, maxDetailChars);
  const suffix = formatSdkCauseSuffix(cause, maxChars);
  if (suffix === "") return boundText(detail, maxDetailChars);
  if (detail === "") return boundText(suffix, maxDetailChars);
  if (detail.includes(suffix)) return boundText(detail, maxDetailChars);
  return boundText(`${detail} (${suffix})`, maxDetailChars);
}

function isSdkCauseSummary(val: unknown): val is SdkCauseSummary {
  return val !== null && typeof val === "object";
}

/** Read `causeSummary` off an `AgentRunFailedError`-shaped value. */
export function causeSummaryFromThrown(err: unknown): SdkCauseSummary | undefined {
  if (err === null || typeof err !== "object") return undefined;
  if (!("causeSummary" in err)) return undefined;
  const summary = (err as { causeSummary?: unknown }).causeSummary;
  if (!isSdkCauseSummary(summary)) return undefined;
  return summary;
}

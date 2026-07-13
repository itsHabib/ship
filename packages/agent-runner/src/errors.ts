/**
 * Typed error subclasses for `@ship/agent-runner`. Provider-specific
 * subclasses live in their runner packages and extend `AgentRunFailedError`.
 */

import type { SdkCauseSummary } from "./sdk-cause.js";

/**
 * Thrown when a required API key env var is unset before any provider call.
 * The default message is provider-neutral; each provider adapter passes the
 * specific env var name it requires (e.g. cursor-runner names `CURSOR_API_KEY`).
 */
export class MissingApiKeyError extends Error {
  override readonly name = "MissingApiKeyError";

  constructor(message = "API key environment variable is not set") {
    super(message);
  }
}

export type AgentRunFailedErrorOptions = ErrorOptions & {
  readonly causeSummary?: SdkCauseSummary;
};

/**
 * Thrown when a provider cannot start or attach to a run. The original
 * error lives in `cause`. Post-run failures are NOT thrown — they surface
 * as `handle.result` resolving with `status: "failed"`.
 *
 * `causeSummary` carries a bounded, redacted extraction of discriminating
 * SDK fields (status/code/requestId/…) for finalize to fold into the
 * persisted `errorMessage` detail — the raw `cause` may hold non-enumerable
 * fields that disappear once the process exits.
 */
export class AgentRunFailedError extends Error {
  override readonly name: string = "AgentRunFailedError";
  readonly causeSummary?: SdkCauseSummary;

  constructor(message: string, options?: AgentRunFailedErrorOptions) {
    super(message, options);
    if (options?.causeSummary !== undefined) {
      this.causeSummary = options.causeSummary;
    }
  }
}

function renderPrimitiveCause(cause: unknown): string | undefined {
  if (cause instanceof Error && cause.message !== "") return cause.message;
  if (typeof cause === "string") return cause;
  if (typeof cause === "number" || typeof cause === "boolean" || typeof cause === "bigint") {
    return String(cause);
  }
  if (cause === null || cause === undefined) return "";
  return undefined;
}

function causeMessage(cause: unknown): string {
  const primitive = renderPrimitiveCause(cause);
  if (primitive !== undefined) return primitive;
  if (typeof cause === "function" || typeof cause === "symbol") return "[unstringifiable cause]";
  try {
    return JSON.stringify(cause);
  } catch {
    return "[unstringifiable cause]";
  }
}

/** Pre-run / stream failure with the underlying cause folded into `.message`. */
export function agentRunFailedError(message: string, cause: unknown): AgentRunFailedError {
  const detail = causeMessage(cause);
  const combined = detail !== "" && !message.includes(detail) ? `${message}: ${detail}` : message;
  return new AgentRunFailedError(combined, { cause });
}

/** Thrown when attach/resume targets a missing agent or artifact path. */
export class AgentNotFoundError extends AgentRunFailedError {
  override readonly name: string = "AgentNotFoundError";
  readonly agentId: string;
  readonly runId: string;

  constructor(args: { agentId: string; runId: string; message?: string; cause?: unknown }) {
    super(
      args.message ?? `Agent not found (agentId=${args.agentId}, runId=${args.runId})`,
      args.cause !== undefined ? { cause: args.cause } : undefined,
    );
    this.agentId = args.agentId;
    this.runId = args.runId;
  }
}

/**
 * Typed error subclasses for `@ship/cursor-runner`. Two top-level
 * categories of caller-discriminable failures:
 *
 *   1. `MissingApiKeyError` — env-var precondition before any SDK call.
 *   2. `CursorRunFailedError` + subclasses — the SDK could not start or
 *      attach to a run. Subclasses (`MissingCloudSpecError`,
 *      `InvalidCloudReposError`, `CursorCloudIntegrationError`,
 *      `WrongRunnerError`, `CursorAgentNotFoundError`,
 *      `LocalResumeNotSupportedError`) tag the specific cause; downstream
 *      catchers can match the umbrella `CursorRunFailedError` to handle
 *      any of them.
 *
 * Post-run SDK failures are NOT thrown — they surface as `handle.result`
 * resolving with `status: "failed"`.
 */

/** Thrown when `CURSOR_API_KEY` is unset (or empty) at `run()` time, before any SDK call. */
export class MissingApiKeyError extends Error {
  override readonly name = "MissingApiKeyError";

  constructor() {
    super("CURSOR_API_KEY environment variable is not set");
  }
}

/**
 * Thrown when `Agent.create` or `agent.send` rejects before the run
 * reaches a streaming state. The original SDK error lives in `cause`.
 * Not used for `RunResult.status === "error"` — see file-level comment.
 */
export class CursorRunFailedError extends Error {
  override readonly name: string = "CursorRunFailedError";
}

// Renders the directly-stringifiable primitive causes; returns undefined when
// `cause` is a non-primitive (object/function/symbol) the caller must handle.
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
  // JSON.stringify returns undefined for function/symbol; handle them explicitly
  // so the stringify below always yields a string for the remaining object case.
  if (typeof cause === "function" || typeof cause === "symbol") return "[unstringifiable cause]";
  try {
    return JSON.stringify(cause);
  } catch {
    return "[unstringifiable cause]";
  }
}

/**
 * Pre-run / stream failure with the underlying SDK message folded into
 * `.message` so single-level `errorMessage` consumers see the real cause.
 */
export function cursorRunFailedError(message: string, cause: unknown): CursorRunFailedError {
  const detail = causeMessage(cause);
  const combined = detail !== "" && !message.includes(detail) ? `${message}: ${detail}` : message;
  return new CursorRunFailedError(combined, { cause });
}

/** Cloud inputs passed to {@link CloudCursorRunner} without `cloud` config. */
export class MissingCloudSpecError extends CursorRunFailedError {
  override readonly name: string = "MissingCloudSpecError";

  constructor() {
    super("runtime: 'cloud' was set but input.cloud is undefined");
  }
}

/**
 * Cloud inputs passed to {@link CloudCursorRunner} whose `cloud.repos` array
 * doesn't match the single-repo contract (per phase 04 design § F2 / Out-of-scope).
 * Covers both empty (`length === 0`) and multi-repo (`length > 1`) cases.
 */
export class InvalidCloudReposError extends CursorRunFailedError {
  override readonly name: string = "InvalidCloudReposError";

  constructor(receivedLength: number) {
    super(
      `cloud.repos must contain exactly one repo entry; received length ${String(receivedLength)}`,
    );
  }
}

/** SCM integration is not connected for the target repo (SDK pre-run failure). */
export class CursorCloudIntegrationError extends CursorRunFailedError {
  override readonly name: string = "CursorCloudIntegrationError";

  constructor(
    public readonly provider: string,
    public readonly helpUrl: string,
    options?: { cause?: unknown },
  ) {
    super(
      `Cloud agent integration not connected for provider "${provider}". Visit ${helpUrl} to connect.`,
      options,
    );
  }
}

/** Wrong `input.runtime` for the selected runner implementation. */
export class WrongRunnerError extends CursorRunFailedError {
  override readonly name: string = "WrongRunnerError";
}

/**
 * Thrown when `Agent.resume` / `Agent.getRun` indicates the agent or run
 * is gone. Extends {@link CursorRunFailedError} so downstream catchers
 * that match the umbrella pre-run/attach failure type pick this up too.
 */
export class CursorAgentNotFoundError extends CursorRunFailedError {
  override readonly name: string = "CursorAgentNotFoundError";
  readonly agentId: string;
  readonly runId: string;
  readonly runtime: "local" | "cloud";

  constructor(args: {
    agentId: string;
    runId: string;
    runtime: "local" | "cloud";
    cause?: unknown;
  }) {
    super(
      `Cursor agent not found (agentId=${args.agentId}, runId=${args.runId}, runtime=${args.runtime})`,
      args.cause !== undefined ? { cause: args.cause } : undefined,
    );
    this.agentId = args.agentId;
    this.runId = args.runId;
    this.runtime = args.runtime;
  }
}

/**
 * Thrown by {@link LocalCursorRunner.attach} — local agents die with the
 * parent process, so resume is not supported. Extends
 * {@link CursorRunFailedError} for parity with the other attach failures.
 */
export class LocalResumeNotSupportedError extends CursorRunFailedError {
  override readonly name: string = "LocalResumeNotSupportedError";
  readonly agentId: string;

  constructor(args: { agentId: string }) {
    super(`Local agent resume is not supported (agentId=${args.agentId})`);
    this.agentId = args.agentId;
  }
}

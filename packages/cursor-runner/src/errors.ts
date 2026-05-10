/**
 * Typed error subclasses for `@ship/cursor-runner`. Two errors, two
 * paths the caller cares to discriminate. Post-run SDK failures are
 * NOT thrown — they surface as `handle.result` resolving with
 * `status: "failed"`.
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
  override readonly name = "CursorRunFailedError";
}

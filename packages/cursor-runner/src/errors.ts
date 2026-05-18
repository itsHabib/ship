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
  override readonly name: string = "CursorRunFailedError";
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

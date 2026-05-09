/**
 * Typed error subclasses for `@ship/cursor-runner`.
 *
 * Two errors, two distinct paths the caller cares to discriminate:
 *
 * 1. `MissingApiKeyError` — environment-level setup bug, thrown before any
 *    SDK call happens. The remedy is operator-side ("set CURSOR_API_KEY");
 *    no retry will help.
 * 2. `CursorRunFailedError` — wraps a *pre-run* SDK throw (`Agent.create`
 *    or `agent.send` itself rejected). The run never reached a streaming
 *    state, so there's no `RunResult` to inspect. The original SDK error
 *    is preserved in `cause` for diagnostics.
 *
 * **NOT thrown:** post-run SDK failures. When `RunResult.status === "error"`,
 * the runner resolves `handle.result` with `{ status: "failed",
 * errorMessage }` instead of throwing — failure is part of the normal
 * terminal-state vocabulary, surfaced through the result type the same
 * way `succeeded` is. The two paths are split so callers can react
 * differently: a thrown `CursorRunFailedError` may warrant a retry; a
 * resolved `failed` result is the agent's own verdict and goes straight
 * to the workflow row.
 *
 * Internal-invariant violations (e.g. the runner's terminal-state guard
 * tripped twice for the same handle) surface as plain `Error` and never
 * as one of these subclasses; if a caller ever sees one, it's a bug in
 * `@ship/cursor-runner` itself.
 */

/**
 * Thrown when `CURSOR_API_KEY` is unset (or empty) at the moment a runner
 * tries to start a run. Throws **before** any `Agent.create` call so the
 * SDK never receives a half-formed config.
 *
 * The key is read fresh on every `run()` call (per ED-1 / spec.md § Risks)
 * so a deploy that rotates the env var mid-process is immediately picked
 * up; correspondingly, an env that briefly lost the key surfaces here
 * rather than getting silently swallowed.
 */
export class MissingApiKeyError extends Error {
  /** Identifies the subclass at runtime without `instanceof`. */
  override readonly name = "MissingApiKeyError";

  constructor() {
    super("CURSOR_API_KEY environment variable is not set");
  }
}

/**
 * Thrown when the SDK rejects a `run()` call **before** the run itself
 * reaches a streaming state — i.e. `Agent.create` or `agent.send`
 * threw. The original SDK error is preserved in `cause` (use
 * `error.cause` to recover it) so callers can `instanceof`-check
 * against the SDK's own error classes (`AuthenticationError`,
 * `RateLimitError`, etc.) without losing the wrapping context.
 *
 * **Not used for `RunResult.status === "error"`.** Once the SDK has
 * accepted the prompt and a run exists, terminal failures resolve
 * `handle.result` with `status: "failed"`, not throw. See the
 * file-level comment for the rationale.
 *
 * No custom field on this class — the builtin `Error(message, { cause })`
 * form is exactly what we need; the subclass identity carries the
 * discriminating meaning. Callers throw with
 * `new CursorRunFailedError(msg, { cause: err })`.
 */
export class CursorRunFailedError extends Error {
  /** Identifies the subclass at runtime without `instanceof`. */
  override readonly name = "CursorRunFailedError";
}

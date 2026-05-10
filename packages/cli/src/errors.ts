/**
 * Maps thrown errors and `null` returns to the three-code CLI exit
 * convention from spec.md (`0 success, 1 user error, 2 internal error`).
 * Used by every subcommand's error handler so the contract stays
 * uniform; tests pin the mapping per error type.
 */

import { DocNotFoundError, DocPathEscapesWorkdirError, WorkdirNotFoundError } from "@ship/core";
import { WorkflowRunNotFoundError } from "@ship/store";

/** Per spec.md § "Internal interfaces". Exit code 0 is the absence of error. */
export type CliExitCode = 1 | 2;

/**
 * Thrown by subcommand argv parsing when the value of a flag is
 * structurally invalid (e.g. `--limit not-a-number`,
 * `--status banana`). Routed to exit 1 by `mapErrorToExitCode`.
 */
export class InvalidArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidArgumentError";
  }
}

/** True when the error is caused by bad caller input (missing flag, bad id, etc.). */
export function isUserError(err: unknown): boolean {
  // Pre-row validation throws from `@ship/core`.
  if (err instanceof WorkdirNotFoundError) return true;
  if (err instanceof DocNotFoundError) return true;
  if (err instanceof DocPathEscapesWorkdirError) return true;
  // Resource-not-found (cancel / status of unknown id) — store-level.
  if (err instanceof WorkflowRunNotFoundError) return true;
  // Argv-parse-time rejections from buildFilter etc.
  if (err instanceof InvalidArgumentError) return true;
  // Built-in "value out of range" — e.g. `listRuns` limit cap.
  if (err instanceof RangeError) return true;
  // Boundary schema rejections.
  if (err instanceof Error && err.name === "ZodError") return true;
  // Commander argv errors that bubble up as plain Error.
  if (
    err instanceof Error &&
    /missing required option|unknown option|too few arguments/i.test(err.message)
  ) {
    return true;
  }
  return false;
}

/** Routes an error to the right exit code for `mapErrorToExitCode`. */
export function mapErrorToExitCode(err: unknown): CliExitCode {
  return isUserError(err) ? 1 : 2;
}

/**
 * Each subcommand wraps its action body in `try/catch` so service-level
 * errors get mapped to user-vs-internal exit codes. But a `cliExit(1)`
 * call we make ourselves (e.g. for "not found" in `status`) also throws
 * — and would otherwise be caught + re-mapped, downgrading our
 * intentional exit-1 to exit-2. Re-throw `CliExit` directly so its code
 * stays authoritative; map everything else through `mapErrorToExitCode`.
 */
export function rethrowCliExitOrMap(err: unknown): CliExitCode {
  if (err instanceof CliExit) throw err;
  return mapErrorToExitCode(err);
}

/**
 * Throwable sentinel used in place of `process.exit` so tests can
 * catch it instead of the test runner aborting. The CLI binary's
 * top-level handler swaps it for an actual `process.exit(code)`.
 */
export class CliExit extends Error {
  readonly code: number;

  constructor(code: number, message?: string) {
    super(message ?? `cli exit ${code.toString()}`);
    this.code = code;
    this.name = "CliExit";
  }
}

/** Convenience throw helper — saves callers from constructing `CliExit` directly. */
export function cliExit(code: number, message?: string): never {
  throw new CliExit(code, message);
}

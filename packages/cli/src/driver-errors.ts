/**
 * Driver CLI exit-code contract (spec §4.1): 0 progress/done/blocked,
 * 10 awaiting judgment, 1 engine error. Distinct from the generic CLI
 * 1/2 split in `errors.ts`.
 */

import {
  AddressError,
  AssignError,
  CancelError,
  DecideError,
  DriverRunNotFoundEngineError,
  type DriverTickResult,
  ImportManifestError,
  PreconditionError,
  TickLiveError,
} from "@ship/driver";
import { DriverRunNotFoundError } from "@ship/store";

import { InvalidArgumentError } from "./errors.js";

// `@ship/driver` engine errors plus the store's row-not-found, which
// store-direct verbs (`render`) surface without an engine wrapper.
const DRIVER_ENGINE_ERROR_CLASSES: readonly (new (...args: never[]) => Error)[] = [
  TickLiveError,
  PreconditionError,
  DecideError,
  CancelError,
  AddressError,
  AssignError,
  DriverRunNotFoundEngineError,
  DriverRunNotFoundError,
  ImportManifestError,
];

/** Exit code for a successful driver tick (not an engine error). */
export type DriverTickExitCode = 0 | 10;

/** Maps a tick result status to the driver exit-code contract. */
export function driverTickExitCode(result: DriverTickResult): DriverTickExitCode {
  if (result.status === "awaiting_judgment") return 10;
  return 0;
}

/** True when the error is a typed `@ship/driver` engine error → exit 1. */
export function isDriverEngineError(err: unknown): boolean {
  return DRIVER_ENGINE_ERROR_CLASSES.some((c) => err instanceof c);
}

/** Maps argv / engine errors to driver exit 1; rethrows unknown errors. */
export function toDriverCliExitCode(err: unknown): 1 {
  if (err instanceof InvalidArgumentError) return 1;
  if (err instanceof RangeError) return 1;
  if (isDriverEngineError(err)) return 1;
  if (err instanceof Error && err.name === "ZodError") return 1;
  throw err;
}

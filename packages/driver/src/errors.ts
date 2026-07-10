/**
 * Typed engine errors — distinct from stream failures (spec §8).
 */

export class TickLiveError extends Error {
  override readonly name = "TickLiveError";
  readonly driverRunId: string;

  constructor(driverRunId: string) {
    super(`driver run ${driverRunId} has a live tick — retry with force or wait for staleness`);
    this.driverRunId = driverRunId;
  }
}

export class DriverRunNotFoundEngineError extends Error {
  override readonly name = "DriverRunNotFoundEngineError";
  readonly driverRunId: string;

  constructor(id: string) {
    super(`driver run not found: ${id}`);
    this.driverRunId = id;
  }
}

export class PreconditionError extends Error {
  override readonly name = "PreconditionError";
  readonly detail: string;

  constructor(message: string) {
    super(message);
    this.detail = message;
  }
}

export class DecideError extends Error {
  override readonly name = "DecideError";
  readonly detail: string;

  constructor(message: string) {
    super(message);
    this.detail = message;
  }
}

export class CancelError extends Error {
  override readonly name = "CancelError";
  readonly detail: string;

  constructor(message: string) {
    super(message);
    this.detail = message;
  }
}

/** One structured refusal reason for `driver address` (never a silent no-op). */
export type AddressRefusalCode =
  | "no-pr"
  | "pr-not-open"
  | "not-landed"
  | "not-cloud"
  | "run-not-addressable"
  | "cycle-exhausted"
  | "findings-unreadable"
  | "findings-invalid"
  | "findings-subject-mismatch"
  | "findings-stale-head"
  | "findings-duplicate"
  | "address-raced";

export class AddressError extends Error {
  override readonly name = "AddressError";
  readonly code: AddressRefusalCode;
  readonly detail: string;

  constructor(code: AddressRefusalCode, message: string) {
    super(message);
    this.code = code;
    this.detail = message;
  }
}

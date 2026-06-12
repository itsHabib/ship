/**
 * ID factories for driver store entities. Each ID is `<prefix>_<ulid>`.
 */

import { ulid } from "ulid";

/** Returns a new driver-run ID, e.g. `drv_01ARZ3NDEKTSV4RRFFQ69G5FAV`. */
export function newDriverRunId(): string {
  return `drv_${ulid()}`;
}

/** Returns a new driver-batch ID, e.g. `db_01ARZ3NDEKTSV4RRFFQ69G5FAV`. */
export function newDriverBatchId(): string {
  return `db_${ulid()}`;
}

/** Returns a new driver-stream ID, e.g. `ds_01ARZ3NDEKTSV4RRFFQ69G5FAV`. */
export function newDriverStreamId(): string {
  return `ds_${ulid()}`;
}

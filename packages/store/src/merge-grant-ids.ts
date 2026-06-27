/**
 * ID factories for merge-grant store entities.
 */

import { ulid } from "ulid";

/** Returns a new merge-grant ID, e.g. `mg_01ARZ3NDEKTSV4RRFFQ69G5FAV`. */
export function newMergeGrantId(): string {
  return `mg_${ulid()}`;
}

/** Returns a new satisfaction audit ID, e.g. `mgs_01ARZ3NDEKTSV4RRFFQ69G5FAV`. */
export function newMergeGrantSatisfactionId(): string {
  return `mgs_${ulid()}`;
}

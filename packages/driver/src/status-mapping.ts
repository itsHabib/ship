/**
 * Store stream status → manifest stream status mapping for render.
 *
 * | Store status   | Manifest status |
 * |----------------|-----------------|
 * | pending        | pending         |
 * | dispatching    | in_progress     |
 * | dispatched     | in_progress     |
 * | landed         | in_progress     |
 * | failed         | failed          |
 * | skipped        | skipped         |
 * | done           | done            |
 *
 * Transient dispatch states degrade to `in_progress` because the manifest
 * vocabulary has no dispatch states. Terminal/restable statuses round-trip
 * losslessly through import.
 */

import type { DriverStreamStatus } from "@ship/store";

import type { ManifestStream } from "./manifest.js";

type ManifestStreamStatus = NonNullable<ManifestStream["status"]>;

/** Maps a store stream status to the manifest frontmatter vocabulary. */
export function storeStatusToManifest(status: DriverStreamStatus): ManifestStreamStatus {
  switch (status) {
    case "dispatching":
    case "dispatched":
    case "landed":
      return "in_progress";
    case "pending":
      return "pending";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
  }
}

/** Maps a manifest stream status to the store vocabulary on import. */
export function manifestStatusToStore(
  status: ManifestStreamStatus | undefined,
): DriverStreamStatus {
  if (status === "done") return "done";
  if (status === "failed") return "failed";
  if (status === "skipped") return "skipped";
  if (status === "in_progress") return "pending";
  return "pending";
}

/** Maps a store batch status to manifest batch status vocabulary. */
export function storeBatchStatusToManifest(
  status: "pending" | "running" | "done" | "failed",
): "pending" | "running" | "in_progress" | "done" | "failed" {
  if (status === "running") return "running";
  return status;
}

/** Maps manifest batch status to store batch status on import. */
export function manifestBatchStatusToStore(
  status: ManifestBatchStatus | undefined,
  completedAt?: string,
): { status: "pending" | "running" | "done" | "failed"; completedAt?: string } {
  if (status === "done") {
    return completedAt === undefined ? { status: "done" } : { completedAt, status: "done" };
  }
  if (status === "failed") return { status: "failed" };
  return { status: "pending" };
}

type ManifestBatchStatus = "pending" | "running" | "in_progress" | "done" | "failed";

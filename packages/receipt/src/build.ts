/**
 * The pure join/dedupe core. Adapters (`manifestToReceipts`,
 * `loadShipRunReceipts`) produce receipts; this module merges them into a
 * stable, deduplicated dataset.
 *
 * `upsertReceipts` is idempotent by `${source}:${key}` — re-running a backfill
 * over the same artifacts never duplicates a row, matching the append-safe
 * discipline the hooks layer uses elsewhere in the workbench.
 */

import type { Receipt } from "./schema.js";

import { receiptIdentity } from "./schema.js";

/**
 * Upsert `incoming` over `existing`: same-identity rows are replaced, the rest
 * preserved. Applying the same `incoming` twice yields the same result.
 */
export function upsertReceipts(existing: Receipt[], incoming: Receipt[]): Receipt[] {
  const byIdentity = new Map<string, Receipt>();
  for (const receipt of existing) {
    byIdentity.set(receiptIdentity(receipt), receipt);
  }
  for (const receipt of incoming) {
    byIdentity.set(receiptIdentity(receipt), receipt);
  }
  return sortReceipts([...byIdentity.values()]);
}

/** Deterministic order: newest activity first, identity as the tiebreak. */
export function sortReceipts(receipts: Receipt[]): Receipt[] {
  return [...receipts].sort(compareReceipts);
}

function compareReceipts(a: Receipt, b: Receipt): number {
  const byTime = activityTime(b).localeCompare(activityTime(a));
  if (byTime !== 0) {
    return byTime;
  }
  return receiptIdentity(a).localeCompare(receiptIdentity(b));
}

function activityTime(receipt: Receipt): string {
  return (
    receipt.merged_at ?? receipt.terminal_at ?? receipt.generated_at ?? receipt.dispatched_at ?? ""
  );
}

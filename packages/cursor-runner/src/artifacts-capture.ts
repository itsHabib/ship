/**
 * Best-effort terminal artifact listing with a timeout so finalize
 * cannot hang on a stalled cloud SDK call.
 */

import { type ArtifactRef, artifactRefSchema } from "@ship/workflow";

/** Best-effort cap on terminal `listArtifacts()` so finalize cannot hang. */
export const LIST_ARTIFACTS_TIMEOUT_MS = 15_000;

class ListArtifactsTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`listArtifacts did not complete within ${timeoutMs.toString()}ms`);
    this.name = "ListArtifactsTimeoutError";
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          void promise.catch(() => undefined);
          reject(new ListArtifactsTimeoutError(timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function logListArtifactsFailure(err: unknown): void {
  try {
    const message = err instanceof Error ? err.message : String(err);
    const label =
      err instanceof ListArtifactsTimeoutError ? "listArtifacts timed out" : "listArtifacts failed";
    process.stderr.write(`[ship-cloud-warn] ${label}: ${message}\n`);
  } catch {
    /* swallow — diagnostic logging must never affect control flow */
  }
}

/** Runs `listArtifacts`, logs on failure/timeout, returns refs or `[]`. */
export async function captureListedArtifacts(
  listArtifacts: () => Promise<unknown>,
): Promise<readonly ArtifactRef[]> {
  try {
    const listed = await withTimeout(listArtifacts(), LIST_ARTIFACTS_TIMEOUT_MS);
    if (!Array.isArray(listed)) return [];
    return listed.flatMap((a): ArtifactRef[] => {
      if (typeof a !== "object" || a === null) return [];
      const rec = a as Record<string, unknown>;
      // Validate against the canonical schema (the same one @ship/store enforces
      // on persist) so a malformed SDK entry is dropped here rather than throwing
      // during finalize. Pick known fields first — artifactRefSchema is .strict().
      const parsed = artifactRefSchema.safeParse({
        path: rec["path"],
        sizeBytes: rec["sizeBytes"],
        updatedAt: rec["updatedAt"],
      });
      return parsed.success ? [parsed.data] : [];
    });
  } catch (err) {
    logListArtifactsFailure(err);
    return [];
  }
}

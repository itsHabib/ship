/**
 * Append-only JSON-lines writer for `events.ndjson`. Wraps a Node
 * `Writable` opened in append mode; one `JSON.stringify(event)` +
 * `\n` per `write()` call.
 */

import type { ShipFs } from "../fs/shape.js";

export interface EventWriter {
  /** Serialize and append one event. Synchronous from the caller's view. */
  write(event: unknown): void;
  /**
   * Flush + close the underlying stream. Idempotent. Rejects with
   * the first error the stream emitted (if any) — see notes on
   * `createNdjsonEventWriter` for why error surfacing flows through
   * `close()` rather than back through `write()`.
   */
  close(): Promise<void>;
}

/**
 * Wraps `fs.createWriteStream(targetPath, { flags: "a" })` with an
 * NDJSON-shaped surface.
 *
 * Stream errors (ENOSPC mid-write, ENOENT for a missing parent, etc.)
 * surface via Node's stream `error` event, which by default crashes
 * the process if no listener is attached. The writer attaches an
 * internal `error` listener at construction so a single failed run
 * never tears the host process down. The first error captured is
 * remembered and surfaced via the next `close()`'s rejection — the
 * caller learns about IO failures without having to listen for stream
 * events themselves, and `write()` stays synchronous fire-and-forget.
 */
export function createNdjsonEventWriter(fs: ShipFs, targetPath: string): EventWriter {
  const stream = fs.createWriteStream(targetPath, { flags: "a" });
  let closed = false;
  let firstError: Error | null = null;

  stream.on("error", (err: Error) => {
    firstError ??= err;
  });

  return {
    write(event): void {
      stream.write(`${JSON.stringify(event)}\n`);
    },
    close(): Promise<void> {
      if (closed) return Promise.resolve();
      closed = true;
      return new Promise<void>((resolve, reject) => {
        let settled = false;
        const settle = (): void => {
          if (settled) return;
          settled = true;
          if (firstError !== null) reject(firstError);
          else resolve();
        };

        // Wait for `close` rather than `finish` because `close` fires
        // after both the error path (error → close) and the success
        // path (finish → close), letting `firstError` settle either
        // way before we read it.
        stream.once("close", settle);

        if (stream.destroyed) {
          // The stream was destroyed before `close()` ran — typically a
          // sync-destroy at construction (e.g. memory FS surfacing
          // ENOENT for a missing parent dir). The 'close' event may
          // have already fired, in which case `once("close")` would
          // never trigger; and skipping `end()` removes the only path
          // to a deferred 'close'. Schedule a fallback settle on
          // `setImmediate` so we resolve after any pending error/close
          // events have fired and `firstError` has been captured.
          setImmediate(settle);
        } else {
          stream.end();
        }
      });
    },
  };
}

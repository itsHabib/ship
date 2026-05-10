/**
 * Append-only JSON-lines writer for `events.ndjson`. Wraps a Node
 * `WritableStream` opened in append mode; one `JSON.stringify(event)` +
 * `\n` per `write()` call.
 */

import type { ShipFs } from "../fs/shape.js";

export interface EventWriter {
  /** Serialize and append one event. Synchronous from the caller's view. */
  write(event: unknown): void;
  /** Flush + close the underlying stream. Idempotent. */
  close(): Promise<void>;
}

export function createNdjsonEventWriter(fs: ShipFs, targetPath: string): EventWriter {
  const stream = fs.createWriteStream(targetPath, { flags: "a" });
  let closed = false;

  return {
    write(event): void {
      stream.write(`${JSON.stringify(event)}\n`);
    },
    close(): Promise<void> {
      if (closed) return Promise.resolve();
      closed = true;
      return new Promise<void>((resolve, reject) => {
        stream.end((err?: Error | null) => {
          if (err !== null && err !== undefined) reject(err);
          else resolve();
        });
      });
    },
  };
}

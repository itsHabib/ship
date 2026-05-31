/**
 * Filesystem methods `core` depends on. Kept tight — only what
 * `ShipService` actually calls. Both `createNodeShipFs` and
 * `createMemoryShipFs` satisfy this shape.
 */

import type { Writable } from "node:stream";

export interface FileStat {
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface ShipFs {
  /** Throws if the path doesn't exist (matches `node:fs` behavior). */
  stat(path: string): Promise<FileStat>;
  readFile(path: string, encoding: "utf-8"): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  /** Binary write for cloud artifact downloads. */
  writeFileBytes(path: string, data: Buffer): Promise<void>;
  /** Recursive mkdir. No-op if already present. */
  mkdir(path: string, opts: { recursive: true }): Promise<void>;
  /**
   * Append-mode writable. The caller `.write()`s lines and `.end()`s
   * to flush+close. Open-time failures (e.g. missing parent dir) and
   * mid-stream IO errors surface asynchronously via the stream's
   * `error` event — same contract as `node:fs.createWriteStream`.
   */
  createWriteStream(path: string, opts: { flags: "a" }): Writable;
  /**
   * Resolves a symlinked path to its real target. Used by symlink-escape
   * checks; matches `node:fs/promises`'s `realpath`.
   */
  realpath(path: string): Promise<string>;
}

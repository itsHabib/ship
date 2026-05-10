/**
 * In-memory `ShipFs` — backs unit + scenario tests so they don't hit
 * disk. File contents and directory entries live in two `Map`s; the
 * shape mirrors the Node API closely enough that production code paths
 * exercise the same logic.
 */

import { Writable } from "node:stream";

import type { FileStat, ShipFs } from "./shape.js";

interface MemoryFs {
  readonly files: Map<string, string>;
  readonly dirs: Set<string>;
}

const ENOENT = (path: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`ENOENT: no such file or directory, ${path}`), {
    code: "ENOENT",
    errno: -2,
    path,
    syscall: "stat",
  });

const fileStat = (isFile: boolean): FileStat => ({
  isFile: () => isFile,
  isDirectory: () => !isFile,
});

export interface MemoryShipFs extends ShipFs {
  /** Read the snapshot of the in-memory store. Useful for test assertions. */
  readonly snapshot: () => { files: Map<string, string>; dirs: Set<string> };
}

export function createMemoryShipFs(): MemoryShipFs {
  const fs: MemoryFs = { files: new Map(), dirs: new Set(["/"]) };

  const ensureParentDir = (path: string): void => {
    const parent = parentDir(path);
    if (parent !== "" && !fs.dirs.has(parent)) {
      throw ENOENT(parent);
    }
  };

  return {
    stat: (path) => {
      const norm = normalize(path);
      if (fs.files.has(norm)) return Promise.resolve(fileStat(true));
      if (fs.dirs.has(norm)) return Promise.resolve(fileStat(false));
      return Promise.reject(ENOENT(path));
    },
    readFile: (path) => {
      const content = fs.files.get(normalize(path));
      if (content === undefined) return Promise.reject(ENOENT(path));
      return Promise.resolve(content);
    },
    writeFile: (path, data) => {
      const norm = normalize(path);
      try {
        ensureParentDir(norm);
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
      fs.files.set(norm, data);
      return Promise.resolve();
    },
    mkdir: (path, _opts) => {
      // Recursive only — `ShipFs.mkdir` types `opts.recursive: true`.
      // Walk every ancestor and add it; idempotent on existing dirs.
      const norm = normalize(path);
      const parts = normalizeParts(norm);
      let prefix = norm.startsWith("/") ? "/" : "";
      for (const part of parts) {
        prefix = joinPart(prefix, part);
        fs.dirs.add(prefix);
      }
      return Promise.resolve();
    },
    createWriteStream: (path, _opts) => {
      // Mirrors `node:fs.createWriteStream`: open-time failures (missing
      // parent dir, bad path) surface via the stream's `error` event on a
      // later tick rather than throwing synchronously. The writer the
      // memory FS hands back is the same shape consumers see in
      // production, so test code paths exercise the same error wiring.
      const norm = normalize(path);
      const parent = parentDir(norm);
      const parentMissing = parent !== "" && !fs.dirs.has(parent);

      if (parentMissing) {
        const failed = new Writable({
          write: (_chunk, _enc, cb) => {
            cb();
          },
          final: (cb) => {
            cb();
          },
        });
        // Synchronous destroy sets the destroyed flag immediately while
        // emitting the 'error' (and subsequent 'close') events on a
        // later tick — same observable contract as `node:fs`.
        failed.destroy(ENOENT(path));
        return failed;
      }

      const chunks: string[] = [fs.files.get(norm) ?? ""];
      return new Writable({
        write(chunk, _enc, cb): void {
          chunks.push(typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf-8"));
          cb();
        },
        final(cb): void {
          fs.files.set(norm, chunks.join(""));
          cb();
        },
      });
    },
    realpath: (path) => {
      const norm = normalize(path);
      // No symlinks in the memory FS — realpath is identity if the
      // path resolves to a known file or directory.
      if (fs.files.has(norm) || fs.dirs.has(norm)) return Promise.resolve(norm);
      return Promise.reject(ENOENT(path));
    },
    snapshot: () => ({ files: new Map(fs.files), dirs: new Set(fs.dirs) }),
  };
}

/**
 * Canonicalizes a path so the memory FS treats POSIX (`/foo/bar`) and
 * Win32 (`\foo\bar` or `/foo\bar`) forms as the same key. Production
 * `node:fs` handles separators platform-natively; the memory FS picks
 * POSIX as its canonical form so cross-platform tests don't fight it.
 */
function normalize(path: string): string {
  return path.replace(/\\/g, "/");
}

function parentDir(path: string): string {
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return path.startsWith("/") ? "/" : "";
  return path.slice(0, idx);
}

function normalizeParts(path: string): string[] {
  return path.split("/").filter((p) => p.length > 0);
}

function joinPart(prefix: string, part: string): string {
  if (prefix === "" || prefix === "/") return `${prefix}${part}`;
  return `${prefix}/${part}`;
}

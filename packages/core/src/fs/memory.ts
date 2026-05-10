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
      if (fs.files.has(path)) return Promise.resolve(fileStat(true));
      if (fs.dirs.has(path)) return Promise.resolve(fileStat(false));
      return Promise.reject(ENOENT(path));
    },
    readFile: (path) => {
      const content = fs.files.get(path);
      if (content === undefined) return Promise.reject(ENOENT(path));
      return Promise.resolve(content);
    },
    writeFile: (path, data) => {
      try {
        ensureParentDir(path);
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
      fs.files.set(path, data);
      return Promise.resolve();
    },
    mkdir: (path, _opts) => {
      // Recursive only — `ShipFs.mkdir` types `opts.recursive: true`.
      // Walk every ancestor and add it; idempotent on existing dirs.
      const parts = normalizeParts(path);
      let prefix = path.startsWith("/") ? "/" : "";
      for (const part of parts) {
        prefix = joinPart(prefix, part);
        fs.dirs.add(prefix);
      }
      return Promise.resolve();
    },
    createWriteStream: (path, _opts) => {
      ensureParentDir(path);
      const chunks: string[] = [fs.files.get(path) ?? ""];
      return new Writable({
        write(chunk, _enc, cb): void {
          chunks.push(typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf-8"));
          cb();
        },
        final(cb): void {
          fs.files.set(path, chunks.join(""));
          cb();
        },
      });
    },
    realpath: (path) => {
      // No symlinks in the memory FS — realpath is identity if the
      // path resolves to a known file or directory.
      if (fs.files.has(path) || fs.dirs.has(path)) return Promise.resolve(path);
      return Promise.reject(ENOENT(path));
    },
    snapshot: () => ({ files: new Map(fs.files), dirs: new Set(fs.dirs) }),
  };
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

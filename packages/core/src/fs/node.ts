/** `ShipFs` over `node:fs/promises` + `node:fs`. Production wiring. */

import { createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";

import type { ShipFs } from "./shape.js";

export function createNodeShipFs(): ShipFs {
  return {
    stat: (path) => stat(path),
    lstat: (path) => lstat(path),
    readFile: (path, encoding) => readFile(path, encoding),
    writeFile: (path, data) => writeFile(path, data, "utf-8"),
    writeFileBytes: (path, data) => writeFile(path, data),
    mkdir: async (path, opts) => {
      await mkdir(path, opts);
    },
    createWriteStream: (path, opts) => createWriteStream(path, opts),
    realpath: (path) => realpath(path),
  };
}

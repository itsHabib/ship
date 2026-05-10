/** Smoke test for `createNodeShipFs` — round-trips against a tmpdir. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createNodeShipFs } from "./node.js";

describe("createNodeShipFs", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ship-core-fs-"));
  });

  afterEach(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  test("writeFile + readFile round-trip", async () => {
    const fs = createNodeShipFs();
    const path = join(dir, "a.md");
    await fs.writeFile(path, "hello");
    expect(await fs.readFile(path, "utf-8")).toBe("hello");
  });

  test("stat returns isFile for files and isDirectory for dirs", async () => {
    const fs = createNodeShipFs();
    await fs.mkdir(join(dir, "sub"), { recursive: true });
    await fs.writeFile(join(dir, "sub", "f"), "");
    expect((await fs.stat(join(dir, "sub"))).isDirectory()).toBe(true);
    expect((await fs.stat(join(dir, "sub", "f"))).isFile()).toBe(true);
  });

  test("createWriteStream appends; data persists through end()", async () => {
    const fs = createNodeShipFs();
    const path = join(dir, "log.ndjson");
    await fs.writeFile(path, "");
    const stream = fs.createWriteStream(path, { flags: "a" });
    stream.write("a\n");
    stream.write("b\n");
    await new Promise<void>((resolve, reject) => {
      stream.end((err?: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
    expect(await fs.readFile(path, "utf-8")).toBe("a\nb\n");
  });

  test("realpath returns the canonical path", async () => {
    const fs = createNodeShipFs();
    await fs.writeFile(join(dir, "x"), "");
    const real = await fs.realpath(join(dir, "x"));
    expect(real.endsWith("x")).toBe(true);
  });
});

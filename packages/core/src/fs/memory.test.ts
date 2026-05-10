/** Tests for `createMemoryShipFs` — round-trips, mkdir recursion, write stream. */

import { describe, expect, test } from "vitest";

import { createMemoryShipFs } from "./memory.js";

describe("createMemoryShipFs", () => {
  test("writeFile + readFile round-trip", async () => {
    const fs = createMemoryShipFs();
    await fs.mkdir("/runs", { recursive: true });
    await fs.writeFile("/runs/a.md", "hello");
    expect(await fs.readFile("/runs/a.md", "utf-8")).toBe("hello");
  });

  test("readFile on missing path rejects with ENOENT", async () => {
    const fs = createMemoryShipFs();
    await expect(fs.readFile("/nope", "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("stat distinguishes files from directories", async () => {
    const fs = createMemoryShipFs();
    await fs.mkdir("/d", { recursive: true });
    await fs.writeFile("/d/f.txt", "");
    expect((await fs.stat("/d")).isDirectory()).toBe(true);
    expect((await fs.stat("/d/f.txt")).isFile()).toBe(true);
  });

  test("stat on missing path rejects with ENOENT", async () => {
    const fs = createMemoryShipFs();
    await expect(fs.stat("/nope")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("mkdir recursive creates every ancestor", async () => {
    const fs = createMemoryShipFs();
    await fs.mkdir("/a/b/c/d", { recursive: true });
    expect((await fs.stat("/a")).isDirectory()).toBe(true);
    expect((await fs.stat("/a/b")).isDirectory()).toBe(true);
    expect((await fs.stat("/a/b/c")).isDirectory()).toBe(true);
    expect((await fs.stat("/a/b/c/d")).isDirectory()).toBe(true);
  });

  test("mkdir recursive on existing dir is a no-op", async () => {
    const fs = createMemoryShipFs();
    await fs.mkdir("/a", { recursive: true });
    await expect(fs.mkdir("/a", { recursive: true })).resolves.toBeUndefined();
  });

  test("writeFile to a missing parent rejects with ENOENT", async () => {
    const fs = createMemoryShipFs();
    await expect(fs.writeFile("/nope/file", "x")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("createWriteStream appends in chunk order; commit on end()", async () => {
    const fs = createMemoryShipFs();
    await fs.mkdir("/d", { recursive: true });
    const stream = fs.createWriteStream("/d/log.ndjson", { flags: "a" });
    stream.write("line1\n");
    stream.write("line2\n");
    await new Promise<void>((resolve, reject) => {
      stream.end((err?: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
    expect(await fs.readFile("/d/log.ndjson", "utf-8")).toBe("line1\nline2\n");
  });

  test("createWriteStream over a missing parent emits an async error event (matches node:fs)", async () => {
    const fs = createMemoryShipFs();
    const stream = fs.createWriteStream("/missing/file", { flags: "a" });
    const err = await new Promise<NodeJS.ErrnoException>((resolve) => {
      stream.on("error", (e: NodeJS.ErrnoException) => {
        resolve(e);
      });
    });
    expect(err.code).toBe("ENOENT");
  });

  test("createWriteStream in append mode preserves prior content", async () => {
    const fs = createMemoryShipFs();
    await fs.mkdir("/d", { recursive: true });
    await fs.writeFile("/d/log.ndjson", "first\n");
    const stream = fs.createWriteStream("/d/log.ndjson", { flags: "a" });
    stream.write("second\n");
    await new Promise<void>((resolve, reject) => {
      stream.end((err?: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
    expect(await fs.readFile("/d/log.ndjson", "utf-8")).toBe("first\nsecond\n");
  });

  test("realpath returns the path for files + dirs; rejects for missing", async () => {
    const fs = createMemoryShipFs();
    await fs.mkdir("/d", { recursive: true });
    await fs.writeFile("/d/f", "");
    expect(await fs.realpath("/d")).toBe("/d");
    expect(await fs.realpath("/d/f")).toBe("/d/f");
    await expect(fs.realpath("/nope")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("snapshot returns a frozen view (mutation doesn't affect the live FS)", async () => {
    const fs = createMemoryShipFs();
    await fs.mkdir("/d", { recursive: true });
    await fs.writeFile("/d/a", "x");
    const snap = fs.snapshot();
    snap.files.set("/d/a", "tampered");
    expect(await fs.readFile("/d/a", "utf-8")).toBe("x");
  });
});

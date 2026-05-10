/** Tests for `createNdjsonEventWriter`. Backed by the in-memory fs. */

import { describe, expect, test } from "vitest";

import { createMemoryShipFs } from "../fs/memory.js";
import { createNdjsonEventWriter } from "./ndjson.js";

describe("createNdjsonEventWriter", () => {
  test("one JSON line per write; trailing newline; ordering preserved", async () => {
    const fs = createMemoryShipFs();
    await fs.mkdir("/runs/wf_1", { recursive: true });
    const w = createNdjsonEventWriter(fs, "/runs/wf_1/events.ndjson");
    w.write({ type: "assistant", n: 1 });
    w.write({ type: "status", n: 2 });
    w.write({ type: "assistant", n: 3 });
    await w.close();

    const content = await fs.readFile("/runs/wf_1/events.ndjson", "utf-8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => JSON.parse(l) as { n: number }).map((e) => e.n)).toEqual([1, 2, 3]);
    // Trailing newline is preserved.
    expect(content.endsWith("\n")).toBe(true);
  });

  test("close() is idempotent", async () => {
    const fs = createMemoryShipFs();
    await fs.mkdir("/runs/wf_1", { recursive: true });
    const w = createNdjsonEventWriter(fs, "/runs/wf_1/events.ndjson");
    await w.close();
    await expect(w.close()).resolves.toBeUndefined();
  });

  test("appends to existing content (preserves prior lines)", async () => {
    const fs = createMemoryShipFs();
    await fs.mkdir("/runs/wf_1", { recursive: true });
    await fs.writeFile("/runs/wf_1/events.ndjson", '{"prior":1}\n');
    const w = createNdjsonEventWriter(fs, "/runs/wf_1/events.ndjson");
    w.write({ next: 1 });
    await w.close();

    const content = await fs.readFile("/runs/wf_1/events.ndjson", "utf-8");
    expect(content).toBe('{"prior":1}\n{"next":1}\n');
  });

  test("stream-level error (e.g. missing parent dir) surfaces via close()'s rejection, not via a sync throw", async () => {
    const fs = createMemoryShipFs();
    const w = createNdjsonEventWriter(fs, "/missing/events.ndjson");
    w.write({ noted: true });
    await expect(w.close()).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("close() called twice after a stream error returns a single rejection then resolves", async () => {
    const fs = createMemoryShipFs();
    const w = createNdjsonEventWriter(fs, "/missing/events.ndjson");
    await expect(w.close()).rejects.toMatchObject({ code: "ENOENT" });
    await expect(w.close()).resolves.toBeUndefined();
  });

  test("close() settles even when the stream's 'close' event fired before close() ran", async () => {
    // Open a writer over a missing parent → stream is sync-destroyed.
    // Drain the event loop so the open-time 'error' and 'close' events
    // fire BEFORE `close()` is invoked. Without the setImmediate
    // fallback, `once("close")` would never trigger and the promise
    // would hang.
    const fs = createMemoryShipFs();
    const w = createNdjsonEventWriter(fs, "/missing/events.ndjson");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await expect(w.close()).rejects.toMatchObject({ code: "ENOENT" });
  });
});

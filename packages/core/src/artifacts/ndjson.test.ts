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

  test("write to a stream over a non-existent parent dir surfaces ENOENT eagerly", () => {
    const fs = createMemoryShipFs();
    expect(() => createNdjsonEventWriter(fs, "/missing/events.ndjson")).toThrow(/ENOENT/);
  });
});

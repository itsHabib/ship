/** Tests for `createNdjsonEventWriter`. Backed by the in-memory fs. */

import { describe, expect, test } from "vitest";

import { createMemoryShipFs } from "../fs/memory.js";
import { prepareEventForPersist } from "./event-persist.js";
import { createNdjsonEventWriter } from "./ndjson.js";

describe("prepareEventForPersist", () => {
  test("stamps ts when absent", () => {
    const prepared = prepareEventForPersist({ type: "assistant" }) as { ts?: string };
    expect(prepared.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("preserves SDK ts and startedAt without overwriting", () => {
    const withTs = prepareEventForPersist({ type: "status", ts: "2026-07-02T12:00:00.000Z" }) as {
      ts: string;
    };
    expect(withTs.ts).toBe("2026-07-02T12:00:00.000Z");

    const withStartedAt = prepareEventForPersist({
      type: "status",
      startedAt: "2026-07-02T12:01:00.000Z",
    }) as { ts?: string; startedAt: string };
    expect(withStartedAt.startedAt).toBe("2026-07-02T12:01:00.000Z");
    expect(withStartedAt.ts).toBeUndefined();
  });

  test("adds exit_code from structured shell result on completed tool_call", () => {
    const prepared = prepareEventForPersist({
      type: "tool_call",
      status: "completed",
      name: "shell",
      result: { stdout: "", stderr: "fail", exitCode: 1 },
    }) as { exit_code?: number; status: string };
    expect(prepared.exit_code).toBe(1);
    expect(prepared.status).toBe("completed");
  });

  test("adds exit_code from exit_code alias on structured shell result", () => {
    const prepared = prepareEventForPersist({
      type: "tool_call",
      status: "completed",
      name: "shell",
      result: { exit_code: 2 },
    }) as { exit_code?: number };
    expect(prepared.exit_code).toBe(2);
  });

  test("does not add exit_code for non-shell tool_call rows", () => {
    const prepared = prepareEventForPersist({
      type: "tool_call",
      status: "completed",
      name: "grep",
      result: { exitCode: 1 },
    }) as { exit_code?: number };
    expect(prepared.exit_code).toBeUndefined();
  });

  test("does not add exit_code when result is free text", () => {
    const prepared = prepareEventForPersist({
      type: "tool_call",
      status: "completed",
      name: "shell",
      result: "command failed",
    }) as { exit_code?: number };
    expect(prepared.exit_code).toBeUndefined();
  });

  test("preserves error-status tool_call rows verbatim aside from ts", () => {
    const prepared = prepareEventForPersist({
      type: "tool_call",
      status: "error",
      name: "shell",
      result: "database is locked",
    }) as { status: string; ts?: string };
    expect(prepared.status).toBe("error");
    expect(prepared.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("does not add exit_code to non-completed shell rows", () => {
    const running = prepareEventForPersist({
      type: "tool_call",
      status: "running",
      name: "shell",
      result: { exitCode: 0 },
    }) as { exit_code?: number };
    expect(running.exit_code).toBeUndefined();

    const errored = prepareEventForPersist({
      type: "tool_call",
      status: "error",
      name: "shell",
      result: { exitCode: 137 },
    }) as { exit_code?: number };
    expect(errored.exit_code).toBeUndefined();
  });

  test("never overwrites an SDK-provided exit_code field", () => {
    const prepared = prepareEventForPersist({
      type: "tool_call",
      status: "completed",
      name: "shell",
      exit_code: 3,
      result: { exitCode: 1 },
    }) as { exit_code?: number };
    expect(prepared.exit_code).toBe(3);
  });

  test("non-object events pass through unchanged", () => {
    expect(prepareEventForPersist("raw")).toBe("raw");
  });
});

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

  test("prepareEventForPersist fields round-trip through the writer", async () => {
    const fs = createMemoryShipFs();
    await fs.mkdir("/runs/wf_1", { recursive: true });
    const w = createNdjsonEventWriter(fs, "/runs/wf_1/events.ndjson");
    w.write(
      prepareEventForPersist({
        type: "tool_call",
        status: "completed",
        name: "shell",
        result: { exitCode: 1 },
      }),
    );
    await w.close();

    const line = (await fs.readFile("/runs/wf_1/events.ndjson", "utf-8")).trim();
    const parsed = JSON.parse(line) as { exit_code?: number; ts?: string; status: string };
    expect(parsed.status).toBe("completed");
    expect(parsed.exit_code).toBe(1);
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
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

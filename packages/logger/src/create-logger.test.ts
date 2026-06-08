import { Writable } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createLogger } from "./index.js";

function captureStream(): { stream: Writable; chunks: string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      callback();
    },
  });
  return { chunks, stream };
}

describe("createLogger", () => {
  const originalShipLogLevel = process.env["SHIP_LOG_LEVEL"];
  const originalNodeEnv = process.env["NODE_ENV"];

  afterEach(() => {
    if (originalShipLogLevel === undefined) {
      delete process.env["SHIP_LOG_LEVEL"];
    } else {
      process.env["SHIP_LOG_LEVEL"] = originalShipLogLevel;
    }

    if (originalNodeEnv === undefined) {
      delete process.env["NODE_ENV"];
    } else {
      process.env["NODE_ENV"] = originalNodeEnv;
    }

    vi.restoreAllMocks();
  });

  test("below-level call is a noop", () => {
    const { chunks, stream } = captureStream();
    const log = createLogger({ level: "warn", pretty: false, stream });

    log.info({ event: "ignored" }, "below level");

    expect(chunks).toHaveLength(0);
  });

  test("writes JSON shape to the configured stream", () => {
    const { chunks, stream } = captureStream();
    const log = createLogger({ level: "info", pretty: false, stream });

    log.warn({ workflowRunId: "wf_01", phase: "implement" }, "test message");

    expect(chunks.length).toBeGreaterThan(0);
    const line = chunks.join("").trim();
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed["msg"]).toBe("test message");
    expect(parsed["workflowRunId"]).toBe("wf_01");
    expect(parsed["phase"]).toBe("implement");
    expect(parsed["level"]).toBe(40);
  });

  test("child() binds fields onto every subsequent line", () => {
    const { chunks, stream } = captureStream();
    const log = createLogger({ level: "info", pretty: false, stream });
    const child = log.child({ cursorRunId: "cr_01", workflowRunId: "wf_01" });

    child.info({ extra: "value" }, "child message");

    const parsed = JSON.parse(chunks.join("").trim()) as Record<string, unknown>;
    expect(parsed["workflowRunId"]).toBe("wf_01");
    expect(parsed["cursorRunId"]).toBe("cr_01");
    expect(parsed["extra"]).toBe("value");
    expect(parsed["msg"]).toBe("child message");
  });

  test("defaults stream to process.stderr", () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const log = createLogger({ level: "info", pretty: false });

    log.info({}, "stderr default");

    expect(writeSpy).toHaveBeenCalled();
  });

  test("does not mutate global process.stderr.write", () => {
    const originalWrite = process.stderr.write;
    createLogger({ level: "info", pretty: false });
    expect(process.stderr.write).toBe(originalWrite);
  });

  test("swallows write errors", () => {
    const failingStream = new Writable({
      write(_chunk, _encoding, _callback) {
        throw new Error("write failed");
      },
    });
    const log = createLogger({ level: "info", pretty: false, stream: failingStream });

    expect(() => {
      log.error({ failureCategory: "unknown" }, "must not throw");
    }).not.toThrow();
  });

  test("reads level from SHIP_LOG_LEVEL", () => {
    process.env["SHIP_LOG_LEVEL"] = "error";
    const { chunks, stream } = captureStream();
    const log = createLogger({ pretty: false, stream });

    log.warn({}, "filtered by env level");

    expect(chunks).toHaveLength(0);
  });

  test("does not require pino-pretty outside development", () => {
    process.env["NODE_ENV"] = "production";
    const { chunks, stream } = captureStream();
    const log = createLogger({ level: "info", stream });

    log.info({ mode: "prod" }, "json only");

    expect(chunks.length).toBeGreaterThan(0);
    const parsed = JSON.parse(chunks.join("").trim()) as Record<string, unknown>;
    expect(parsed["msg"]).toBe("json only");
    expect(parsed["mode"]).toBe("prod");
  });

  test("uses pino-pretty in development when pretty is enabled", () => {
    process.env["NODE_ENV"] = "development";
    const log = createLogger({ level: "info" });

    expect(() => {
      log.debug({ probe: "dev" }, "development pretty path");
    }).not.toThrow();
  });

  test("honors explicit level option over SHIP_LOG_LEVEL", () => {
    process.env["SHIP_LOG_LEVEL"] = "error";
    const { chunks, stream } = captureStream();
    const log = createLogger({ level: "info", pretty: false, stream });

    log.info({}, "explicit level wins");

    expect(chunks.length).toBeGreaterThan(0);
  });

  test("exposes all severity methods", () => {
    const { chunks, stream } = captureStream();
    const log = createLogger({ level: "debug", pretty: false, stream });

    log.debug({}, "debug");
    log.info({}, "info");
    log.warn({}, "warn");
    log.error({}, "error");

    expect(chunks.length).toBeGreaterThan(0);
  });
});

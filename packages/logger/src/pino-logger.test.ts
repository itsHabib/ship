import { Writable } from "node:stream";
import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createLogger } from "./index.js";

describe("pino logger internals", () => {
  const originalNodeEnv = process.env["NODE_ENV"];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("node:module");
    vi.resetModules();
    if (originalNodeEnv === undefined) {
      delete process.env["NODE_ENV"];
      return;
    }
    process.env["NODE_ENV"] = originalNodeEnv;
  });

  test("falls back to base stream when pino-pretty cannot load", async () => {
    // doMock (not the hoisted vi.mock) keeps this scoped to this test: the
    // throwing createRequire only reaches the fresh module graph imported below,
    // never the statically-imported createLogger the other tests use.
    vi.doMock("node:module", () => ({
      createRequire: () => () => {
        throw new Error("pino-pretty missing");
      },
    }));
    vi.resetModules();

    process.env["NODE_ENV"] = "development";
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
        callback();
      },
    });

    const { createLogger: createLoggerScoped } = await import("./index.js");
    const log = createLoggerScoped({ level: "info", stream });
    log.info({ fallback: true }, "pretty unavailable");

    expect(chunks.length).toBeGreaterThan(0);
    const parsed = JSON.parse(chunks.join("").trim()) as Record<string, unknown>;
    expect(parsed["msg"]).toBe("pretty unavailable");
  });

  test("swallows logger method throws", () => {
    const throwingLogger = {
      child: () => throwingLogger,
      debug: () => {
        throw new Error("debug failed");
      },
      error: () => {
        throw new Error("error failed");
      },
      info: () => {
        throw new Error("info failed");
      },
      warn: () => {
        throw new Error("warn failed");
      },
    } as unknown as pino.Logger;

    vi.spyOn(pino, "default" as never).mockReturnValue(throwingLogger);

    const log = createLogger({ level: "info", pretty: false, stream: new Writable() });

    expect(() => {
      log.info({}, "no throw");
    }).not.toThrow();
    expect(() => {
      log.warn({}, "no throw");
    }).not.toThrow();
    expect(() => {
      log.error({}, "no throw");
    }).not.toThrow();
    expect(() => {
      log.debug({}, "no throw");
    }).not.toThrow();
  });
});

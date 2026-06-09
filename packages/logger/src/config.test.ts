import { afterEach, describe, expect, test } from "vitest";

import { isDevEnvironment, resolveLevel, resolvePretty, resolveStream } from "./config.js";

describe("config", () => {
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
  });

  test("isDevEnvironment is true only for NODE_ENV=development", () => {
    process.env["NODE_ENV"] = "development";
    expect(isDevEnvironment()).toBe(true);

    process.env["NODE_ENV"] = "production";
    expect(isDevEnvironment()).toBe(false);
  });

  test("resolveLevel prefers explicit opts over env and default", () => {
    process.env["SHIP_LOG_LEVEL"] = "warn";
    expect(resolveLevel({ level: "debug" })).toBe("debug");
    expect(resolveLevel()).toBe("warn");
  });

  test("resolveLevel falls back to info when env is empty", () => {
    process.env["SHIP_LOG_LEVEL"] = "";
    expect(resolveLevel()).toBe("info");
  });

  test("resolveLevel falls back to info for unknown values", () => {
    process.env["SHIP_LOG_LEVEL"] = "bogus";
    expect(resolveLevel()).toBe("info");
    expect(resolveLevel({ level: "not-a-level" })).toBe("info");
  });

  test("resolveLevel normalizes level casing", () => {
    expect(resolveLevel({ level: "ERROR" })).toBe("error");
    expect(resolveLevel({ level: "Warn" })).toBe("warn");
    process.env["SHIP_LOG_LEVEL"] = "DEBUG";
    expect(resolveLevel()).toBe("debug");
  });

  test("resolvePretty prefers explicit opts over dev default", () => {
    process.env["NODE_ENV"] = "development";
    expect(resolvePretty({ pretty: false })).toBe(false);
    expect(resolvePretty()).toBe(true);

    process.env["NODE_ENV"] = "production";
    expect(resolvePretty()).toBe(false);
  });

  test("resolveStream defaults to process.stderr", () => {
    expect(resolveStream()).toBe(process.stderr);
  });
});

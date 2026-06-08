import type { CreateLoggerOpts } from "./types.js";

const DEFAULT_LEVEL = "info";

export function isDevEnvironment(): boolean {
  return process.env["NODE_ENV"] === "development";
}

export function resolveLevel(opts?: CreateLoggerOpts): string {
  if (opts?.level !== undefined) {
    return opts.level;
  }
  const envLevel = process.env["SHIP_LOG_LEVEL"];
  if (envLevel !== undefined && envLevel.length > 0) {
    return envLevel;
  }
  return DEFAULT_LEVEL;
}

export function resolvePretty(opts?: CreateLoggerOpts): boolean {
  if (opts?.pretty !== undefined) {
    return opts.pretty;
  }
  return isDevEnvironment();
}

export function resolveStream(opts?: CreateLoggerOpts): NodeJS.WritableStream {
  return opts?.stream ?? process.stderr;
}

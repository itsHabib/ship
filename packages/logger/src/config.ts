import type { CreateLoggerOpts } from "./types.js";

const DEFAULT_LEVEL = "info";
const PINO_LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal", "silent"]);

function normalizeLevel(level: string): string {
  const lower = level.toLowerCase();
  if (PINO_LEVELS.has(lower)) {
    return lower;
  }
  return DEFAULT_LEVEL;
}

export function isDevEnvironment(): boolean {
  return process.env["NODE_ENV"] === "development";
}

export function resolveLevel(opts?: CreateLoggerOpts): string {
  if (opts?.level !== undefined) {
    return normalizeLevel(opts.level);
  }
  const envLevel = process.env["SHIP_LOG_LEVEL"];
  if (envLevel !== undefined && envLevel.length > 0) {
    return normalizeLevel(envLevel);
  }
  return DEFAULT_LEVEL;
}

export function resolvePretty(opts?: CreateLoggerOpts): boolean {
  // Single source of truth for the pretty decision: production always emits JSON
  // and never loads pino-pretty, regardless of opts. In dev, honor opts (default
  // on). Callers gate solely on this — they must not re-check the environment.
  if (!isDevEnvironment()) {
    return false;
  }
  return opts?.pretty ?? true;
}

export function resolveStream(opts?: CreateLoggerOpts): NodeJS.WritableStream {
  return opts?.stream ?? process.stderr;
}

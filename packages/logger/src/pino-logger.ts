import { createRequire } from "node:module";
import pino from "pino";

import type { CreateLoggerOpts, LogFields, Logger } from "./types.js";

import { isDevEnvironment, resolveLevel, resolvePretty, resolveStream } from "./config.js";
import { wrapStreamWithErrorSwallowing } from "./safe-stream.js";

const require = createRequire(import.meta.url);

function tryCreatePrettyStream(
  destination: NodeJS.WritableStream,
): NodeJS.WritableStream | undefined {
  try {
    const prettyFactory = require("pino-pretty") as (options: {
      colorize: boolean;
      destination: NodeJS.WritableStream;
    }) => NodeJS.WritableStream;
    return prettyFactory({ colorize: true, destination });
  } catch {
    return undefined;
  }
}

function safeLog(fn: () => void): void {
  try {
    fn();
  } catch {
    // Swallow logger failures — diagnostics must not throw into business logic.
  }
}

function wrapPinoLogger(pinoLogger: pino.Logger): Logger {
  return {
    debug: (fields: LogFields, msg: string) => {
      safeLog(() => {
        pinoLogger.debug(fields, msg);
      });
    },
    info: (fields: LogFields, msg: string) => {
      safeLog(() => {
        pinoLogger.info(fields, msg);
      });
    },
    warn: (fields: LogFields, msg: string) => {
      safeLog(() => {
        pinoLogger.warn(fields, msg);
      });
    },
    error: (fields: LogFields, msg: string) => {
      safeLog(() => {
        pinoLogger.error(fields, msg);
      });
    },
    child: (fields: LogFields) => wrapPinoLogger(pinoLogger.child(fields)),
  };
}

export function createPinoLogger(opts?: CreateLoggerOpts): Logger {
  const level = resolveLevel(opts);
  const usePretty = resolvePretty(opts) && isDevEnvironment();
  const baseStream = resolveStream(opts);
  const prettyStream = usePretty ? tryCreatePrettyStream(baseStream) : undefined;
  const stream = wrapStreamWithErrorSwallowing(prettyStream ?? baseStream);

  const pinoLogger = pino({ level }, stream);
  return wrapPinoLogger(pinoLogger);
}

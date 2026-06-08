/**
 * `@ship/logger` — structured logging behind a narrow, swappable interface.
 * Default implementation is pino (JSON to stderr); pretty output is dev-only.
 */

export { createPinoLogger as createLogger } from "./pino-logger.js";
export type { CreateLoggerOpts, Logger, LogFields } from "./types.js";

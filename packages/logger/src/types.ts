export interface LogFields {
  readonly workflowRunId?: string;
  readonly cursorRunId?: string;
  readonly phase?: string;
  readonly failureCategory?: string;
  readonly [k: string]: unknown;
}

export interface Logger {
  debug(fields: LogFields, msg: string): void;
  info(fields: LogFields, msg: string): void;
  warn(fields: LogFields, msg: string): void;
  error(fields: LogFields, msg: string): void;
  child(fields: LogFields): Logger;
}

export interface CreateLoggerOpts {
  level?: string;
  pretty?: boolean;
  stream?: NodeJS.WritableStream;
}

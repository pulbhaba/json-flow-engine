import type { JsonObject } from "./json.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Minimal logging interface so hosts can plug in pino, winston, console or nothing. The engine
 * only logs identifiers, statuses, durations and error codes: never configs, payloads or
 * headers.
 */
export interface Logger {
  debug(message: string, fields?: JsonObject): void;
  info(message: string, fields?: JsonObject): void;
  warn(message: string, fields?: JsonObject): void;
  error(message: string, fields?: JsonObject): void;
}

export const silentLogger: Logger = {
  debug() {
    /* discard */
  },
  info() {
    /* discard */
  },
  warn() {
    /* discard */
  },
  error() {
    /* discard */
  },
};

/** Logger writing single-line JSON to stderr, suitable for CI output. */
export function createConsoleLogger(minLevel: LogLevel = "info"): Logger {
  const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
  const write = (level: LogLevel, message: string, fields: JsonObject | undefined): void => {
    if (order[level] < order[minLevel]) return;
    process.stderr.write(`${JSON.stringify({ level, message, ...fields })}\n`);
  };
  return {
    debug: (message, fields) => {
      write("debug", message, fields);
    },
    info: (message, fields) => {
      write("info", message, fields);
    },
    warn: (message, fields) => {
      write("warn", message, fields);
    },
    error: (message, fields) => {
      write("error", message, fields);
    },
  };
}

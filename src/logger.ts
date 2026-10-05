import { config } from "./config.js";
import type { LogLevel } from "./config.js";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const CONSOLE_METHOD: Record<LogLevel, (...args: unknown[]) => void> = {
  debug: console.debug,
  info: console.info,
  warn: console.warn,
  error: console.error,
};

const minLevel = LEVEL_ORDER[config.logLevel];

function log(level: LogLevel, ...args: unknown[]): void {
  if (LEVEL_ORDER[level] < minLevel) {
    return;
  }
  CONSOLE_METHOD[level](`[${level}]`, ...args);
}

// Nivel controlado por LOG_LEVEL (debug/info/warn/error, default "info").
// En Cloud Run no hace falta rotación de archivos: stdout/stderr ya va a
// Cloud Logging, que filtra por severidad y fecha nativamente.
export const logger = {
  debug: (...args: unknown[]) => log("debug", ...args),
  info: (...args: unknown[]) => log("info", ...args),
  warn: (...args: unknown[]) => log("warn", ...args),
  error: (...args: unknown[]) => log("error", ...args),
};

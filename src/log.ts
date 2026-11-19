/**
 * Log entries of the management bus and the default console logger.
 *
 * @decision .agents/decisions/261115_222025-p0-api-details.md#rack-handle
 */
import type { LogLevel } from "./device.ts";

/** One log entry, written by a device (`device` set) or by the rack itself. */
export interface LogEntry {
  /** Millisecond timestamp. */
  time: number;
  level: LogLevel;
  /** The device that wrote the entry; absent for entries written by the rack. */
  device?: string;
  message: string;
  data?: unknown;
}

/** Receives every log entry of a rack. */
export type Logger = (entry: LogEntry) => void;

/**
 * Formats an entry as one line: `[device] level message {data}`.
 *
 * @param entry The entry.
 * @returns The line, without a trailing newline.
 */
export function formatLogEntry(entry: LogEntry): string {
  const source = entry.device ?? "rack";
  const data = entry.data === undefined ? "" : ` ${stringify(entry.data)}`;
  return `[${source}] ${entry.level} ${entry.message}${data}`;
}

function stringify(data: unknown): string {
  try {
    return JSON.stringify(data, bigints) ?? String(data);
  } catch {
    // Circular or otherwise unserializable details still produce a line.
    return String(data);
  }
}

/** Writes a `bigint`, which JSON can't hold, as a string ending in `n`. */
function bigints(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? `${value}n` : value;
}

/**
 * Formats an entry as one line of JSON, `{ time, level, device?, message, data? }`. A `bigint`
 * is written as a string ending in `n`, and details that JSON can't hold otherwise, such as
 * circular ones, as their `String()`, as {@link formatLogEntry} writes them.
 *
 * @decision .agents/decisions/261118_173838-running-under-another-program.md#logs-as-json
 * @param entry The entry.
 * @returns The line, without a trailing newline.
 */
export function formatLogJson(entry: LogEntry): string {
  const { time, level, device, message, data } = entry;
  const fields = {
    time,
    level,
    ...(device === undefined ? {} : { device }),
    message,
    ...(data === undefined ? {} : { data }),
  };
  try {
    return JSON.stringify(fields, bigints);
  } catch {
    // Circular or otherwise unserializable details still produce a line.
    return JSON.stringify({ ...fields, data: String(data) });
  }
}

/**
 * The logger of `--log json`: one line of JSON per entry, warnings and errors included, all on
 * stdout, so that a program that runs the rack reads one stream in order.
 *
 * @decision .agents/decisions/261118_173838-running-under-another-program.md#logs-as-json
 * @param entry The entry to print.
 */
export function jsonLogger(entry: LogEntry): void {
  console.log(formatLogJson(entry));
}

/**
 * The default logger: one line per entry, warnings and errors on stderr.
 *
 * @param entry The entry to print.
 */
export function consoleLogger(entry: LogEntry): void {
  const line = formatLogEntry(entry);
  if (entry.level === "warn" || entry.level === "error") console.error(line);
  else console.log(line);
}

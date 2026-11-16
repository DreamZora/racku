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
    return (
      JSON.stringify(data, (_key, value) => (typeof value === "bigint" ? `${value}n` : value)) ??
      String(data)
    );
  } catch {
    // Circular or otherwise unserializable details still produce a line.
    return String(data);
  }
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

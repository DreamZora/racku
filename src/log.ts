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
 * Formats an entry as one line: `[device] level message {data}`. Control characters in the
 * message, such as a newline or the escape that starts a terminal's command, are escaped as JSON
 * escapes them, so that one entry stays one line, and text that a client chose can't forge
 * another.
 *
 * @param entry The entry.
 * @returns The line, without a trailing newline.
 * @decision .agents/decisions/261122_011655-security-review-fixes.md#code-loading-and-the-files-the-rack-writes
 */
export function formatLogEntry(entry: LogEntry): string {
  const source = oneLine(entry.device ?? "rack");
  const data = entry.data === undefined ? "" : ` ${oneLine(stringify(entry.data))}`;
  return `[${source}] ${entry.level} ${oneLine(entry.message)}${data}`;
}

function stringify(data: unknown): string {
  try {
    return JSON.stringify(data, bigints) ?? String(data);
  } catch {
    // Circular or otherwise unserializable details still produce a line.
    return String(data);
  }
}

/** The escapes that JSON writes for some control characters; the others get `\u` and 4 digits. */
const SHORT_ESCAPES: Record<string, string> = {
  "\b": "\\b",
  "\t": "\\t",
  "\n": "\\n",
  "\f": "\\f",
  "\r": "\\r",
};

/**
 * Text with its control characters escaped: C0 and C1 controls, DEL, and the separators of
 * lines and paragraphs, U+2028 and U+2029, which some readers break lines at.
 */
function oneLine(text: string): string {
  let line = "";
  let from = 0;
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    const control =
      code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
    if (!control) continue;
    line +=
      text.slice(from, at) +
      (SHORT_ESCAPES[text.charAt(at)] ?? `\\u${code.toString(16).padStart(4, "0")}`);
    from = at + 1;
  }
  return from === 0 ? text : line + text.slice(from);
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

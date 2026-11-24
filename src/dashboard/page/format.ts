/**
 * How the dashboard's page writes durations, rates, counts, sizes, times, and firmware hashes.
 * This module uses no API of the DOM or of Bun, so that tests run it in Bun.
 *
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#how-the-page-is-built
 */
import type { SlotStatus } from "../../reports.ts";

/** What the page shows for a value it doesn't have, such as a rate over an interval in which the counters restarted. */
export const MISSING = "—";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Writes a duration for people, as precisely as its size needs: `850 ms`, `1.2 s`, `42 s`,
 * `3 min 4 s`, `2 h 5 min`, or `3 d 4 h`.
 *
 * @param ms The duration in milliseconds; a negative one, such as a time from a clock ahead of
 *   the page's, counts as 0.
 * @returns The text.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 ms";
  if (ms < SECOND) return `${Math.round(ms)} ms`;
  if (ms < 10 * SECOND) {
    const tenths = Math.floor(ms / 100) / 10;
    return `${tenths.toFixed(1)} s`;
  }
  return coarse(ms);
}

/**
 * Writes an age in whole seconds and above, as the page says how old its data is: `0 s`, `12 s`,
 * `3 min 4 s`.
 *
 * @param ms The age in milliseconds; a negative one counts as 0.
 * @returns The text.
 */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < SECOND) return "0 s";
  return coarse(ms);
}

/** Whole seconds, minutes, hours, or days, with the next smaller unit when it isn't 0. */
function coarse(ms: number): string {
  if (ms < MINUTE) return `${Math.floor(ms / SECOND)} s`;
  const pair = (big: number, bigUnit: string, small: number, smallUnit: string): string =>
    small === 0 ? `${big} ${bigUnit}` : `${big} ${bigUnit} ${small} ${smallUnit}`;
  if (ms < HOUR) {
    return pair(Math.floor(ms / MINUTE), "min", Math.floor((ms % MINUTE) / SECOND), "s");
  }
  if (ms < DAY) return pair(Math.floor(ms / HOUR), "h", Math.floor((ms % HOUR) / MINUTE), "min");
  return pair(Math.floor(ms / DAY), "d", Math.floor((ms % DAY) / HOUR), "h");
}

/**
 * Writes a mean duration of calls: `0.42 ms`, `4.2 ms`, `42 ms`, or `1.3 s` and above.
 *
 * @param ms The mean in milliseconds, or `null` when no call finished.
 * @returns The text, or {@link MISSING} for `null`.
 */
export function formatMean(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return MISSING;
  if (ms < 1) return `${trim(ms.toFixed(2))} ms`;
  if (ms < 10) return `${trim(ms.toFixed(1))} ms`;
  if (ms < SECOND) return `${Math.round(ms)} ms`;
  return formatDuration(ms);
}

/**
 * Writes a rate per second: `0/s`, `0.03/s`, `1.5/s`, `42/s`, `1.2K/s`, or `3.4M/s`.
 *
 * @param perSecond The rate, or `null` when the interval gave none.
 * @returns The text, or {@link MISSING} for `null`.
 */
export function formatRate(perSecond: number | null): string {
  if (perSecond === null || !Number.isFinite(perSecond)) return MISSING;
  return `${formatNumber(perSecond)}/s`;
}

/**
 * Writes a number as compactly as a rate needs: two decimals below 1, one below 10, whole below
 * 1,000, and `K` or `M` with one decimal above.
 *
 * @param value A number, 0 or more.
 * @returns The text.
 */
export function formatNumber(value: number): string {
  const v = Math.max(0, value);
  if (v === 0) return "0";
  if (v < 1) return trim(v.toFixed(2)) === "0" ? "<0.01" : trim(v.toFixed(2));
  if (v < 10) return trim(v.toFixed(1));
  if (v < 1_000) return String(Math.round(v));
  if (v < 1_000_000) return `${trim((v / 1_000).toFixed(1))}K`;
  return `${trim((v / 1_000_000).toFixed(1))}M`;
}

/** Drops the trailing zeros of a fixed-point number, and the point when nothing follows it. */
function trim(fixed: string): string {
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}

/**
 * Writes a count in full, with commas between groups of three digits: `1,284`.
 *
 * @param count A whole number; another number is rounded.
 * @returns The text.
 */
export function formatCount(count: number): string {
  if (!Number.isFinite(count)) return MISSING;
  const whole = Math.round(count);
  const digits = String(Math.abs(whole));
  let grouped = "";
  for (let end = digits.length; end > 0; end -= 3) {
    const part = digits.slice(Math.max(0, end - 3), end);
    grouped = grouped === "" ? part : `${part},${grouped}`;
  }
  return whole < 0 ? `-${grouped}` : grouped;
}

/**
 * Writes a number of bytes in binary units: `512 B`, `1.5 KiB`, `42 MiB`, or `1.1 GiB`.
 *
 * @param bytes The size, 0 or more.
 * @returns The text.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return MISSING;
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const text = value < 10 ? trim(value.toFixed(1)) : String(Math.round(value));
  return `${text} ${units[unit]}`;
}

/**
 * Writes a time of day in the page's time zone, with its date when it isn't the day of `now`:
 * `14:03:05`, or `2026-11-23 14:03:05`.
 *
 * @param time A millisecond timestamp.
 * @param now The current time, a millisecond timestamp.
 * @returns The text, or {@link MISSING} for a time that isn't a finite number.
 */
export function formatTime(time: number, now: number): string {
  if (!Number.isFinite(time)) return MISSING;
  const date = new Date(time);
  const today = new Date(now);
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  if (sameDay) return clock;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Writes a time and how long ago it was, or how long until it comes: `14:03:05, 12 s ago`, or
 * `14:05:00, in 45 s`.
 *
 * @param time A millisecond timestamp.
 * @param now The current time, a millisecond timestamp.
 * @returns The text.
 */
export function formatWhen(time: number, now: number): string {
  if (!Number.isFinite(time)) return MISSING;
  const clock = formatTime(time, now);
  return time > now
    ? `${clock}, in ${formatAge(time - now)}`
    : `${clock}, ${formatAge(now - time)} ago`;
}

/** How many characters of a firmware hash the page shows; the whole hash is in its tooltip. */
export const HASH_CHARS = 8;

/**
 * Shortens a firmware hash to its first {@link HASH_CHARS} characters.
 *
 * @param hash The hash, or `null` for none.
 * @returns The text, or {@link MISSING} for `null`.
 */
export function shortHash(hash: string | null | undefined): string {
  if (hash === null || hash === undefined || hash === "") return MISSING;
  return hash.length > HASH_CHARS ? hash.slice(0, HASH_CHARS) : hash;
}

/**
 * Writes errors by code as `CODE count` pairs, the largest count first: `RACK_TIMEOUT 3,
 * NOT_FOUND 1`.
 *
 * @param errors Counts by error code.
 * @returns The text, or an empty string when no error counts.
 */
export function formatErrorCodes(errors: Record<string, number>): string {
  return Object.entries(errors)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([code, count]) => `${code} ${formatCount(count)}`)
    .join(", ");
}

/** A mark of a device on the rack's front. */
export interface Mark {
  /** `hotplug`, `copy`, or `packaged`. */
  kind: "hotplug" | "copy" | "packaged";
  /** The mark as a word or two. */
  text: string;
  /** The mark in one word, for the narrow blocks of the rack's front. */
  short: string;
  /** What it means, for its tooltip. */
  title: string;
}

/**
 * The marks of a device: `hot-plug` for a device of a hot-plug directory, `copy for <owner>` for a
 * copy that serves an `own` need, and `packaged` for firmware packaged in an executable.
 *
 * @param device The fields of the device's status that the marks come from.
 * @returns The marks it has.
 */
export function marksOf(device: Pick<SlotStatus, "hotplug" | "owner" | "packaged">): Mark[] {
  const marks: Mark[] = [];
  if (device.hotplug === true) {
    marks.push({
      kind: "hotplug",
      text: "hot-plug",
      short: "hot-plug",
      title: "A device of a hot-plug directory, which comes and goes with its file",
    });
  }
  if (device.owner !== undefined) {
    marks.push({
      kind: "copy",
      text: `copy for ${device.owner}`,
      short: "copy",
      title: `A copy that serves an own need of ${device.owner}`,
    });
  }
  if (device.packaged === true) {
    marks.push({
      kind: "packaged",
      text: "packaged",
      short: "packaged",
      title: "Runs the firmware packaged inside the executable",
    });
  }
  return marks;
}

/**
 * Writes the units a device takes: `U3`, or `U3–U4` for a device of 2U.
 *
 * @param device The device's lowest slot `u` and its `height`.
 * @returns The text.
 */
export function unitsText(device: Pick<SlotStatus, "u" | "height">): string {
  return device.height <= 1 ? `U${device.u}` : `U${device.u}–U${device.u + device.height - 1}`;
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
 * Writes text that devices or clients chose, such as a log message, with its control characters
 * escaped as JSON escapes them: C0 and C1 controls, DEL, and the separators of lines and
 * paragraphs, U+2028 and U+2029. So each record keeps to its row, and a character that wouldn't
 * show, or would move a terminal's cursor, shows as text, as the log of `rack start` writes it.
 *
 * @param text The text.
 * @returns The text with its control characters escaped.
 */
export function visibleText(text: string): string {
  let result = "";
  let from = 0;
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    const control =
      code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
    if (!control) continue;
    result +=
      text.slice(from, at) +
      (SHORT_ESCAPES[text.charAt(at)] ?? `\\u${code.toString(16).padStart(4, "0")}`);
    from = at + 1;
  }
  return from === 0 ? text : result + text.slice(from);
}

/**
 * Writes an error as the page shows it: `CODE: message`, its message's control characters escaped.
 *
 * @param error The error's code and message.
 * @returns The text.
 */
export function errorText(error: { code: string; message: string }): string {
  return `${visibleText(error.code)}: ${visibleText(error.message)}`;
}

/**
 * Writes a value that a device or the rack sent as data, such as a log entry's `data`, as JSON
 * text for the page to show as text.
 *
 * @param data The value, as JSON parsed it.
 * @returns The text, at most `limit` characters, ending in `…` when cut.
 */
export function formatData(data: unknown, limit = 2_000): string {
  let text: string;
  try {
    text = JSON.stringify(data) ?? String(data);
  } catch {
    // What JSON parsed always serializes again; this guards against anything else.
    text = String(data);
  }
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

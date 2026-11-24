/**
 * The records of the rack's feed that the page holds: at most 1,000, the newest, with a count of
 * the records that dropped out of the rack's feed before the page read them. This module uses no
 * API of the DOM or of Bun, so that tests run it in Bun.
 *
 * The page asks for the records after the one before its newest, so that its newest comes back
 * too: the same record shows that the rack is the one the page read before, and an empty answer,
 * or another record, shows a rack that started again, whose feed starts from `seq` 1.
 *
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#the-page
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#the-rack-keeps-its-recent-events
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#bounds
 */
import type { EventRecord, RackEvent } from "../../reports.ts";
import { errorText, formatData, shortHash, visibleText } from "./format.ts";

/** The most records of the feed that the page keeps. */
export const FEED_LIMIT = 1_000;

/** The level of a log entry. */
export type Level = Extract<RackEvent, { type: "log" }>["level"];

/** The levels, from the least to the most severe. */
export const LEVELS: readonly Level[] = ["debug", "info", "warn", "error"];

/** What an answer to `events` did to the page's records. */
export type FeedChange =
  /** New records came after the ones the page held. */
  | "added"
  /** No record came after the ones the page held. */
  | "unchanged"
  /** The rack started again: the page dropped its records, and asks for the new feed from its start. */
  | "restarted";

/** The records the page holds, and how it asks for more. */
export class Feed {
  /** The records, oldest first; at most {@link FEED_LIMIT}. */
  readonly records: EventRecord[] = [];
  /** How many records dropped out of the rack's feed before the page read them. */
  dropped = 0;
  /** When the page last saw that the rack had started again, a millisecond timestamp. */
  restartedAt: number | null = null;
  /**
   * How many times the page saw the rack start again. A record is known by it and its `seq`, since
   * the feed of a rack that started again counts from 1 anew.
   */
  epoch = 0;
  /** Grows by one with every change of the records, so that a view knows when to draw again. */
  version = 0;

  /** The newest record's `seq`, or 0 when the page holds none. */
  get newest(): number {
    return this.records.at(-1)?.seq ?? 0;
  }

  /**
   * The arguments of the next `events` request: the records after the one before the page's
   * newest, or every record when the page holds none.
   */
  request(): [] | [number] {
    const newest = this.newest;
    return newest === 0 ? [] : [newest - 1];
  }

  /**
   * Takes the answer to the request that {@link request} gave.
   *
   * @param asked The arguments that the request carried.
   * @param answer The records, oldest first.
   * @param time When the answer came, a millisecond timestamp.
   * @returns What the answer did.
   */
  take(asked: readonly number[], answer: readonly EventRecord[], time: number): FeedChange {
    const after = asked[0];
    if (after === undefined || this.records.length === 0) {
      return this.#append(answer, 0);
    }
    const held = this.records.at(-1) as EventRecord;
    const first = answer[0];
    // The record that the page holds as its newest must come back first, unless 1,000 newer ones
    // pushed it out of the rack's feed; else the rack is another one.
    if (first === undefined || first.seq < held.seq) return this.#restart(time);
    if (first.seq === held.seq) {
      if (first.time !== held.time || first.type !== held.type) return this.#restart(time);
      return this.#append(answer.slice(1), held.seq);
    }
    return this.#append(answer, held.seq);
  }

  /** Appends records that follow `after`, counting the ones that dropped out in between. */
  #append(records: readonly EventRecord[], after: number): FeedChange {
    let last = after;
    let added = 0;
    for (const record of records) {
      // Records come oldest first, each after the one before; any other is left out.
      if (!(record.seq > last)) continue;
      this.dropped += record.seq - last - 1;
      last = record.seq;
      this.records.push(record);
      added++;
    }
    if (this.records.length > FEED_LIMIT) this.records.splice(0, this.records.length - FEED_LIMIT);
    if (added === 0) return "unchanged";
    this.version++;
    return "added";
  }

  #restart(time: number): FeedChange {
    this.records.length = 0;
    this.dropped = 0;
    this.restartedAt = time;
    this.epoch++;
    this.version++;
    return "restarted";
  }
}

/**
 * The level of a record, which the operator narrows the events to: a log entry's own, `error` for
 * a fault and a failed swap, and `info` for the others.
 *
 * @param record A record of the feed.
 * @returns Its level.
 */
export function levelOf(record: EventRecord): Level {
  switch (record.type) {
    case "log":
      return record.level;
    case "fault":
      return "error";
    case "swap":
      return record.error === undefined ? "info" : "error";
    default:
      return "info";
  }
}

/** What the operator narrows the events to. */
export interface FeedFilter {
  /** Only records of this level; `null` for every level. */
  level: Level | null;
  /**
   * Only records of this device; `""` for the entries that the rack wrote itself, which name no
   * device; `null` for every record.
   */
  device: string | null;
}

/**
 * The records that a filter lets through, newest first.
 *
 * @param records The records, oldest first.
 * @param filter The level and the device to narrow to.
 * @returns The records it lets through.
 */
export function filterRecords(records: readonly EventRecord[], filter: FeedFilter): EventRecord[] {
  const result: EventRecord[] = [];
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index] as EventRecord;
    if (matches(record, filter)) result.push(record);
  }
  return result;
}

/**
 * Whether a filter lets a record through.
 *
 * @param record A record of the feed.
 * @param filter The level and the device to narrow to.
 */
export function matches(record: EventRecord, filter: FeedFilter): boolean {
  if (filter.level !== null && levelOf(record) !== filter.level) return false;
  if (filter.device !== null && (record.device ?? "") !== filter.device) return false;
  return true;
}

/** A record as the page writes it: a line, and details that may follow it. */
export interface RecordText {
  /** What happened, in one line. */
  summary: string;
  /** Its error, as `CODE: message`, when it carries one. */
  error: string | null;
  /** Its data as JSON text, when it carries any. */
  data: string | null;
}

/**
 * Writes a record for people. Everything in it comes from the rack, so the page shows it as text.
 *
 * @param record A record of the feed.
 * @returns Its summary, error, and data.
 */
export function describeRecord(record: EventRecord): RecordText {
  if (record.cut === true && isMinimal(record)) {
    const device = (record as { device?: unknown }).device;
    return {
      summary: `${typeof device === "string" ? `${visibleText(device)}: ` : ""}a ${record.type} record that the rack kept only as its number, time, and type`,
      error: null,
      data: null,
    };
  }
  switch (record.type) {
    case "power":
      return {
        summary: `${record.device} powered ${record.state}, firmware ${shortHash(record.firmware)}`,
        error: null,
        data: null,
      };
    case "swap":
      return {
        summary: `${record.device}: ${swapText(record.action, record.mode)}${firmwareChange(record.from, record.to)}${
          record.error === undefined ? "" : ", failed"
        }`,
        error: record.error === undefined ? null : errorText(record.error),
        data: record.error?.data === undefined ? null : formatData(record.error.data),
      };
    case "fault":
      return {
        summary: `${record.device} faulted, firmware ${shortHash(record.firmware)}; ${
          record.reset ? "the rack resets it" : "the rack doesn't reset it"
        }`,
        error: errorText(record.error),
        data: record.error.data === undefined ? null : formatData(record.error.data),
      };
    default:
      return {
        summary: visibleText(record.message),
        error: null,
        data: record.data === undefined ? null : formatData(record.data),
      };
  }
}

/**
 * Whether the rack kept a record at its minimum, its `seq`, `time`, `type`, and device's name,
 * without the fields of its type, as it does for an event that JSON can't write.
 *
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#the-rack-keeps-its-recent-events
 */
function isMinimal(record: EventRecord): boolean {
  const fields = record as Partial<Record<"state" | "action" | "error" | "message", unknown>>;
  switch (record.type) {
    case "power":
      return fields.state === undefined;
    case "swap":
      return fields.action === undefined;
    case "fault":
      return fields.error === undefined;
    default:
      return fields.message === undefined;
  }
}

function swapText(action: string, mode: string): string {
  if (action === "plug") return "plugged in";
  if (action === "unplug") return "unplugged";
  if (mode === "restart") return "restart";
  return `${mode} swap`;
}

function firmwareChange(from: string | null, to: string | null): string {
  if (from === null && to === null) return "";
  if (from === null) return `, firmware ${shortHash(to)}`;
  if (to === null) return `, firmware ${shortHash(from)}`;
  return `, firmware ${shortHash(from)} → ${shortHash(to)}`;
}

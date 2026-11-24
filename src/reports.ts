/**
 * The shapes of what a rack reports: `status()`, `history()`, `events()`, and the events that
 * `subscribe()` delivers. This module, and the modules it imports, use no API of Bun or of the
 * DOM, so that the dashboard's page shares these types with racku.
 *
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#how-the-page-is-built
 */
import type { WireError } from "./errors.ts";
import type { LogEntry } from "./log.ts";

/** Lifecycle state of a slot as reported by `status()`. */
export type SlotState = "online" | "swapping" | "degraded" | "resetting" | "faulted";

/** State of one device, as returned by `RackHandle.status()`. */
export interface SlotStatus {
  name: string;
  model: string;
  u: number;
  height: number;
  state: SlotState;
  /** Firmware hash of the installed instance; `null` when none is installed. */
  firmware: string | null;
  /**
   * Absolute path of the device file. In an executable, a device of the app names the path of
   * its outside file under the base directory, whether or not that file exists.
   */
  source: string;
  /**
   * In an executable, `true` while the device runs the firmware packaged inside it; absent
   * otherwise.
   */
  packaged?: true;
  /** Calls the installed instance is processing, from other devices and from outside the rack. */
  inFlight: number;
  /** Crashes within the last 60 seconds. */
  crashes: number;
  /** For a copy that serves an `own` need: the instance whose need it serves. */
  owner?: string;
  /**
   * `true` for a device from a hot-plug directory, and for a copy that one owns; absent
   * otherwise.
   *
   * @decision .agents/decisions/261121_065823-hot-plug-directories.md#observation
   */
  hotplug?: true;
  /** Hash of the firmware the device falls back to when a new instance crashes on probation. */
  knownGood: string | null;
  /** While the installed instance is on probation: when probation ends, a millisecond timestamp. */
  probationUntil?: number;
  /**
   * The installed instance's watchdogs, the event loop's first; empty when watchdogs are off or
   * no instance is installed.
   */
  watchdogs: WatchdogStatus[];
  /**
   * Threads of the device's earlier instances that didn't stop within `hookTimeout` of their
   * termination, stuck in native code. No other instance of the device starts until they stop.
   */
  stuck: StuckThread[];
  /** The last failed swap or crash. */
  error?: WireError;
  /** One entry per listener of the installed instance; empty when none is installed. */
  listeners: ListenerStatus[];
}

/**
 * A listener of an instance, as `status()` shows it.
 *
 * @decision .agents/decisions/261118_070617-panels-as-devices.md#observation
 */
export interface ListenerStatus {
  /** For example `https://127.0.0.1:3443/`. */
  url: string;
  /** The certificates new connections get; empty without TLS. */
  certificates: CertificateInfo[];
  /** Requests in flight, as Bun counts them. */
  requests: number;
  /** Open WebSockets, as Bun counts them. */
  webSockets: number;
}

/** A certificate of a listener, as `status()` shows it. */
export interface CertificateInfo {
  subject: string;
  /** The server name it serves, for one of a list of certificates for SNI. */
  serverName?: string;
  /** When it expires, a millisecond timestamp. */
  notAfter: number;
}

/** A watchdog of an instance, as `status()` reports it. */
export interface WatchdogStatus {
  name: string;
  timeout: number;
  /** When the rack last saw a feed, or began to check, a millisecond timestamp. */
  lastFed: number;
}

/**
 * A thread of an ended instance that is still running, stuck in native code.
 *
 * @decision .agents/decisions/261117_185131-ending-instances.md#observation
 */
export interface StuckThread {
  /** Firmware hash of the instance. */
  firmware: string;
  /** When the rack terminated the instance, a millisecond timestamp. */
  since: number;
  /**
   * The listeners the thread hadn't stopped, which keep their ports until it stops; the system
   * still accepts connections to them, and nothing answers.
   */
  listeners: ListenerStatus[];
}

/** What a management operation did to a device. */
export type SwapAction = "plug" | "unplug" | "swap";

/**
 * How an instance was replaced: a `hot` swap overlaps the old and the new instance, a `cold`
 * swap stops the old one first, and a `restart` also starts the new one without the old state.
 */
export type ReloadMode = "hot" | "cold" | "restart" | "plug" | "unplug";

/** An event of the rack, delivered to `RackHandle.subscribe()` listeners. */
export type RackEvent =
  | { type: "power"; device: string; firmware: string; state: "on" | "off" }
  | {
      type: "swap";
      device: string;
      action: SwapAction;
      mode: ReloadMode;
      from: string | null;
      to: string | null;
      error?: WireError;
    }
  | { type: "fault"; device: string; firmware: string; error: WireError; reset: boolean }
  | ({ type: "log" } & LogEntry);

/**
 * One record of the rack's feed of recent events, as `RackHandle.events()` returns it: an event
 * that `subscribe()` delivers, apart from log entries of level `debug`, with its number and time.
 *
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#the-rack-keeps-its-recent-events
 */
export type EventRecord = RackEvent & {
  /** Its number: 1 for the first record after the rack starts, and one more for each record. */
  seq: number;
  /** When the rack emitted the event, a millisecond timestamp; a log entry keeps its own. */
  time: number;
  /**
   * Present when the record was longer than 4,096 characters as JSON: it lost its `data` and its
   * error's `data`, and its messages were cut to 1,024 characters, the last of them `…`. A record
   * still too long then, such as one whose messages are full of characters that JSON escapes,
   * had its messages, its device's name, its error's code, and a swap's `from` and `to` cut
   * shorter, until it fit. A record that JSON can't write, or that its cuts leave too long, keeps
   * only its `seq`, `time`, `type`, and device's name, cut short.
   */
  cut?: true;
};

/** One device that `RackHandle.reload()` or `RackHandle.restart()` tried to replace. */
export interface ReloadResult {
  device: string;
  from: string | null;
  to: string | null;
  mode: ReloadMode;
  error?: WireError;
}

/** What asked for an update. */
export type UpdateCause =
  | "reload"
  | "swap"
  | "restart"
  | "rollback"
  | "fallback"
  | "plug"
  | "unplug";

/** One update of a device, as `RackHandle.history()` reports it. */
export interface UpdateRecord {
  /** Increases by one per record within the rack process. */
  seq: number;
  /** When the operation that made the update started, a millisecond timestamp. */
  time: number;
  device: string;
  mode: ReloadMode;
  cause: UpdateCause;
  /** Firmware hash before the update. */
  from: string | null;
  /** Firmware hash the update installed, or tried to install. */
  to: string | null;
  ok: boolean;
  /** Why the update failed, or why the device fell back. */
  error?: WireError;
  /** `seq` of the first record of the same group replacement. */
  group?: number;
}

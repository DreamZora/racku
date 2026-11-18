/**
 * Messages exchanged between the rack main thread and the Workers that host devices, and between
 * Workers over links.
 *
 * The control channel (the Worker's own `postMessage`) carries boot, lifecycle hooks, link
 * management, metrics, and logs. The data channel (a `MessagePort` transferred at boot) carries
 * calls from outside the rack. A link (one `MessageChannel` per wire) carries calls, results,
 * cancellations, subscriptions, events, and hold markers between two devices. Every message is
 * structured-cloneable; errors travel as {@link WireError}.
 *
 * @decision .agents/decisions/261116_024226-backplane-links.md#channels
 * @decision .agents/decisions/261116_024226-backplane-links.md#links
 * @decision .agents/decisions/261116_024226-backplane-links.md#rpc
 * @decision .agents/decisions/261118_071155-backplane-streams.md#transport
 * @decision .agents/decisions/261118_070617-panels-as-devices.md#listeners
 */
import type { ConnectorInfo } from "./connector.ts";
import type { HookName, LogLevel } from "./device.ts";
import type { WireError } from "./errors.ts";
import type { StreamMessage, StreamSlot } from "./streams.ts";

/**
 * The default of the start option `queueLimit`: the most calls a need has unfinished, sent or
 * held, and the most events that wait for one subscriber.
 *
 * @decision .agents/decisions/261117_063228-bounded-backlogs.md#bounded-calls
 */
export const QUEUE_LIMIT = 10_000;

/**
 * The memory each instance shares with the main thread, as indexes of `Int32` elements: the
 * calls the instance is serving, then the feeds of its event-loop watchdog, then one feed
 * counter for each device watchdog.
 *
 * @decision .agents/decisions/261117_062959-watchdog.md#feeding-and-checking
 */
export const SHARED_SERVING = 0;
export const SHARED_LOOP = 1;
export const SHARED_WATCHDOGS = 2;
/** Most device watchdogs an instance can have armed at once. */
export const WATCHDOG_LIMIT = 16;
/** Shortest timeout of a device watchdog, in ms; shorter ones would trip on garbage collection. */
export const WATCHDOG_MIN = 1_000;
/** The most listeners one instance may have. */
export const LISTENER_LIMIT = 16;
/**
 * The first of two counters per listener in the shared memory: its requests in flight, then its
 * open WebSockets, as Bun counts them.
 *
 * @decision .agents/decisions/261118_070617-panels-as-devices.md#observation
 */
export const SHARED_LISTENERS = SHARED_WATCHDOGS + WATCHDOG_LIMIT;
/** Number of `Int32` elements in the shared memory of an instance. */
export const SHARED_LENGTH = SHARED_LISTENERS + 2 * LISTENER_LIMIT;

/** A certificate of a listener, as `status()` shows it. */
export interface CertificateInfo {
  subject: string;
  /** The server name it serves, for one of a list of certificates for SNI. */
  serverName?: string;
  /** When it expires, a millisecond timestamp. */
  notAfter: number;
}

/** A listener of an instance, as the Worker host reports it; its counters are shared memory. */
export interface ListenerReport {
  /** Its index among the instance's listeners, and of its counters. */
  index: number;
  url: string;
  /** It is bound and takes new connections. */
  listening: boolean;
  /** The certificates new connections get; empty without TLS. */
  certificates: CertificateInfo[];
}

/**
 * A listener of a device's earlier instance, which the next instance's listener of the same
 * declared address and order takes over.
 *
 * @decision .agents/decisions/261118_070617-panels-as-devices.md#port-0
 */
export interface InheritedListener {
  hostname: string;
  /** The port the listener declared; 0 picks a free one. */
  declared: number;
  /** Its order among the listeners that declare the same hostname and port. */
  ordinal: number;
  /** The port it got. */
  port: number;
  /** An instance of the device listens on it now, so no check for other processes runs. */
  held: boolean;
}

/**
 * Worker to main thread: reserve a listener's address in the rack's table of listeners.
 *
 * @decision .agents/decisions/261118_070617-panels-as-devices.md#conflicts
 */
export interface ReserveAsk {
  kind: "reserve";
  hostname: string;
  declared: number;
  ordinal: number;
  port: number;
}

/** A need in FRU data: its connector, and whether it owns a copy of its provider. */
export interface NeedInfo extends ConnectorInfo {
  own: boolean;
  /**
   * The address that `patched()` wires the need to: `<device>.<port>`, or `<model>.<port>` in a
   * scanned rack.
   *
   * @decision .agents/decisions/261118_071513-http-panel-device.md#needs-from-configuration
   */
  patched?: string;
}

/** FRU data a Worker reports after loading its firmware. */
export interface Fru {
  model: string;
  /** The device name: the slot's name, or the model when the slot names none. */
  name: string;
  height: number;
  needs: Record<string, NeedInfo>;
  provides: Record<string, ConnectorInfo>;
  snapshot: boolean;
  restore: boolean;
  /** Start priority in a scanned rack. */
  priority: number;
  /** Whether a replacement may overlap the old and the new instance. */
  swap: "hot" | "cold";
  /** Whether the needs come from the configuration, so that other configuration gives others. */
  computedNeeds: boolean;
}

/** Main thread to Worker: load the firmware and report FRU data. */
export interface BootRequest {
  id: number;
  op: "boot";
  /** `file:` URL of the firmware bundle. */
  firmware: string;
  /** Firmware version, exposed as `ctx.firmware`. */
  hash: string;
  /** Device file the firmware was built from, for messages. */
  source: string;
  name: string | undefined;
  u: number;
  config: unknown;
  baseDir: string;
  /** Timeout of the device's calls that set none, in ms. */
  callTimeout: number;
  /** Memory shared with the main thread, laid out as `SHARED_LENGTH` describes. */
  gauge: SharedArrayBuffer;
  /**
   * Timeout of the event-loop watchdog in ms, or 0 when watchdogs are off; the Worker host
   * feeds it often enough for that timeout.
   */
  watchdog: number;
  /** The most unfinished calls of each need, and the most events waiting on each link. */
  queueLimit: number;
  port: MessagePort;
}

/**
 * Main thread to Worker: load the firmware and report what the device declares, without
 * validating a configuration or preparing a context. The Worker is terminated afterwards.
 */
export interface DescribeRequest {
  id: number;
  op: "describe";
  /** `file:` URL of the firmware bundle. */
  firmware: string;
  /** Device file the firmware was built from, for messages. */
  source: string;
  /** The configuration that needs computed from the configuration are computed from. */
  config?: unknown;
}

/** Main thread to Worker: run a lifecycle hook. */
export interface HookRequest {
  id: number;
  op: "hook";
  hook: HookName;
  /** For `restore`: the previous instance's snapshot. */
  state?: unknown;
  /** For `restore`: the previous instance's firmware version. */
  from?: string;
  /** For `powerOn`: the listeners of the device's earlier instances. */
  listeners?: InheritedListener[];
}

/**
 * Main thread to Worker: the instance goes into service; its listeners that don't listen bind.
 * The reply is the URLs of the ones that bound.
 *
 * @decision .agents/decisions/261118_070617-panels-as-devices.md#when-listeners-listen
 */
export interface ListenRequest {
  id: number;
  op: "listen";
}

/**
 * Main thread to Worker: the instance leaves service; its listeners stop listening, and its
 * WebSockets close with `code`. The reply, the URLs of the ones that stopped, confirms the stop.
 */
export interface UnlistenRequest {
  id: number;
  op: "unlisten";
  code: number;
}

/** Main thread to consumer: a new link for a need, which becomes the need's current link. */
export interface NeedLinkRequest {
  id: number;
  op: "link";
  need: string;
  link: number;
  end: MessagePort;
  /** `<device>.<port>` at the other end, for messages. */
  provider: string;
  /**
   * The token of the hold the provider instance is in, if any: new calls of the need wait, and a
   * hold marker with this token goes out on the link first.
   */
  hold: number | undefined;
}

/** Main thread to consumer: queue new calls of a need, and send a hold marker on its link. */
export interface NeedHoldRequest {
  id: number;
  op: "hold";
  need: string;
  token: number;
}

/** Main thread to consumer: send the queued calls of a need on its current link. */
export interface NeedReleaseRequest {
  id: number;
  op: "release";
  need: string;
}

/** Main thread to consumer: a link of a need is down; its pending calls fail with `error`. */
export interface NeedDownRequest {
  id: number;
  op: "down";
  need: string;
  link: number;
  error: WireError;
}

/** Main thread to provider: the provider end of a link from a consumer. */
export interface AttachRequest {
  id: number;
  op: "attach";
  link: number;
  end: MessagePort;
  /** The provided port the link serves. */
  port: string;
  /** Name of the consumer device. */
  consumer: string;
  /** Whether events go out on the link: the consumer instance is installed. */
  live: boolean;
  /** Whether events for the consumer device are queued: its slot is held. */
  held: boolean;
}

/** Main thread to provider: queue the events for a consumer device and send hold markers. */
export interface HoldEventsRequest {
  id: number;
  op: "holdEvents";
  consumer: string;
  token: number;
}

/**
 * Main thread to provider: events for a consumer device go out on these links only, starting
 * with the events queued while the device was held.
 */
export interface LiveRequest {
  id: number;
  op: "live";
  consumer: string;
  links: number[];
}

/** Main thread to provider: a consumer instance is gone; abort its calls and close the link. */
export interface DropRequest {
  id: number;
  op: "drop";
  link: number;
  /** What the link's open streams fail with; `RACK_LINK_DOWN` when absent. */
  error?: WireError;
}

/** Main thread to Worker: whether the instance is the one installed in its slot. */
export interface InstalledRequest {
  id: number;
  op: "installed";
  installed: boolean;
}

/**
 * Main thread to Worker: reply once these hold markers arrived and no call is being served, and,
 * with `streams`, once no stream is open either.
 *
 * @decision .agents/decisions/261118_071155-backplane-streams.md#swaps-and-resets
 */
export interface DrainRequest {
  id: number;
  op: "drain";
  markers: Marker[];
  /** Wait for the open streams too: the instance retires. */
  streams: boolean;
}

/** Main thread to Worker: reply with the call and event counters. */
export interface MetricsRequest {
  id: number;
  op: "metrics";
}

/** A hold marker a drain waits for: the link it travels on, and the hold it belongs to. */
export type Marker = [link: number, token: number];

/** A control-channel request. */
export type ControlRequest =
  | BootRequest
  | DescribeRequest
  | HookRequest
  | NeedLinkRequest
  | NeedHoldRequest
  | NeedReleaseRequest
  | NeedDownRequest
  | AttachRequest
  | HoldEventsRequest
  | LiveRequest
  | DropRequest
  | InstalledRequest
  | DrainRequest
  | MetricsRequest
  | ListenRequest
  | UnlistenRequest;

/** A control-channel request before the sender numbers it. */
export type ControlPayload = ControlRequest extends infer R
  ? R extends { id: number }
    ? Omit<R, "id">
    : never
  : never;

/** A control-channel reply, matched to its request by `id`. */
export type ControlReply = { id: number; ok: true; value: unknown } | ControlFailure;

/** A failed control-channel request. */
export interface ControlFailure {
  id: number;
  ok: false;
  error: WireError;
}

/** Worker to main thread: a log entry for the management bus. */
export interface LogNotice {
  op: "log";
  level: LogLevel;
  message: string;
  data?: unknown;
}

/** Worker to main thread: the device armed or cancelled one of its watchdogs. */
export interface WatchdogNotice {
  op: "watchdog";
  /** Index of the watchdog's feed counter among the device watchdogs, below `WATCHDOG_LIMIT`. */
  index: number;
  /** Name and timeout of a watchdog that was armed; absent when it was cancelled. */
  armed?: { name: string; timeout: number };
}

/** Worker to main thread: a request the main thread answers with an {@link AnswerMessage}. */
export interface AskNotice {
  op: "ask";
  id: number;
  ask: ReserveAsk;
}

/** Main thread to Worker: the answer to an {@link AskNotice}. */
export type AnswerMessage =
  | { op: "answer"; id: number; ok: true; value: unknown }
  | { op: "answer"; id: number; ok: false; error: WireError };

/** Worker to main thread: what the instance's listeners are now. */
export interface ListenersNotice {
  op: "listeners";
  listeners: ListenerReport[];
}

/** Anything a Worker posts on the control channel. */
export type ControlNotice = ControlReply | LogNotice | WatchdogNotice | AskNotice | ListenersNotice;

/** Backplane to provider, on the data channel: a call from outside the rack. */
export interface CallToProvider {
  t: "call";
  id: number;
  port: string;
  member: string;
  input: unknown;
  /** The call's deadline, a millisecond timestamp; `Infinity` for a call with an input stream. */
  deadline: number;
  /** Idle timeout of the call's streams, in ms. */
  idle: number;
  /** Where the input carries its stream, which follows on this channel. */
  stream?: StreamSlot;
  /** Address of the caller: `rack`, for `rack.call()`. */
  caller: string;
}

/**
 * The outcome of a call, on the data channel or on a link. `stream` says where the value
 * carries its stream, which follows on the same channel.
 */
export type CallResult =
  | { t: "result"; id: number; ok: true; value: unknown; stream?: StreamSlot }
  | CallFailure;

/** A failed call. */
export interface CallFailure {
  t: "result";
  id: number;
  ok: false;
  error: WireError;
}

/** Cancels a call, on the data channel or on a link. */
export interface Cancel {
  t: "cancel";
  id: number;
}

/** Consumer to provider on a link: run an RPC member of the linked port. */
export interface LinkCall {
  t: "call";
  /** Unique per link. */
  id: number;
  member: string;
  input: unknown;
  /** The call's deadline, a millisecond timestamp; `Infinity` for a call with an input stream. */
  deadline: number;
  /** Idle timeout of the call's streams, in ms. */
  idle: number;
  /** Where the input carries its stream, which follows on the link. */
  stream?: StreamSlot;
}

/** Consumer to provider on a link: start or stop receiving an event. */
export interface Subscription {
  t: "sub" | "unsub";
  event: string;
}

/** Either direction on a link: nothing of the held kind follows until the hold ends. */
export interface HoldMarker {
  t: "hold";
  token: number;
}

/** Provider to consumer on a link: an event of the linked port. */
export interface LinkEvent {
  t: "event";
  event: string;
  payload: unknown;
}

/** What a consumer sends on a link. */
/**
 * Consumer to provider on a link: how many events the consumer's host has taken off the link,
 * so that the provider can bound the events still waiting there.
 *
 * @decision .agents/decisions/261117_063228-bounded-backlogs.md#bounded-events
 */
export interface Taken {
  t: "taken";
  count: number;
}

export type ToProvider = LinkCall | Cancel | Subscription | HoldMarker | Taken | StreamMessage;

/** What a provider sends on a link. */
export type ToConsumer = CallResult | LinkEvent | HoldMarker | StreamMessage;

/** Data-channel messages the backplane sends. */
export type DataToWorker = CallToProvider | Cancel | StreamMessage;

/** Data-channel messages a Worker sends. */
export type DataFromWorker = CallResult | StreamMessage;

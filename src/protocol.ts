/**
 * Messages exchanged between the rack main thread and the Worker that hosts a device.
 *
 * The control channel (the Worker's own `postMessage`) carries boot, lifecycle hooks, and logs.
 * The data channel (a `MessagePort` transferred at boot) carries calls, results, cancellations,
 * events, and subscriptions. Every message is structured-cloneable; errors travel as
 * {@link WireError}.
 *
 * @decision .agents/decisions/261112_043035-backplane-protocol.md#channels
 * @decision .agents/decisions/261112_043035-backplane-protocol.md#rpc
 */
import type { ConnectorInfo } from "./connector.ts";
import type { HookName, LogLevel } from "./device.ts";
import type { WireError } from "./errors.ts";

/** FRU data a Worker reports after loading its firmware. */
export interface Fru {
  model: string;
  /** The device name: the slot's name, or the model when the slot names none. */
  name: string;
  height: number;
  needs: Record<string, ConnectorInfo>;
  provides: Record<string, ConnectorInfo>;
  snapshot: boolean;
  restore: boolean;
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
  port: MessagePort;
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
}

/** A control-channel request. */
export type ControlRequest = BootRequest | HookRequest;

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

/** Anything a Worker posts on the control channel. */
export type ControlNotice = ControlReply | LogNotice;

/** Caller Worker to backplane: call an RPC member of a need. */
export interface CallFromCaller {
  t: "call";
  id: number;
  need: string;
  member: string;
  input: unknown;
  timeout: number | undefined;
}

/** Backplane to provider Worker: run an RPC member of a port. */
export interface CallToProvider {
  t: "call";
  id: number;
  port: string;
  member: string;
  input: unknown;
  deadline: number;
  /** Address of the caller: a device name, or `rack` for calls from outside the rack. */
  caller: string;
}

/** The outcome of a call, in either direction. */
export type CallResult = { t: "result"; id: number; ok: true; value: unknown } | CallFailure;

/** A failed call. */
export interface CallFailure {
  t: "result";
  id: number;
  ok: false;
  error: WireError;
}

/** Cancels a call, in either direction. */
export interface Cancel {
  t: "cancel";
  id: number;
}

/** Publisher Worker to backplane: an event on a provided port. */
export interface Emit {
  t: "emit";
  port: string;
  event: string;
  payload: unknown;
}

/** Backplane to consumer Worker: an event on a need. */
export interface Deliver {
  t: "event";
  need: string;
  event: string;
  payload: unknown;
}

/** Consumer Worker to backplane: start or stop receiving an event of a need. */
export interface Subscription {
  t: "sub" | "unsub";
  need: string;
  event: string;
}

/** Data-channel messages a Worker sends. */
export type DataFromWorker = CallFromCaller | CallResult | Cancel | Emit | Subscription;

/** Data-channel messages the backplane sends. */
export type DataToWorker = CallToProvider | CallResult | Cancel | Deliver;

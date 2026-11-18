/**
 * Device definitions: the default export of a device file, and the context its hooks receive.
 *
 * Device files are loaded only inside the Worker that hosts the device, never on the rack main
 * thread, so nothing here may assume it runs next to the rack.
 *
 * @decision .agents/decisions/261112_043034-device-api.md#devices
 * @decision .agents/decisions/261112_043034-device-api.md#device-context
 * @decision .agents/decisions/261112_035943-hot-swap.md#lifecycle
 * @decision .agents/decisions/261115_222025-p0-api-details.md#device-hooks
 * @decision .agents/decisions/261116_213839-transfer-and-shared-buffers.md#transfer
 * @decision .agents/decisions/261116_233919-automatic-assembly.md#shared-and-own-needs
 * @decision .agents/decisions/261116_233919-automatic-assembly.md#start-priority
 * @decision .agents/decisions/261116_233956-cold-swaps-and-restarts.md#cold-swaps
 * @decision .agents/decisions/261118_071155-backplane-streams.md#timeouts
 * @decision .agents/decisions/261118_070617-panels-as-devices.md#listeners
 */
import {
  type Connector,
  type EventInput,
  type EventPayload,
  type EventSpec,
  isConnector,
  isIdentifierName,
  type Members,
  type RpcInput,
  type RpcOutput,
  type RpcParsedInput,
  type RpcReturn,
  type RpcSpec,
} from "./connector.ts";
import { RackError } from "./errors.ts";
import type { Listener, ServeOptions } from "./listeners.ts";
import { isStandardSchema, type StandardSchemaV1 } from "./schema.ts";

/** Connectors keyed by need or port name. */
export type Ports = Record<string, Connector>;

/** Ports of a device that declares none. */
export type NoPorts = Record<never, Connector>;

/** Brand of own needs; a global symbol, because a bundle may carry its own copy of rack42u. */
const OWN: unique symbol = Symbol.for("rack42u.own");

/** A need that asks for a copy of its provider that serves only this instance; see {@link own}. */
export interface Own<C extends Connector = Connector> {
  readonly [OWN]: true;
  /** The connector the need calls. */
  readonly connector: C;
}

/** A need: a connector, which shares the provider, or `own(connector)`, which gets a copy. */
export type Need = Connector | Own;

/** Needs keyed by need name. */
export type Needs = Record<string, Need>;

/** The connector a need calls, whether it shares its provider or owns a copy. */
export type NeedConnector<T> = T extends Own<infer C> ? C : T extends Connector ? T : never;

/**
 * Asks for a copy of the provider that serves only this consumer instance. In a scanned rack,
 * the plan creates the copy, named `<consumer>-<need>`; in a manifest that places devices by
 * hand, the need must be wired to an instance that no other need is wired to.
 *
 * @param connector The connector the need calls.
 * @returns The need, for the `needs` of a device.
 * @throws RackError `RACK_MANIFEST` when `connector` is not a connector.
 */
export function own<C extends Connector>(connector: C): Own<C> {
  if (!isConnector(connector)) throw new RackError("RACK_MANIFEST", "own() requires a connector");
  return Object.freeze({ [OWN]: true as const, connector });
}

/**
 * Reports whether a need is an own need created by {@link own}.
 *
 * @param value Any value, typically an entry of a device's `needs`.
 * @returns `true` when the value carries the own brand.
 */
export function isOwn(value: unknown): value is Own {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [OWN]?: unknown })[OWN] === true &&
    isConnector((value as { connector?: unknown }).connector)
  );
}

/**
 * Returns the connector a need calls.
 *
 * @param need A connector or an own need.
 * @returns The connector.
 */
export function needConnector(need: Need): Connector {
  return isOwn(need) ? need.connector : need;
}

/** Options for an outgoing RPC call. */
export interface CallOptions {
  /**
   * Milliseconds before the call fails with `RACK_TIMEOUT` and is cancelled at the provider;
   * defaults to the rack's `callTimeout`. For a call whose input carries a stream, the time runs
   * from the end of that stream, so an upload doesn't time out while its bytes still move.
   */
  timeout?: number;
  /**
   * Milliseconds that a stream of the call, in its input or its result, may move nothing before
   * it fails with `RACK_TIMEOUT` at both ends; defaults to the call's timeout.
   */
  streamTimeout?: number;
  /**
   * Aborting it fails the call at once with `RACK_CANCELLED` and cancels it at the provider. Its
   * streams are cancelled too, also after the result has arrived.
   */
  signal?: AbortSignal;
  /**
   * Buffers to move to the provider instead of copying them. The call takes them: they are
   * detached as soon as the call is made, whatever its outcome, and every view on them becomes
   * empty. The call fails with `RACK_INVALID_INPUT`, detaching nothing, when an entry is not an
   * attached `ArrayBuffer`, is a `SharedArrayBuffer`, or appears twice.
   */
  transfer?: readonly ArrayBuffer[];
}

/** The second argument of an RPC implementation. */
export interface CallContext {
  /**
   * Aborted when the caller cancels the call or its deadline passes, also after the result was
   * sent while the call's streams are still open.
   */
  readonly signal: AbortSignal;
  /**
   * The deadline of the call, a millisecond timestamp. A call whose input carries a stream has
   * none here, `Infinity`: its caller times it out from the end of that stream, and cancels it.
   */
  readonly deadline: number;
  /**
   * Moves these buffers to the caller with the result instead of copying them. They are
   * detached once the result is sent, whether the call succeeded or failed; listing a buffer
   * again has no further effect.
   *
   * @throws RackError `RACK_INVALID_OUTPUT` for an entry that is not an attached `ArrayBuffer`
   *   or is a `SharedArrayBuffer`, and once the result has been sent.
   */
  transfer(...buffers: ArrayBuffer[]): void;
}

/** Client for a needed connector: one method per RPC member. */
export type PortClient<M extends Members> = {
  readonly [K in keyof M as M[K] extends RpcSpec ? K : never]: (
    input: RpcInput<M[K]>,
    options?: CallOptions,
  ) => Promise<RpcOutput<M[K]>>;
};

/** Event subscriptions for a needed connector: one function per event member. */
export type PortEvents<M extends Members> = {
  readonly [K in keyof M as M[K] extends EventSpec ? K : never]: (
    handler: (payload: EventPayload<M[K]>) => void | Promise<void>,
  ) => () => void;
};

/** Event publishers for a provided connector: one function per event member. */
export type PortEmitter<M extends Members> = {
  readonly [K in keyof M as M[K] extends EventSpec ? K : never]: (
    payload: EventInput<M[K]>,
  ) => Promise<void>;
};

/** A result type that a function may also produce by returning nothing. */
// biome-ignore lint/suspicious/noConfusingVoidType: lets `async () => {}` implement an `undefined` output.
type Returned<T> = undefined extends T ? T | void : T;

/** Implementation of a provided connector: one function per RPC member. */
export type PortImpl<M extends Members> = {
  [K in keyof M as M[K] extends RpcSpec ? K : never]: (
    input: RpcParsedInput<M[K]>,
    call: CallContext,
  ) => Returned<RpcReturn<M[K]>> | Promise<Returned<RpcReturn<M[K]>>>;
};

/** Implementations of every provided port, as returned by `powerOn`. */
export type PortImpls<P extends Ports> = { [K in keyof P]: PortImpl<P[K]["members"]> };

/** Log levels of {@link DeviceLog}. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Device logging; entries reach the rack over the management bus. */
export interface DeviceLog {
  /**
   * @param message Human-readable message.
   * @param data Optional structured-cloneable details; dropped when they cannot be cloned.
   */
  debug(message: string, data?: unknown): void;
  /** @see DeviceLog.debug */
  info(message: string, data?: unknown): void;
  /** @see DeviceLog.debug */
  warn(message: string, data?: unknown): void;
  /** @see DeviceLog.debug */
  error(message: string, data?: unknown): void;
}

/**
 * A watchdog that a device feeds from one of its work loops; see {@link ActivateScope.watchdog}.
 *
 * @decision .agents/decisions/261117_062959-watchdog.md#two-kinds-of-watchdog
 */
export interface Watchdog {
  /** Restarts the watchdog's timeout. Costs one atomic increment; call it as often as needed. */
  feed(): void;
  /** Disarms the watchdog, for example when its job is done; later feeds do nothing. */
  cancel(): void;
}

/** Background-task helpers passed to `activate`; everything stops on `deactivate`. */
export interface ActivateScope {
  /** Aborted on `deactivate`. */
  readonly signal: AbortSignal;
  /**
   * Runs `task` every `ms` milliseconds, waiting for an asynchronous task to settle before the
   * next run. Errors thrown by the task are logged and do not crash the device.
   *
   * @returns A function that cancels the timer.
   * @throws RangeError when `ms` is not a non-negative finite number.
   */
  every(ms: number, task: () => void | Promise<void>): () => void;
  /**
   * Runs `task` once after `ms` milliseconds. Errors thrown by the task are logged.
   *
   * @returns A function that cancels the timer.
   * @throws RangeError when `ms` is not a non-negative finite number.
   */
  after(ms: number, task: () => void | Promise<void>): () => void;
  /**
   * Arms a watchdog for a work loop. Unless `feed()` is called at least every `ms` milliseconds
   * while the instance is active, the rack resets the device, as it does after a crash: the
   * calls in flight fail with `RACK_DEVICE_FAULT`, whose `data` names the watchdog. The watchdog
   * disarms on `deactivate`, or with `cancel()`. Once the scope has stopped, it returns a
   * watchdog that does nothing.
   *
   * @param ms Timeout in milliseconds, at least 1 000.
   * @param name Name in status, errors, and logs; by default `watchdog <n>`, numbered in the
   *   order the instance armed its watchdogs.
   * @throws RangeError when `ms` is not a number of at least 1 000, or when 16 watchdogs are
   *   armed already.
   */
  watchdog(ms: number, name?: string): Watchdog;
}

/** The first argument of every hook. */
export interface DeviceContext<N extends Needs = Needs, P extends Ports = Ports, C = unknown> {
  /** RPC clients for every need, for example `ctx.ports.db.query(input, { timeout })`. */
  readonly ports: { readonly [K in keyof N]: PortClient<NeedConnector<N[K]>["members"]> };
  /** Event subscriptions for every need; events reach only the installed instance. */
  readonly on: { readonly [K in keyof N]: PortEvents<NeedConnector<N[K]>["members"]> };
  /** Event publishers for every provided port; the payload is validated before it is sent. */
  readonly emit: { readonly [K in keyof P]: PortEmitter<P[K]["members"]> };
  /**
   * Opens a listener: an HTTP server, WebSocket included, that the rack hands over across swaps.
   * Call it in `powerOn` only. It resolves once the rack has reserved the address; the listener
   * binds when the rack puts the instance into service, and stops when the instance leaves
   * service. Until the instance is installed, the requests it takes wait.
   *
   * @throws RackError `RACK_HOOK_FAILED` for invalid options, outside `powerOn`, or an address
   *   that can't be reserved, with `data.listener` and, for a conflict, `data.holder`. `powerOn`
   *   fails with it, even when the device catches it.
   */
  serve<T = unknown>(options: ServeOptions<T>): Promise<Listener<T>>;
  /** The validated configuration. */
  readonly config: C;
  /** Logging through the management bus. */
  readonly log: DeviceLog;
  /** Aborted when the instance is powered off. */
  readonly signal: AbortSignal;
  /** The slot this instance is mounted in. */
  readonly slot: { readonly name: string; readonly u: number };
  /** Firmware version (content hash) of this instance. */
  readonly firmware: string;
  /** Base directory of the rack. */
  readonly baseDir: string;
}

/** The configuration type a device sees for a config schema. */
export type ConfigOf<S> = S extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<S> : unknown;

/** What a device file passes to {@link device}. */
export interface DeviceSpec<
  N extends Needs = NoPorts,
  P extends Ports = NoPorts,
  S extends StandardSchemaV1 | undefined = undefined,
> {
  /** Model name; also the default device name. */
  model: string;
  /** Number of U the device occupies; default 1. */
  height?: number;
  /**
   * Connectors this device calls, keyed by need name. A plain connector shares its provider;
   * `own(connector)` asks for a copy of the provider for this instance alone.
   */
  needs?: N;
  /** Connectors this device implements, keyed by port name. */
  provides?: P;
  /** Configuration schema; the Worker validates the slot's configuration with it at boot. */
  config?: S;
  /**
   * Start priority in a scanned rack, an integer; default 0. Among the devices whose order the
   * dependency graph leaves open, a higher priority starts earlier, and a device passes its
   * priority down to what it needs. A manifest that places devices by hand ignores it.
   */
  priority?: number;
  /**
   * How the rack replaces this device: `"hot"`, the default, starts the new instance before the
   * old one stops; `"cold"` stops the old instance first, for devices whose two instances must
   * never run at the same time, such as one that holds a file lock or a serial port. State moves
   * through `snapshot` and `restore` either way.
   */
  swap?: "hot" | "cold";
  /** Returns the implementation of every provided port. Must not start background tasks. */
  powerOn?(ctx: DeviceContext<N, P, ConfigOf<S>>): PortImpls<P> | Promise<PortImpls<P>>;
  /** Fails the power-on self-test by throwing; a failing instance receives no traffic. */
  selfTest?(ctx: DeviceContext<N, P, ConfigOf<S>>): void | Promise<void>;
  /** Starts background tasks, which must stop on `deactivate`. */
  activate?(ctx: DeviceContext<N, P, ConfigOf<S>>, scope: ActivateScope): void | Promise<void>;
  /** Stops background tasks; `scope` has already been stopped. */
  deactivate?(ctx: DeviceContext<N, P, ConfigOf<S>>): void | Promise<void>;
  /** Returns structured-cloneable in-memory state for the next instance. */
  snapshot?(ctx: DeviceContext<N, P, ConfigOf<S>>): unknown;
  /**
   * Receives the state of the previous instance; validate it, since older firmware may have
   * written a different shape.
   */
  restore?(
    ctx: DeviceContext<N, P, ConfigOf<S>>,
    state: unknown,
    fromFirmware: string,
  ): void | Promise<void>;
  /** Releases resources; `ctx.signal` aborts after it returns. */
  powerOff?(ctx: DeviceContext<N, P, ConfigOf<S>>): void | Promise<void>;
}

/** Brand of device definitions; a global symbol, because a bundle may carry its own copy. */
export const DEVICE: unique symbol = Symbol.for("rack42u.device");

/** A device definition, the default export of a device file. */
export interface DeviceDefinition<
  N extends Needs = Needs,
  P extends Ports = Ports,
  S extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
> extends DeviceSpec<N, P, S> {
  readonly [DEVICE]: true;
  readonly height: number;
  readonly needs: N;
  readonly provides: P;
  readonly priority: number;
  readonly swap: "hot" | "cold";
}

/** Lifecycle hooks the rack runs on request, in addition to boot. */
export type HookName =
  | "powerOn"
  | "selfTest"
  | "activate"
  | "deactivate"
  | "snapshot"
  | "restore"
  | "powerOff";

const HOOKS: readonly HookName[] = [
  "powerOn",
  "selfTest",
  "activate",
  "deactivate",
  "snapshot",
  "restore",
  "powerOff",
];

/**
 * Defines a device. Export the result as the default export of the device file.
 *
 * @param spec Model, height, needs, provides, config schema, and lifecycle hooks.
 * @returns The device definition.
 * @throws RackError `RACK_MANIFEST` when a field is malformed; the device then fails to boot.
 */
export function device<
  N extends Needs = NoPorts,
  P extends Ports = NoPorts,
  S extends StandardSchemaV1 | undefined = undefined,
>(spec: DeviceSpec<N, P, S>): DeviceDefinition<N, P, S> {
  if (typeof spec !== "object" || spec === null) {
    throw new RackError("RACK_MANIFEST", "device() requires a spec object");
  }
  const { model } = spec;
  if (typeof model !== "string" || model === "") {
    throw new RackError("RACK_MANIFEST", "device() requires a non-empty model name");
  }
  const height = spec.height ?? 1;
  if (!Number.isInteger(height) || height < 1) {
    throw new RackError("RACK_MANIFEST", `device ${model}: height must be a positive integer`);
  }
  const needs = checkPorts(model, "needs", spec.needs, isNeed);
  const provides = checkPorts(model, "provides", spec.provides, isConnector);
  const priority = spec.priority ?? 0;
  if (!Number.isSafeInteger(priority)) {
    throw new RackError("RACK_MANIFEST", `device ${model}: priority must be an integer`);
  }
  const swap = spec.swap ?? "hot";
  if (swap !== "hot" && swap !== "cold") {
    throw new RackError("RACK_MANIFEST", `device ${model}: swap must be "hot" or "cold"`);
  }
  if (spec.config !== undefined && !isStandardSchema(spec.config)) {
    throw new RackError("RACK_MANIFEST", `device ${model}: config must be a Standard Schema`);
  }
  for (const hook of HOOKS) {
    if (spec[hook] !== undefined && typeof spec[hook] !== "function") {
      throw new RackError("RACK_MANIFEST", `device ${model}: ${hook} must be a function`);
    }
  }
  return Object.freeze({
    ...spec,
    [DEVICE]: true as const,
    height,
    needs,
    provides,
    priority,
    swap,
  });
}

function isNeed(value: unknown): value is Need {
  return isConnector(value) || isOwn(value);
}

function checkPorts<T extends Needs>(
  model: string,
  field: string,
  ports: T | undefined,
  valid: (value: unknown) => boolean,
): T {
  if (ports === undefined) return {} as T;
  if (typeof ports !== "object" || ports === null) {
    throw new RackError("RACK_MANIFEST", `device ${model}: ${field} must be an object`);
  }
  for (const [name, value] of Object.entries(ports)) {
    if (!isIdentifierName(name)) {
      throw new RackError("RACK_MANIFEST", `device ${model}: ${field} key "${name}" is invalid`);
    }
    if (!valid(value)) {
      const what = field === "needs" ? "a connector or own(connector)" : "a connector";
      throw new RackError("RACK_MANIFEST", `device ${model}: ${field}.${name} is not ${what}`);
    }
  }
  return ports;
}

/**
 * Reports whether a value is a device definition created by {@link device}.
 *
 * @param value Any value, typically the default export of a firmware module.
 * @returns `true` when the value carries the device brand.
 */
export function isDevice(value: unknown): value is DeviceDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [DEVICE]?: unknown })[DEVICE] === true
  );
}

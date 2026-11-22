/**
 * Worker host for one `sled` device instance.
 *
 * The rack main thread starts this module in a fresh Worker and boots it with a firmware URL.
 * The host loads the firmware, reports FRU data, and runs lifecycle hooks on request. It carries
 * the device's traffic: calls from outside the rack arrive on the data channel, and calls,
 * results, subscriptions, and events between devices travel on links that the backplane hands
 * over the control channel. The host validates RPC input and output for the ports the device
 * provides and the payloads it publishes, owns the timeouts of the calls the device makes, queues
 * calls and events while a slot is held, moves the buffers that calls and results transfer, and
 * counts calls and events.
 *
 * @decision .agents/decisions/261116_024226-backplane-links.md#links
 * @decision .agents/decisions/261116_024226-backplane-links.md#boot-and-fru
 * @decision .agents/decisions/261116_024226-backplane-links.md#rpc
 * @decision .agents/decisions/261116_024226-backplane-links.md#events
 * @decision .agents/decisions/261116_024226-backplane-links.md#in-flight-calls-holding-and-draining
 * @decision .agents/decisions/261116_024226-backplane-links.md#where-validation-happens
 * @decision .agents/decisions/261116_035534-call-metrics.md#counters
 * @decision .agents/decisions/261116_213839-transfer-and-shared-buffers.md#transfer
 * @decision .agents/decisions/261112_043034-device-api.md#device-context
 * @decision .agents/decisions/261117_062959-watchdog.md#two-kinds-of-watchdog
 * @decision .agents/decisions/261117_062959-watchdog.md#feeding-and-checking
 * @decision .agents/decisions/261117_063228-bounded-backlogs.md#bounded-calls
 * @decision .agents/decisions/261117_063228-bounded-backlogs.md#bounded-events
 * @decision .agents/decisions/261117_063228-bounded-backlogs.md#stale-calls
 * @decision .agents/decisions/261118_071155-backplane-streams.md#streams-in-calls
 * @decision .agents/decisions/261118_071155-backplane-streams.md#timeouts
 * @decision .agents/decisions/261118_071155-backplane-streams.md#cancellation-and-errors
 * @decision .agents/decisions/261118_071155-backplane-streams.md#swaps-and-resets
 * @decision .agents/decisions/261118_071155-backplane-streams.md#observation
 * @decision .agents/decisions/261118_070617-panels-as-devices.md#listeners
 * @decision .agents/decisions/261118_070617-panels-as-devices.md#when-listeners-listen
 */
import { type ConnectorInfo, describeConnector, type EventSpec } from "./connector.ts";
import {
  type ActivateScope,
  type CallContext,
  type CallOptions,
  checkNeeds,
  type DeviceContext,
  type DeviceDefinition,
  type DeviceLog,
  type HookName,
  isDevice,
  isEvery,
  isOwn,
  isPatched,
  type LogLevel,
  type Needs,
  needConnector,
  type ReachedDevice,
  type Watchdog,
} from "./device.ts";
import { fromWireError, isCloneable, RackError, toWireError, type WireError } from "./errors.ts";
import { importFirmware } from "./firmware.ts";
import { ListenerHost } from "./listeners.ts";
import type {
  CalledRpcMetrics,
  EmittedEventMetrics,
  InstanceMetrics,
  LoopMetrics,
  NeedMetrics,
  PortMetrics,
  ReceivedEventMetrics,
  ServedRpcMetrics,
  StreamMetrics,
} from "./metrics.ts";
import { setBaseDir } from "./packaged.ts";
import {
  type AnswerMessage,
  type AttachRequest,
  type BootRequest,
  type CallResult,
  type ControlNotice,
  type ControlReply,
  type ControlRequest,
  type DataToWorker,
  type DescribeRequest,
  type DrainRequest,
  type Fru,
  type HoldEventsRequest,
  type HookRequest,
  type InjectedFault,
  type LinkCall,
  type LiveRequest,
  type Marker,
  type NeedDownRequest,
  type NeedHoldRequest,
  type NeedInfo,
  type NeedLinkRequest,
  type NeedMembersRequest,
  QUEUE_LIMIT,
  type ReserveAsk,
  SHARED_LISTENERS,
  SHARED_LOOP,
  SHARED_SERVING,
  SHARED_WATCHDOGS,
  type ToConsumer,
  type ToProvider,
  WATCHDOG_LIMIT,
  WATCHDOG_MIN,
} from "./protocol.ts";
import { validate } from "./schema.ts";
import {
  armTimer,
  cancelStreams,
  LONGEST_TIMER,
  putStream,
  StreamChannel,
  type StreamReceiver,
  StreamSender,
  type StreamSlot,
  takeStream,
} from "./streams.ts";
import { detach, moveInto, transferList, untransferable } from "./transfer.ts";

// Untyped on purpose: implementations come from device code and are checked at powerOn.
type Impl = (input: unknown, call: CallContext) => unknown;
type EventHandler = (payload: unknown, from?: string) => void | Promise<void>;
type Outcome = { ok: true; value: unknown } | { ok: false; error: RackError };

interface Booted {
  def: DeviceDefinition;
  ctx: DeviceContext;
  name: string;
}

/** A call the device made through one of its needs. */
interface Outgoing {
  readonly need: NeedState;
  readonly member: string;
  readonly stats: CalledRpcMetrics;
  readonly started: number;
  readonly deadline: number;
  /** The call's timeout in ms; for a call with an input stream, it runs from that stream's end. */
  readonly ms: number;
  /** Idle timeout of the call's streams, in ms. */
  readonly idle: number;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  /** The input until the call goes out on a link. */
  input: unknown;
  /**
   * The buffers the call took from the caller, or the ones it moved into its queued input. They
   * leave with the input; any still attached when the call settles are detached.
   */
  transfer: ArrayBuffer[] | undefined;
  /** The queue of calls with the same timeout that times it out, while its timeout runs. */
  timed: TimerQueue | undefined;
  /** When it times out, on `performance.now()`'s clock. */
  expires: number;
  /** Its neighbors in `timed`. */
  older: Outgoing | undefined;
  newer: Outgoing | undefined;
  /** The caller's signal, which the call listens to as an `EventListenerObject` until it ends. */
  signal: AbortSignal | undefined;
  /** Shared by every call, so that listening to a signal creates no function per call. */
  readonly handleEvent: (this: Outgoing) => void;
  /** The link the call went out on, and its id there; unset while the call waits. */
  link: NeedLink | undefined;
  id: number;
  queued: boolean;
  /** The result came, or the call failed: its promise has settled. */
  settled: boolean;
  /** The input stream, from the call until it ends. */
  sender: StreamSender | undefined;
  /** Where the input stream goes in the input: a top-level key, or `null` for the input itself. */
  key: string | null;
  /** The output stream, from the result until it ends. */
  receiver: StreamReceiver | undefined;
  /** The call's streams that haven't ended; the call is unfinished until none is left. */
  streams: number;
  /** Counted as finished: it settled, and its streams ended. */
  finished: boolean;
}

/**
 * The calls whose timeouts run, one queue per timeout value. Calls with the same timeout expire
 * in the order their timeouts started, so a queue needs one timer, for its oldest call, where
 * each call would otherwise arm and clear one of its own.
 */
interface TimerQueue {
  readonly ms: number;
  oldest: Outgoing | undefined;
  newest: Outgoing | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** The consumer end of a link. */
interface NeedLink {
  readonly id: number;
  readonly port: MessagePort;
  /** `<device>.<port>` at the other end, for messages. */
  readonly provider: string;
  /** Calls that went out on the link and have no result yet, by their id on the link. */
  readonly pending: Map<number, Outgoing>;
  nextId: number;
  /** Events taken off the link; the provider learns the count in batches. */
  taken: number;
  /** The streams of the calls on the link, in both directions. */
  readonly streams: StreamChannel;
}

/** The calls, links, and subscriptions of one need. */
interface NeedState {
  readonly name: string;
  /** The link new calls go out on; unset while the need has no provider instance. */
  current: NeedLink | undefined;
  /** Every link of the need that may still bring results, the current one included. */
  readonly links: Map<number, NeedLink>;
  /** New calls wait in `queue` instead of going out. */
  held: boolean;
  queue: Outgoing[];
  /** Calls of the need that haven't settled, sent or queued; at most `queueLimit`. */
  unfinished: number;
  /** Event handlers by event name; a name is present while it has handlers. */
  readonly handlers: Map<string, Set<{ handler: EventHandler }>>;
  readonly calls: Map<string, CalledRpcMetrics>;
  readonly events: Map<string, ReceivedEventMetrics>;
  /** For the link of an every need to one device, that device's name, which events carry. */
  readonly from?: string;
  /** For the link of an every need to one device, the every need's name. */
  readonly every?: string;
}

/**
 * An every need: the devices it reaches, and a need state for the link to each, which share the
 * declared need's handlers and counters, so that subscriptions cover every device and
 * `metrics()` counts the calls as one need's, while each device has its own bound of calls.
 *
 * @decision .agents/decisions/261121_065823-hot-plug-directories.md#every-needs
 */
interface EveryState {
  readonly name: string;
  /** The devices that it reaches, as the main thread last sent them, in slot order. */
  list: readonly ReachedDevice[];
  /** A need state for each device that it reaches, or reached while a link may bring results. */
  readonly members: Map<string, NeedState>;
  readonly changed: Set<{ handler: (list: readonly ReachedDevice[]) => unknown }>;
  /** The declared need's state, whose handlers and counters the members share. */
  readonly shared: NeedState;
}

/** The provider end of a link. */
interface ConsumerLink {
  readonly id: number;
  readonly port: MessagePort;
  /** The provided port the link serves. */
  readonly portName: string;
  /** Name of the consumer device. */
  readonly consumer: string;
  readonly subscriptions: Set<string>;
  /** Events go out on the link: the consumer instance is installed. */
  live: boolean;
  /** Calls from the link being served, by their id on the link. */
  readonly serving: Map<number, AbortController>;
  /** Events sent on the link, and how many of them the consumer reported taken. */
  sent: number;
  taken: number;
  /** The streams of the calls on the link, in both directions. */
  readonly streams: StreamChannel;
}

interface QueuedEvent {
  port: string;
  event: string;
  payload: unknown;
}

let booted: Booted | undefined;
/** The device's needs: as its file declares them, or as computed from its configuration. */
let declared: Needs = {};
let impls = new Map<string, Map<string, Impl>>();
let scope: { controller: AbortController; cancels: Set<() => void> } | undefined;
const powered = new AbortController();
let callTimeout = 30_000;
/** The most unfinished calls of each need, and the most events waiting on each link. */
let queueLimit = QUEUE_LIMIT;
/**
 * How many events a consumer takes before it tells the provider: often enough that a consumer
 * that keeps up never reaches `queueLimit`, and at most once per 256 events.
 */
let takenBatch = 256;
/**
 * Shared with the main thread, which reads the number of calls being served and the feeds of
 * the watchdogs from it.
 */
let gauge: Int32Array<ArrayBufferLike> = new Int32Array(SHARED_WATCHDOGS + WATCHDOG_LIMIT);
/** How late the timer of the event-loop watchdog runs. */
const loop: LoopMetrics = { delayMs: 0, maxDelayMs: 0 };
/** Which device watchdog counters are in use. */
const armed: boolean[] = new Array<boolean>(WATCHDOG_LIMIT).fill(false);
/** Device watchdogs armed so far, for their default names. */
let watchdogsArmed = 0;
/** Whether this instance is the one installed in its slot; only then do its events go out. */
let installed = false;
let since = Date.now();
/** Calls being served, from links and from outside the rack. */
let serving = 0;
/** Calls from outside the rack being served, by backplane call id. */
const external = new Map<number, AbortController>();
const needs = new Map<string, NeedState>();
/** The every needs, by need name. */
const everyNeeds = new Map<string, EveryState>();
const consumers = new Map<number, ConsumerLink>();
/** Events waiting for held consumer devices, by device name. */
const heldEvents = new Map<string, QueuedEvent[]>();
/** The token of the last hold marker each link brought. */
const markers = new Map<number, number>();
const drains = new Set<{ markers: Marker[]; streams: boolean; resolve: () => void }>();
/** The streams of calls from outside the rack, on the data channel; set at boot. */
let dataStreams: StreamChannel | undefined;
/** Requests to the main thread that wait for their answers, by id. */
const asking = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: unknown) => void }
>();
let nextAsk = 1;
/** The device's listeners. */
const listeners = new ListenerHost({
  name: () => booted?.name ?? "device",
  queueLimit: () => queueLimit,
  ask,
  report: (reports) => post({ op: "listeners", listeners: reports }),
  log,
  count(index, requests, webSockets) {
    Atomics.store(gauge, SHARED_LISTENERS + 2 * index, requests);
    Atomics.store(gauge, SHARED_LISTENERS + 2 * index + 1, webSockets);
  },
  wake: () => checkDrains(),
});
const served = new Map<string, Map<string, ServedRpcMetrics>>();
const emitted = new Map<string, Map<string, EmittedEventMetrics>>();

function post(message: ControlNotice): void {
  postMessage(message);
}

function log(level: LogLevel, message: string, data?: unknown): void {
  const text = String(message);
  if (data === undefined) {
    post({ op: "log", level, message: text });
    return;
  }
  try {
    post({ op: "log", level, message: text, data });
  } catch {
    // The details are not structured-cloneable; the message alone still reaches the rack.
    post({ op: "log", level, message: `${text} (details dropped: not structured-cloneable)` });
  }
}

/** Reports an error from a timer task or an event handler without crashing the device. */
function report(where: string, error: unknown): void {
  const wire = toWireError(error);
  log("error", `${where} failed: ${wire.message}`, { code: wire.code });
}

/** Runs a task, logging both synchronous throws and asynchronous rejections. */
function guarded(where: string, task: () => unknown): Promise<void> {
  try {
    return Promise.resolve(task()).then(
      () => undefined,
      (error) => report(where, error),
    );
  } catch (error) {
    report(where, error);
    return Promise.resolve();
  }
}

/** An error-code counter that accepts any code as a key, `__proto__` included. */
function errorCounts(): Record<string, number> {
  return Object.create(null) as Record<string, number>;
}

function failure(code: string, message: string): Outcome {
  return { ok: false, error: new RackError(code, message) };
}

/** The stream counters of an RPC member, made when one of its calls first carries a stream. */
function streamCounters(stats: { streams?: StreamMetrics }): StreamMetrics {
  stats.streams ??= { opened: 0, open: 0, bytesSent: 0, bytesReceived: 0, errors: errorCounts() };
  return stats.streams;
}

/** The streams of a port, on a link or the data channel. */
function channelOn(port: MessagePort): StreamChannel {
  return new StreamChannel((message, transfer) => port.postMessage(message, transfer ?? []));
}

// ---- Control channel ----

addEventListener("message", (event: MessageEvent<ControlRequest | AnswerMessage>) => {
  const message = event.data;
  if (message.op === "answer") answered(message);
  else void control(message);
});

/** Asks the main thread, which answers on the control channel. */
function ask(question: ReserveAsk): Promise<unknown> {
  const id = nextAsk++;
  return new Promise((resolve, reject) => {
    asking.set(id, { resolve, reject });
    post({ op: "ask", id, ask: question });
  });
}

function answered(message: AnswerMessage): void {
  const waiting = asking.get(message.id);
  if (waiting === undefined) return;
  asking.delete(message.id);
  if (message.ok) waiting.resolve(message.value);
  else waiting.reject(fromWireError(message.error));
}

async function control(request: ControlRequest): Promise<void> {
  let reply: ControlReply;
  try {
    reply = { id: request.id, ok: true, value: await handle(request) };
  } catch (error) {
    reply = { id: request.id, ok: false, error: toWireError(error) };
  }
  try {
    post(reply);
  } catch {
    // Only a hook result can fail to clone: snapshot state is device data.
    const what = request.op === "hook" ? request.hook : request.op;
    post({
      id: request.id,
      ok: false,
      error: {
        code: "RACK_HOOK_FAILED",
        message: `${what} returned a value that cannot be cloned`,
      },
    });
  }
}

function handle(request: ControlRequest): unknown {
  switch (request.op) {
    case "boot":
      return boot(request);
    case "describe":
      return describe(request);
    case "hook":
      return runHook(request);
    case "link":
      return linkNeed(request);
    case "hold":
      return holdNeed(request);
    case "release":
      return setHeld(need(request.need), false);
    case "down":
      return downNeed(request);
    case "members":
      return setMembers(request);
    case "attach":
      return attach(request);
    case "holdEvents":
      return holdEvents(request);
    case "live":
      return live(request);
    case "drop":
      return drop(request.link, request.error);
    case "installed":
      installed = request.installed;
      listeners.setInstalled(installed);
      return undefined;
    case "listen":
      return listeners.listen();
    case "unlisten":
      return listeners.unlisten(request.code);
    case "drain":
      return drain(request);
    case "metrics":
      return snapshot();
    case "fault":
      return injectFault(request.kind);
  }
}

/**
 * Causes a fault on purpose, from a task of its own once the reply has gone out, through the
 * paths of a real fault: an uncaught exception, or an event loop that stays blocked until the
 * event-loop watchdog bites and the rack ends the Worker.
 *
 * @decision .agents/decisions/261119_205416-injected-faults.md#injectfault
 */
function injectFault(kind: InjectedFault): undefined {
  setTimeout(() => {
    if (kind === "crash") throw new Error("injected crash");
    for (;;) {
      // The injected hang: nothing ends this loop but the end of the Worker.
    }
  }, 0);
  return undefined;
}

async function boot(request: BootRequest): Promise<Fru> {
  if (booted !== undefined) throw new RackError("RACK_MANIFEST", "the instance is already booted");
  // Firmware of an executable names its files under the base directory, from the time it loads.
  // @decision .agents/decisions/261120_011627-single-executables.md#running-an-executable
  setBaseDir(request.baseDir);
  const module = (await importFirmware(request.firmware)) as { default?: unknown };
  const def = module.default;
  if (!isDevice(def)) {
    throw new RackError("RACK_MANIFEST", `${request.source} does not default-export a device()`);
  }
  const name = request.name ?? def.model;
  let config = request.config;
  if (def.config !== undefined) {
    const result = await validate(def.config, request.config);
    if (!result.ok) {
      throw new RackError("RACK_INVALID_CONFIG", `${name}: invalid config: ${result.message}`);
    }
    config = result.value;
  }
  declared = needsFor(def, config, name);
  callTimeout = request.callTimeout;
  queueLimit = request.queueLimit;
  takenBatch = Math.max(1, Math.min(256, Math.floor(queueLimit / 4)));
  gauge = new Int32Array(request.gauge);
  feedLoop(request.watchdog);
  since = Date.now();
  prepare(def);
  const ctx = makeContext(def, { name, u: request.u, config, request });
  booted = { def, ctx, name };
  const data = request.port;
  const streams = channelOn(data);
  dataStreams = streams;
  data.addEventListener("message", (event) =>
    onData(data, streams, (event as MessageEvent<DataToWorker>).data),
  );
  data.start();
  return {
    model: def.model,
    name,
    height: def.height,
    needs: describeNeeds(declared),
    provides: describeProvides(def.provides),
    snapshot: def.snapshot !== undefined,
    restore: def.restore !== undefined,
    priority: def.priority,
    swap: def.swap,
    computedNeeds: def.needsOf !== undefined,
  };
}

async function describe(request: DescribeRequest): Promise<Fru> {
  setBaseDir(request.baseDir);
  const module = (await importFirmware(request.firmware)) as { default?: unknown };
  const def = module.default;
  if (!isDevice(def)) {
    throw new RackError("RACK_MANIFEST", `${request.source} does not default-export a device()`);
  }
  let needs = def.needs;
  if (def.needsOf !== undefined) {
    // Needs computed from the configuration come from the configuration the rack gives.
    // @decision .agents/decisions/261118_071513-http-panel-device.md#needs-from-configuration
    let config = request.config;
    if (def.config !== undefined) {
      const result = await validate(def.config, request.config);
      if (!result.ok) {
        throw new RackError(
          "RACK_INVALID_CONFIG",
          `${def.model}: invalid config: ${result.message}`,
        );
      }
      config = result.value;
    }
    needs = needsFor(def, config, def.model);
  }
  return {
    model: def.model,
    name: def.model,
    height: def.height,
    needs: describeNeeds(needs),
    provides: describeProvides(def.provides),
    snapshot: def.snapshot !== undefined,
    restore: def.restore !== undefined,
    priority: def.priority,
    swap: def.swap,
    computedNeeds: def.needsOf !== undefined,
  };
}

function describeNeeds(needs: Needs): Record<string, NeedInfo> {
  const result: Record<string, NeedInfo> = {};
  for (const [name, need] of Object.entries(needs)) {
    const info: NeedInfo = { ...describeConnector(needConnector(need)), own: isOwn(need) };
    if (isPatched(need)) info.patched = need.address;
    if (isEvery(need)) info.every = true;
    result[name] = info;
  }
  return result;
}

/**
 * The needs of a device: as its file declares them, or as its `needs` function computes them
 * from the validated configuration.
 *
 * @throws RackError `RACK_INVALID_CONFIG` when the function fails or returns malformed needs,
 *   unless it throws a `RackError` of its own.
 */
function needsFor(def: DeviceDefinition, config: unknown, name: string): Needs {
  if (def.needsOf === undefined) return def.needs;
  try {
    return checkNeeds(def.model, def.needsOf(config));
  } catch (error) {
    if (error instanceof RackError && error.code !== "RACK_MANIFEST") throw error;
    throw new RackError("RACK_INVALID_CONFIG", `${name}: needs: ${toWireError(error).message}`);
  }
}

function describeProvides(ports: DeviceDefinition["provides"]): Record<string, ConnectorInfo> {
  const result: Record<string, ConnectorInfo> = {};
  for (const [name, c] of Object.entries(ports)) result[name] = describeConnector(c);
  return result;
}

/** Creates the state and the zeroed counters of every need and provided port. */
function prepare(def: DeviceDefinition): void {
  for (const [port, c] of Object.entries(def.provides)) {
    const calls = new Map<string, ServedRpcMetrics>();
    const events = new Map<string, EmittedEventMetrics>();
    for (const [member, spec] of Object.entries(c.members)) {
      if (spec.kind === "rpc") {
        calls.set(member, {
          kind: "rpc",
          calls: 0,
          ok: 0,
          errors: errorCounts(),
          active: 0,
          timeMs: 0,
        });
      } else {
        events.set(member, { kind: "event", emitted: 0, dropped: 0 });
      }
    }
    served.set(port, calls);
    emitted.set(port, events);
  }
  for (const [name, need] of Object.entries(declared)) {
    const c = needConnector(need);
    const state: NeedState = {
      name,
      current: undefined,
      links: new Map(),
      held: false,
      queue: [],
      unfinished: 0,
      handlers: new Map(),
      calls: new Map(),
      events: new Map(),
    };
    for (const [member, spec] of Object.entries(c.members)) {
      if (spec.kind === "rpc") {
        state.calls.set(member, {
          kind: "rpc",
          calls: 0,
          ok: 0,
          errors: errorCounts(),
          pending: 0,
          queued: 0,
          timeMs: 0,
        });
      } else {
        state.events.set(member, { kind: "event", received: 0 });
      }
    }
    needs.set(name, state);
    if (isEvery(need)) {
      everyNeeds.set(name, {
        name,
        list: [],
        members: new Map(),
        changed: new Set(),
        shared: state,
      });
    }
  }
}

interface ContextInput {
  name: string;
  u: number;
  config: unknown;
  request: BootRequest;
}

function makeContext(def: DeviceDefinition, input: ContextInput): DeviceContext {
  const ports: Record<string, Record<string, unknown>> = {};
  const on: Record<string, Record<string, unknown>> = {};
  const emit: Record<string, Record<string, unknown>> = {};
  for (const [name, need] of Object.entries(declared)) {
    const c = needConnector(need);
    const every = everyNeeds.get(name);
    if (every !== undefined) {
      ports[name] = portSet(every, c);
      on[name] = everyEvents(every, c);
      continue;
    }
    const state = needs.get(name) as NeedState;
    const client: Record<string, unknown> = {};
    const events: Record<string, unknown> = {};
    for (const [member, spec] of Object.entries(c.members)) {
      if (spec.kind === "rpc") {
        const stats = state.calls.get(member) as CalledRpcMetrics;
        client[member] = (value: unknown, options?: CallOptions) =>
          callOut(state, member, stats, value, options);
      } else {
        events[member] = (handler: EventHandler) => subscribe(state, member, handler);
      }
    }
    ports[name] = Object.freeze(client);
    on[name] = Object.freeze(events);
  }
  for (const [port, c] of Object.entries(def.provides)) {
    const emitters: Record<string, unknown> = {};
    for (const [member, spec] of Object.entries(c.members)) {
      if (spec.kind === "event") {
        const stats = emitted.get(port)?.get(member) as EmittedEventMetrics;
        emitters[member] = (payload: unknown) =>
          emitOut(`${input.name}.${port}.${member}`, port, member, spec, stats, payload);
      }
    }
    emit[port] = Object.freeze(emitters);
  }
  const logger: DeviceLog = {
    debug: (message, extra) => log("debug", message, extra),
    info: (message, extra) => log("info", message, extra),
    warn: (message, extra) => log("warn", message, extra),
    error: (message, extra) => log("error", message, extra),
  };
  return Object.freeze({
    ports: Object.freeze(ports),
    on: Object.freeze(on),
    emit: Object.freeze(emit),
    serve: (options: Parameters<DeviceContext["serve"]>[0]) => listeners.serve(options),
    config: input.config,
    log: Object.freeze(logger),
    signal: powered.signal,
    slot: Object.freeze({ name: input.name, u: input.u }),
    firmware: input.request.hash,
    baseDir: input.request.baseDir,
  }) as DeviceContext;
}

function need(name: string): NeedState {
  const split = name.indexOf(":");
  if (split >= 0) return memberState(name.slice(0, split), name.slice(split + 1));
  const state = needs.get(name);
  if (state === undefined) throw new RackError("RACK_NO_ROUTE", `the device has no need ${name}`);
  return state;
}

// ---- Every needs ----
// @decision .agents/decisions/261121_065823-hot-plug-directories.md#every-needs

/** The need state of the link of an every need to one device, made on first use. */
function memberState(name: string, device: string): NeedState {
  const set = everyNeeds.get(name);
  if (set === undefined) {
    throw new RackError("RACK_NO_ROUTE", `the device has no every need ${name}`);
  }
  let state = set.members.get(device);
  if (state === undefined) {
    const { handlers, calls, events } = set.shared;
    state = {
      name: `${name}[${device}]`,
      current: undefined,
      links: new Map(),
      held: false,
      queue: [],
      unfinished: 0,
      handlers,
      calls,
      events,
      from: device,
      every: name,
    };
    set.members.set(device, state);
  }
  return state;
}

function reaches(set: EveryState, device: string): boolean {
  return set.list.some((entry) => entry.name === device);
}

/** Takes the devices that an every need reaches now, and tells the `changed()` handlers. */
function setMembers({ need: name, members }: NeedMembersRequest): void {
  const set = everyNeeds.get(name);
  if (set === undefined) return;
  set.list = Object.freeze(members.map((member) => Object.freeze({ ...member })));
  forgetMembers(set);
  for (const { handler } of [...set.changed]) {
    void guarded(`changed handler for ${name}`, () => handler(set.list));
  }
}

/** Drops the need states of devices that the need no longer reaches, once their links are down. */
function forgetMembers(set: EveryState): void {
  for (const [device, state] of set.members) {
    if (state.links.size === 0 && !reaches(set, device)) set.members.delete(device);
  }
}

/** `ctx.ports.<need>` of an every need. */
function portSet(set: EveryState, c: ReturnType<typeof needConnector>): Record<string, unknown> {
  const clients = new Map<string, Readonly<Record<string, unknown>>>();
  const clientFor = (device: string) => {
    const known = clients.get(device);
    if (known !== undefined) return known;
    const methods: Record<string, unknown> = {};
    for (const [member, spec] of Object.entries(c.members)) {
      if (spec.kind !== "rpc") continue;
      const stats = set.shared.calls.get(member) as CalledRpcMetrics;
      methods[member] = (value: unknown, options?: CallOptions) => {
        if (!reaches(set, device)) {
          const message = `${set.name}[${device}].${member}: the need doesn't reach ${device} now`;
          return Promise.reject(new RackError("RACK_LINK_DOWN", message));
        }
        return callOut(memberState(set.name, device), member, stats, value, options);
      };
    }
    const client = Object.freeze(methods);
    clients.set(device, client);
    return client;
  };
  return Object.freeze({
    list: () => set.list,
    get: (device: unknown) =>
      typeof device === "string" && reaches(set, device) ? clientFor(device) : undefined,
    changed: (handler: (list: readonly ReachedDevice[]) => unknown) => {
      if (typeof handler !== "function") {
        throw new RackError("RACK_INVALID_INPUT", `${set.name}: the handler must be a function`);
      }
      const entry = { handler };
      set.changed.add(entry);
      return () => {
        set.changed.delete(entry);
      };
    },
  });
}

/** `ctx.on.<need>` of an every need: each handler gets the events of every device it reaches. */
function everyEvents(
  set: EveryState,
  c: ReturnType<typeof needConnector>,
): Record<string, unknown> {
  const events: Record<string, unknown> = {};
  for (const [member, spec] of Object.entries(c.members)) {
    if (spec.kind === "event") {
      events[member] = (handler: EventHandler) => subscribeEvery(set, member, handler);
    }
  }
  return Object.freeze(events);
}

function subscribeEvery(set: EveryState, event: string, handler: EventHandler): () => void {
  if (typeof handler !== "function") {
    throw new RackError(
      "RACK_INVALID_INPUT",
      `${set.name}.${event}: the handler must be a function`,
    );
  }
  const handlers = set.shared.handlers;
  let entries = handlers.get(event);
  if (entries === undefined) {
    entries = new Set();
    handlers.set(event, entries);
    // The links made later learn the subscription when they are made.
    for (const state of set.members.values()) {
      state.current?.port.postMessage({ t: "sub", event } satisfies ToProvider);
    }
  }
  const entry = { handler };
  const own = entries;
  own.add(entry);
  return () => {
    if (!own.delete(entry) || own.size > 0 || handlers.get(event) !== own) return;
    handlers.delete(event);
    for (const state of set.members.values()) {
      state.current?.port.postMessage({ t: "unsub", event } satisfies ToProvider);
    }
  };
}

// ---- Calls the device makes ----

function callOut(
  state: NeedState,
  member: string,
  stats: CalledRpcMetrics,
  input: unknown,
  options: CallOptions = {},
): Promise<unknown> {
  const where = `${state.name}.${member}`;
  return new Promise((resolve, reject) => {
    const { timeout, signal, transfer, streamTimeout } = options;
    const valid = timeout === undefined || (typeof timeout === "number" && timeout >= 0);
    const ms = valid && timeout !== undefined ? timeout : callTimeout;
    const validIdle =
      streamTimeout === undefined || (typeof streamTimeout === "number" && streamTimeout >= 0);
    const call: Outgoing = {
      need: state,
      member,
      stats,
      started: performance.now(),
      deadline: Date.now() + ms,
      ms,
      idle: validIdle && streamTimeout !== undefined ? streamTimeout : ms,
      resolve,
      reject,
      input,
      transfer: undefined,
      timed: undefined,
      expires: 0,
      older: undefined,
      newer: undefined,
      signal: undefined,
      handleEvent: onCallAborted,
      link: undefined,
      id: 0,
      queued: false,
      settled: false,
      sender: undefined,
      key: null,
      receiver: undefined,
      streams: 0,
      finished: false,
    };
    stats.calls++;
    stats.pending++;
    state.unfinished++;
    // From here on the call owns its stream and its buffers, so they are gone whatever its
    // outcome.
    // @decision .agents/decisions/261118_071155-backplane-streams.md#streams-in-calls
    try {
      const taken = takeStream(input, "RACK_INVALID_INPUT", where);
      if (taken !== undefined) {
        call.input = taken.value;
        call.key = taken.key;
        call.sender = new StreamSender(taken.stream, "RACK_INVALID_INPUT", {
          idle: call.idle,
          where,
          counters: streamCounters(stats),
          onEnd: (error) => inputEnded(call, error),
        });
        call.streams++;
      }
    } catch (error) {
      cancelStreams(input, new RackError("RACK_CANCELLED", `${where}: the call failed`));
      settle(call, { ok: false, error: error as RackError });
      return;
    }
    try {
      call.transfer = transferList(transfer, where);
    } catch (error) {
      settle(call, { ok: false, error: error as RackError });
      return;
    }
    if (!valid) {
      settle(call, failure("RACK_INVALID_INPUT", `${where}: timeout must be >= 0 ms`));
      return;
    }
    if (!validIdle) {
      settle(call, failure("RACK_INVALID_INPUT", `${where}: streamTimeout must be >= 0 ms`));
      return;
    }
    if (signal?.aborted) {
      settle(call, failure("RACK_CANCELLED", `${where}: call cancelled`));
      return;
    }
    if (state.unfinished > queueLimit) {
      const message = `${where}: ${state.name} has ${queueLimit} unfinished calls already`;
      settle(call, failure("RACK_OVERLOADED", message));
      return;
    }
    // A call with an input stream times out from the end of that stream.
    if (call.sender === undefined) startTimer(call);
    if (signal !== undefined) {
      // A signal aborts once, and the end of the call removes the listener: `once` would only
      // cost.
      call.signal = signal;
      signal.addEventListener("abort", call);
    }
    if (state.held) enqueue(state, call);
    else send(state, call);
  });
}

/** The caller's signal aborted: the call fails, and so do its streams. */
function onCallAborted(this: Outgoing): void {
  const error = new RackError("RACK_CANCELLED", `${this.need.name}.${this.member}: call cancelled`);
  // The provider's call.signal aborts too, also when the result came and streams still run.
  cancelAtProvider(this, true);
  this.sender?.cancel(error);
  this.receiver?.cancel(error);
  settle(this, { ok: false, error });
}

/**
 * Starts the timeout of a call. The caller's host owns the timeout of a call on a link.
 *
 * @decision .agents/decisions/261116_024226-backplane-links.md#rpc
 */
function startTimer(call: Outgoing): void {
  if (call.settled || call.timed !== undefined || !Number.isFinite(call.ms)) return;
  const ms = Math.min(Math.max(0, call.ms), LONGEST_TIMER);
  let queue = timerQueues.get(ms);
  if (queue === undefined) {
    queue = { ms, oldest: undefined, newest: undefined, timer: undefined };
    timerQueues.set(ms, queue);
  }
  call.timed = queue;
  call.expires = performance.now() + ms;
  call.older = queue.newest;
  if (queue.newest === undefined) queue.oldest = call;
  else queue.newest.newer = call;
  queue.newest = call;
  if (queue.timer === undefined) armQueue(queue);
}

/** Calls with timeouts that run, by their timeout in ms. */
const timerQueues = new Map<number, TimerQueue>();

function armQueue(queue: TimerQueue): void {
  const oldest = queue.oldest;
  if (oldest === undefined) return;
  queue.timer = setTimeout(() => expire(queue), Math.max(0, oldest.expires - performance.now()));
}

/** Times out the calls of a queue whose time has come, and waits for the next one. */
function expire(queue: TimerQueue): void {
  queue.timer = undefined;
  // A timer can fire a little early on its clock; a millisecond is within its precision.
  const now = performance.now() + 1;
  for (let call = queue.oldest; call !== undefined && call.expires <= now; call = queue.oldest) {
    stopTimer(call);
    const target = call.link?.provider ?? call.need.name;
    cancelAtProvider(call);
    settle(call, failure("RACK_TIMEOUT", `${target}.${call.member} timed out after ${call.ms} ms`));
  }
  if (queue.oldest === undefined) timerQueues.delete(queue.ms);
  else armQueue(queue);
}

/** Takes a call out of its timer queue; the queue's timer, set for an older call, may stay. */
function stopTimer(call: Outgoing): void {
  const queue = call.timed;
  if (queue === undefined) return;
  call.timed = undefined;
  if (call.older === undefined) queue.oldest = call.newer;
  else call.older.newer = call.newer;
  if (call.newer === undefined) queue.newest = call.older;
  else call.newer.older = call.older;
  call.older = undefined;
  call.newer = undefined;
  if (queue.oldest === undefined && queue.timer !== undefined) {
    clearTimeout(queue.timer);
    queue.timer = undefined;
    timerQueues.delete(queue.ms);
  }
}

/**
 * The input stream of a call ended, failed, or was cancelled. The call's timeout runs from then.
 * A call that still waits to go out fails with the stream's error, such as `RACK_TIMEOUT` once
 * it has waited `streamTimeout`.
 *
 * @decision .agents/decisions/261118_071155-backplane-streams.md#swaps-and-resets
 */
function inputEnded(call: Outgoing, error: RackError | undefined): void {
  call.streams--;
  if (!call.settled) {
    if (error !== undefined && call.link === undefined) settle(call, { ok: false, error });
    else startTimer(call);
  }
  finishIfDone(call);
  checkDrains();
}

function outputEnded(call: Outgoing): void {
  call.streams--;
  finishIfDone(call);
  checkDrains();
}

/** Keeps a call until its need is released; `queueLimit` bounds the queue with the rest. */
function enqueue(state: NeedState, call: Outgoing): void {
  const where = `${state.name}.${call.member}`;
  try {
    // A call that goes out later still carries its input as it was when the device called, and
    // takes its buffers at once.
    if (call.transfer === undefined) call.input = structuredClone(call.input);
    else ({ value: call.input, buffers: call.transfer } = moveInto(call.input, call.transfer));
  } catch {
    // DataCloneError: the caller reports uncloneable input locally.
    settle(call, failure("RACK_INVALID_INPUT", `${where}: input cannot be cloned`));
    return;
  }
  call.queued = true;
  call.stats.queued++;
  state.queue.push(call);
}

function send(state: NeedState, call: Outgoing): void {
  const where = `${state.name}.${call.member}`;
  const link = state.current;
  if (link === undefined) {
    settle(call, failure("RACK_LINK_DOWN", `${where}: the provider is not online`));
    return;
  }
  const id = link.nextId++;
  const message: LinkCall = {
    t: "call",
    id,
    member: call.member,
    input: call.input,
    // The provider sees no deadline for a call with an input stream; its caller times it out.
    deadline: call.sender === undefined ? call.deadline : Number.POSITIVE_INFINITY,
    idle: call.idle,
  };
  if (call.sender !== undefined) {
    message.stream = [call.key, link.streams.attach(call.sender)] satisfies StreamSlot;
  }
  try {
    if (call.transfer === undefined) link.port.postMessage(message);
    else link.port.postMessage(message, call.transfer);
  } catch {
    // DataCloneError: the caller reports uncloneable input locally.
    settle(call, failure("RACK_INVALID_INPUT", `${where}: input cannot be cloned`));
    return;
  }
  call.input = undefined;
  call.link = link;
  call.id = id;
  link.pending.set(id, call);
}

/**
 * Cancels a call at its provider, which aborts the implementation's `call.signal`.
 *
 * @param afterResult Cancel also a call whose result came while its streams are still open.
 */
function cancelAtProvider(call: Outgoing, afterResult = false): void {
  if (call.link === undefined || call.finished) return;
  if (call.settled && !(afterResult && call.streams > 0)) return;
  call.link.port.postMessage({ t: "cancel", id: call.id } satisfies ToProvider);
}

/**
 * Settles a call once: stops its timer, counts its outcome, and resolves or rejects it. A call
 * that fails takes its input stream with it. The call stays unfinished until its streams end.
 */
function settle(call: Outgoing, outcome: Outcome): void {
  if (call.settled) return;
  call.settled = true;
  stopTimer(call);
  if (call.transfer !== undefined) detach(call.transfer);
  call.link?.pending.delete(call.id);
  const { stats } = call;
  if (call.queued) {
    call.queued = false;
    stats.queued--;
    const queue = call.need.queue;
    const index = queue.indexOf(call);
    if (index >= 0) queue.splice(index, 1);
  }
  stats.timeMs += performance.now() - call.started;
  if (outcome.ok) stats.ok++;
  else {
    const { code } = outcome.error;
    stats.errors[code] = (stats.errors[code] ?? 0) + 1;
    const where = `${call.need.name}.${call.member}`;
    call.sender?.cancel(new RackError("RACK_CANCELLED", `${where}: the call failed`));
  }
  finishIfDone(call);
  if (outcome.ok) call.resolve(outcome.value);
  else call.reject(outcome.error);
}

/** Counts a call as finished once it has settled and its streams have ended. */
function finishIfDone(call: Outgoing): void {
  if (call.finished || !call.settled || call.streams > 0) return;
  call.finished = true;
  call.signal?.removeEventListener("abort", call);
  call.stats.pending--;
  call.need.unfinished--;
}

/** Holds or releases a need; a release sends the queued calls on the current link in order. */
function setHeld(state: NeedState, held: boolean): void {
  state.held = held;
  if (held) return;
  const queue = state.queue;
  state.queue = [];
  for (const call of queue) {
    call.queued = false;
    call.stats.queued--;
    send(state, call);
  }
}

function linkNeed({ need: name, link: id, end, provider, hold }: NeedLinkRequest): void {
  const state = need(name);
  const link: NeedLink = {
    id,
    port: end,
    provider,
    pending: new Map(),
    nextId: 1,
    taken: 0,
    streams: channelOn(end),
  };
  state.links.set(id, link);
  state.current = link;
  end.addEventListener("message", (event) =>
    onNeedLink(state, link, (event as MessageEvent<ToConsumer>).data),
  );
  end.start();
  // The provider instance learns the subscriptions before any queued call reaches it.
  for (const event of state.handlers.keys()) {
    end.postMessage({ t: "sub", event } satisfies ToProvider);
  }
  if (hold === undefined) {
    setHeld(state, false);
    return;
  }
  // The link leads to a held instance: calls wait, and its drain finds this marker at once.
  state.held = true;
  end.postMessage({ t: "hold", token: hold } satisfies ToProvider);
}

function holdNeed({ need: name, token }: NeedHoldRequest): void {
  const state = need(name);
  state.held = true;
  state.current?.port.postMessage({ t: "hold", token } satisfies ToProvider);
}

function downNeed({ need: name, link: id, error }: NeedDownRequest): void {
  const state = need(name);
  const link = state.links.get(id);
  if (link === undefined) return;
  state.links.delete(id);
  if (state.current === link) state.current = undefined;
  // The link's streams fail with the code its pending calls get.
  // @decision .agents/decisions/261118_071155-backplane-streams.md#cancellation-and-errors
  link.streams.close(fromWireError(error));
  for (const call of [...link.pending.values()]) {
    settle(call, { ok: false, error: fromWireError(error) });
  }
  link.port.close();
  markers.delete(id);
  if (state.every !== undefined) {
    const set = everyNeeds.get(state.every);
    if (set !== undefined) forgetMembers(set);
  }
  checkDrains();
}

function onNeedLink(state: NeedState, link: NeedLink, message: ToConsumer): void {
  switch (message.t) {
    case "result": {
      const call = link.pending.get(message.id);
      const slot = message.ok ? message.stream : undefined;
      if (call === undefined) {
        // Nobody waits for the result any more, so its stream is cancelled at its source.
        if (slot !== undefined) {
          link.streams.refuse(slot[1], new RackError("RACK_CANCELLED", "the caller gave up"));
        }
        return;
      }
      if (!message.ok) {
        settle(call, { ok: false, error: fromWireError(message.error) });
        return;
      }
      let value = message.value;
      if (slot !== undefined) {
        const receiver = link.streams.receive(slot[1], {
          idle: call.idle,
          where: `${state.name}.${call.member}`,
          counters: streamCounters(call.stats),
          onEnd: () => outputEnded(call),
        });
        call.receiver = receiver;
        call.streams++;
        value = putStream(value, slot[0], receiver.stream);
      }
      settle(call, { ok: true, value });
      return;
    }
    case "stream":
      link.streams.onMessage(message);
      return;
    case "event":
      link.taken++;
      if (link.taken % takenBatch === 0) {
        link.port.postMessage({ t: "taken", count: link.taken } satisfies ToProvider);
      }
      // A replaced link carries the events of an instance that is no longer installed.
      if (state.current === link) deliver(state, message.event, message.payload);
      return;
    case "hold":
      markers.set(link.id, message.token);
      checkDrains();
      return;
  }
}

function subscribe(state: NeedState, event: string, handler: EventHandler): () => void {
  if (typeof handler !== "function") {
    throw new RackError(
      "RACK_INVALID_INPUT",
      `${state.name}.${event}: the handler must be a function`,
    );
  }
  let set = state.handlers.get(event);
  if (set === undefined) {
    set = new Set();
    state.handlers.set(event, set);
    state.current?.port.postMessage({ t: "sub", event } satisfies ToProvider);
  }
  const entry = { handler };
  const own = set;
  own.add(entry);
  return () => {
    if (!own.delete(entry) || own.size > 0 || state.handlers.get(event) !== own) return;
    state.handlers.delete(event);
    state.current?.port.postMessage({ t: "unsub", event } satisfies ToProvider);
  };
}

function deliver(state: NeedState, event: string, payload: unknown): void {
  const stats = state.events.get(event);
  if (stats !== undefined) stats.received++;
  const set = state.handlers.get(event);
  if (set === undefined) return;
  const from = state.from;
  for (const { handler } of [...set]) {
    void guarded(`event handler for ${state.name}.${event}`, () =>
      from === undefined ? handler(payload) : handler(payload, from),
    );
  }
}

// ---- Events the device emits ----

async function emitOut(
  where: string,
  port: string,
  event: string,
  spec: EventSpec,
  stats: EmittedEventMetrics,
  payload: unknown,
): Promise<void> {
  const result = await validate(spec.payload, payload);
  // An event payload is output of the publishing device.
  // @decision .agents/decisions/261115_222025-p0-api-details.md#device-hooks
  if (!result.ok) throw new RackError("RACK_INVALID_OUTPUT", `${where}: ${result.message}`);
  const value = result.value;
  const uncloneable = () =>
    new RackError("RACK_INVALID_OUTPUT", `${where}: payload cannot be cloned`);
  if (!installed) {
    if (!isCloneable(value)) throw uncloneable();
    stats.emitted++;
    stats.dropped++;
    log("warn", `dropped event ${port}.${event} from an instance that is not installed`);
    return;
  }
  let cloned = false;
  const queuedFor = new Set<string>();
  for (const link of consumers.values()) {
    if (link.portName !== port) continue;
    const queue = heldEvents.get(link.consumer);
    if (queue !== undefined) {
      // A held consumer gets each event once, whichever of its instances ends up installed.
      if (queuedFor.has(link.consumer)) continue;
      queuedFor.add(link.consumer);
      if (queue.length >= queueLimit) {
        stats.dropped++;
        continue;
      }
      let copy: unknown;
      try {
        copy = structuredClone(value);
      } catch {
        throw uncloneable();
      }
      queue.push({ port, event, payload: copy });
      cloned = true;
      continue;
    }
    if (!link.live || !link.subscriptions.has(event)) continue;
    // A subscriber that falls `queueLimit` events behind misses the next ones.
    if (link.sent - link.taken >= queueLimit) {
      stats.dropped++;
      continue;
    }
    try {
      link.port.postMessage({ t: "event", event, payload: value } satisfies ToConsumer);
    } catch {
      // DataCloneError: the payload passed validation but cannot cross threads.
      throw uncloneable();
    }
    link.sent++;
    cloned = true;
  }
  // Nothing cloned the payload yet; an uncloneable one still fails the emit.
  if (!cloned && !isCloneable(value)) throw uncloneable();
  stats.emitted++;
}

// ---- Links to consumers ----

function attach({ link: id, end, port, consumer, live, held }: AttachRequest): void {
  const link: ConsumerLink = {
    id,
    port: end,
    portName: port,
    consumer,
    subscriptions: new Set(),
    live,
    serving: new Map(),
    sent: 0,
    taken: 0,
    streams: channelOn(end),
  };
  consumers.set(id, link);
  if (held && !heldEvents.has(consumer)) heldEvents.set(consumer, []);
  end.addEventListener("message", (event) =>
    onConsumerLink(link, (event as MessageEvent<ToProvider>).data),
  );
  end.start();
}

function onConsumerLink(link: ConsumerLink, message: ToProvider): void {
  switch (message.t) {
    case "call":
      void serve(
        { ...message, port: link.portName },
        link.streams,
        link.serving,
        (reply, transfer) =>
          transfer === undefined
            ? link.port.postMessage(reply)
            : link.port.postMessage(reply, transfer),
      );
      return;
    case "stream":
      link.streams.onMessage(message);
      return;
    case "cancel":
      link.serving.get(message.id)?.abort(new RackError("RACK_CANCELLED", "call cancelled"));
      return;
    case "sub":
      link.subscriptions.add(message.event);
      return;
    case "unsub":
      link.subscriptions.delete(message.event);
      return;
    case "hold":
      markers.set(link.id, message.token);
      checkDrains();
      return;
    case "taken":
      link.taken = Math.max(link.taken, message.count);
      return;
  }
}

function holdEvents({ consumer, token }: HoldEventsRequest): void {
  if (!heldEvents.has(consumer)) heldEvents.set(consumer, []);
  for (const link of consumers.values()) {
    if (link.consumer === consumer)
      link.port.postMessage({ t: "hold", token } satisfies ToConsumer);
  }
}

function live({ consumer, links }: LiveRequest): void {
  const chosen = new Set(links);
  for (const link of consumers.values()) {
    if (link.consumer === consumer) link.live = chosen.has(link.id);
  }
  const queue = heldEvents.get(consumer);
  heldEvents.delete(consumer);
  for (const { port, event, payload } of queue ?? []) {
    for (const link of consumers.values()) {
      if (!link.live || link.consumer !== consumer || link.portName !== port) continue;
      if (link.subscriptions.has(event)) {
        link.port.postMessage({ t: "event", event, payload } satisfies ToConsumer);
        link.sent++;
      }
    }
  }
}

function drop(id: number, error: WireError | undefined): void {
  const link = consumers.get(id);
  if (link === undefined) return;
  consumers.delete(id);
  // The link's streams fail with the code the consumer's end got.
  // @decision .agents/decisions/261118_071155-backplane-streams.md#cancellation-and-errors
  link.streams.close(
    error === undefined
      ? new RackError("RACK_LINK_DOWN", `${link.consumer} is gone`)
      : fromWireError(error),
  );
  for (const controller of link.serving.values()) {
    controller.abort(new RackError("RACK_CANCELLED", "call cancelled"));
  }
  link.port.close();
  markers.delete(id);
  checkDrains();
}

// ---- Calls the device serves ----

function onData(data: MessagePort, streams: StreamChannel, message: DataToWorker): void {
  if (message.t === "call") {
    void serve(message, streams, external, (reply, transfer) =>
      transfer === undefined ? data.postMessage(reply) : data.postMessage(reply, transfer),
    );
  } else if (message.t === "stream") {
    streams.onMessage(message);
  } else {
    external.get(message.id)?.abort(new RackError("RACK_CANCELLED", "call cancelled"));
  }
}

/** A call to serve, from a link or from outside the rack. */
interface Incoming {
  id: number;
  port: string;
  member: string;
  input: unknown;
  deadline: number;
  idle: number;
  stream?: StreamSlot;
}

/**
 * Serves one call. It counts as being served, for drains and `status()`, until its result is
 * sent, and as active until its streams have ended too.
 */
async function serve(
  message: Incoming,
  channel: StreamChannel,
  registry: Map<number, AbortController>,
  reply: (result: CallResult, transfer: ArrayBuffer[] | undefined) => void,
): Promise<void> {
  const state = booted;
  if (state === undefined) return;
  const { id, port, member, deadline, idle } = message;
  const address = `${state.name}.${port}.${member}`;
  const stats = served.get(port)?.get(member);
  const started = performance.now();
  const controller = new AbortController();
  registry.set(id, controller);
  serving++;
  Atomics.add(gauge, SHARED_SERVING, 1);
  if (stats !== undefined) {
    stats.calls++;
    stats.active++;
  }
  /** The call's streams that haven't ended. */
  let open = 0;
  let answered = false;
  let complete = false;
  const finishIfDone = () => {
    if (complete || !answered || open > 0) return;
    complete = true;
    // A cancel that comes later finds nothing to abort.
    if (registry.get(id) === controller) registry.delete(id);
    if (stats !== undefined) stats.active--;
  };
  let input = message.input;
  let receiver: StreamReceiver | undefined;
  let sender: StreamSender | undefined;
  // The receiving end opens before anything awaits, so the stream's first piece finds it.
  if (message.stream !== undefined) {
    const [key, streamId] = message.stream;
    if (stats === undefined) {
      channel.refuse(streamId, new RackError("RACK_NO_ROUTE", `${address} is not an RPC member`));
    } else {
      receiver = channel.receive(streamId, {
        idle,
        where: address,
        counters: streamCounters(stats),
        onEnd: () => {
          open--;
          finishIfDone();
          checkDrains();
        },
      });
      open++;
      input = putStream(input, key, receiver.stream);
    }
  }
  // A caller that cancels the call, also after its result, ends its streams.
  controller.signal.addEventListener(
    "abort",
    () => {
      const reason = abortReason(controller.signal, address);
      receiver?.cancel(reason);
      sender?.cancel(reason);
    },
    { once: true },
  );
  // A call with an input stream has no deadline here; its caller cancels it.
  const timer = armTimer(deadline - Date.now(), () =>
    controller.abort(new RackError("RACK_TIMEOUT", `${address}: deadline passed`)),
  );
  /** Buffers the implementation moves with the result; created when it lists one. */
  let moving: Set<ArrayBuffer> | undefined;
  let sent = false;
  const call: CallContext = {
    signal: controller.signal,
    deadline,
    transfer(...buffers: ArrayBuffer[]) {
      if (sent) {
        throw new RackError("RACK_INVALID_OUTPUT", `${address}: the result was already sent`);
      }
      // Check every buffer first, so a list that throws records none of them.
      for (const buffer of buffers) {
        const reason = untransferable(buffer);
        if (reason !== undefined) {
          throw new RackError("RACK_INVALID_OUTPUT", `${address}: transfer: ${reason}`);
        }
      }
      for (const buffer of buffers) {
        moving ??= new Set();
        moving.add(buffer);
      }
    },
  };
  let result: CallResult;
  /** What the implementation returned, so a result that fails can cancel its streams. */
  let returned: unknown;
  try {
    // Its caller has given up already: the call waited past its deadline.
    if (Date.now() >= deadline) {
      throw new RackError(
        "RACK_TIMEOUT",
        `${address}: the deadline passed before the call started`,
      );
    }
    const spec = state.def.provides[port]?.members[member];
    const impl = impls.get(port)?.get(member);
    if (spec?.kind !== "rpc" || impl === undefined) {
      throw new RackError("RACK_NO_ROUTE", `${address} is not an RPC member`);
    }
    const parsed = await validate(spec.input, input);
    if (!parsed.ok) throw new RackError("RACK_INVALID_INPUT", `${address}: ${parsed.message}`);
    returned = await impl(parsed.value, call);
    const output = await validate(spec.output, returned);
    if (!output.ok) throw new RackError("RACK_INVALID_OUTPUT", `${address}: ${output.message}`);
    returned = output.value;
    const taken = takeStream(output.value, "RACK_INVALID_OUTPUT", address);
    if (taken === undefined) {
      result = { t: "result", id, ok: true, value: output.value };
    } else {
      // A caller that gave the call up gets no stream; its source is cancelled.
      if (controller.signal.aborted) throw abortReason(controller.signal, address);
      sender = new StreamSender(taken.stream, "RACK_INVALID_OUTPUT", {
        idle,
        where: address,
        counters: streamCounters(stats ?? {}),
        onEnd: () => {
          open--;
          // An input stream lasts as long as the output stream that reads it.
          receiver?.cancel(new RackError("RACK_CANCELLED", `${address}: the output stream ended`));
          finishIfDone();
          checkDrains();
        },
      });
      open++;
      const slot: StreamSlot = [taken.key, channel.attach(sender)];
      result = { t: "result", id, ok: true, value: taken.value, stream: slot };
    }
  } catch (error) {
    // A result that fails takes the streams it would have carried.
    cancelStreams(returned, new RackError("RACK_CANCELLED", `${address}: the call failed`));
    result = { t: "result", id, ok: false, error: toWireError(error) };
  } finally {
    clearTimeout(timer);
  }
  sent = true;
  // Only a result that succeeded carries the buffers, and sending it detaches them.
  const transfer = result.ok && moving !== undefined ? [...moving] : undefined;
  try {
    reply(result, transfer);
  } catch {
    // DataCloneError: the provider reports uncloneable output, or a listed buffer that got
    // detached after it was listed.
    result = {
      t: "result",
      id,
      ok: false,
      error: { code: "RACK_INVALID_OUTPUT", message: `${address}: output cannot be cloned` },
    };
    sender?.cancel(new RackError("RACK_CANCELLED", `${address}: the call failed`));
    try {
      reply(result, undefined);
    } catch {
      // The link is closed: its consumer is gone and nobody waits for the result.
    }
  }
  // A failed call does not carry the buffers, yet they are gone all the same.
  if (!result.ok && moving !== undefined) detach([...moving]);
  // An input stream never outlives a result that carries no stream.
  if (!result.ok || result.stream === undefined) {
    receiver?.cancel(
      new RackError(
        "RACK_CANCELLED",
        `${address}: the call returned before it read all of its input`,
      ),
    );
  }
  serving--;
  Atomics.sub(gauge, SHARED_SERVING, 1);
  if (stats !== undefined) {
    stats.timeMs += performance.now() - started;
    if (result.ok) stats.ok++;
    else stats.errors[result.error.code] = (stats.errors[result.error.code] ?? 0) + 1;
  }
  answered = true;
  finishIfDone();
  checkDrains();
}

/** The reason an aborted call's signal carries, as a `RackError`. */
function abortReason(signal: AbortSignal, address: string): RackError {
  const reason: unknown = signal.reason;
  return reason instanceof RackError
    ? reason
    : new RackError("RACK_CANCELLED", `${address}: call cancelled`);
}

// ---- Draining and metrics ----

function drain({ markers: expected, streams }: DrainRequest): Promise<void> {
  return new Promise((resolve) => {
    drains.add({ markers: expected, streams, resolve });
    checkDrains();
  });
}

/**
 * Resolves the drains whose markers arrived, once no call is being served, and once no stream is
 * open for a drain that waits for streams too.
 */
function checkDrains(): void {
  // A drain waits for the requests that the device's listeners are handling, as for calls.
  // @decision .agents/decisions/261118_070617-panels-as-devices.md#when-listeners-listen
  if (drains.size === 0 || serving > 0 || listeners.handling > 0) return;
  let streaming: boolean | undefined;
  for (const entry of [...drains]) {
    if (entry.streams) {
      // A response that still streams counts as an open stream.
      streaming ??= openStreams() > 0 || listeners.pending > 0;
      if (streaming) continue;
    }
    // A link that closed brings no marker, and no call either.
    if (entry.markers.every(([link, token]) => markers.get(link) === token || !hasLink(link))) {
      drains.delete(entry);
      entry.resolve();
    }
  }
}

/** Streams open at this instance, in calls it makes and calls it serves, in both directions. */
function openStreams(): number {
  let count = dataStreams?.open ?? 0;
  for (const link of consumers.values()) count += link.streams.open;
  for (const state of needStates()) {
    for (const link of state.links.values()) count += link.streams.open;
  }
  return count;
}

function hasLink(id: number): boolean {
  if (consumers.has(id)) return true;
  for (const state of needStates()) if (state.links.has(id)) return true;
  return false;
}

/** Every need state with links: the declared needs', and those of every needs' devices. */
function* needStates(): Generator<NeedState> {
  yield* needs.values();
  for (const set of everyNeeds.values()) yield* set.members.values();
}

function snapshot(): InstanceMetrics {
  const provides: Record<string, PortMetrics> = {};
  const needed: Record<string, NeedMetrics> = {};
  const def = booted?.def;
  for (const [port, c] of Object.entries(def?.provides ?? {})) {
    const members: PortMetrics = {};
    for (const member of Object.keys(c.members)) {
      const stats = served.get(port)?.get(member) ?? emitted.get(port)?.get(member);
      if (stats !== undefined) members[member] = stats;
    }
    provides[port] = members;
  }
  for (const [name, state] of needs) {
    const members: NeedMetrics = {};
    const need = declared[name];
    for (const member of Object.keys(need === undefined ? {} : needConnector(need).members)) {
      const stats = state.calls.get(member) ?? state.events.get(member);
      if (stats !== undefined) members[member] = stats;
    }
    needed[name] = members;
  }
  return { since, loop: { ...loop }, provides, needs: needed };
}

// ---- Watchdogs ----

/**
 * Feeds the event-loop watchdog from a timer, which runs only while the event loop does, and
 * measures how late each tick runs. Ticks come at least 8 times per timeout, between 100 ms and
 * 1 s apart, so each of the main thread's checks, 4 per timeout, sees a feed. Without watchdogs
 * the timer still measures the delay, once a second.
 */
function feedLoop(timeout: number): void {
  const interval = timeout > 0 ? Math.min(1_000, Math.max(100, timeout / 8)) : 1_000;
  let expected = performance.now() + interval;
  const tick = () => {
    const now = performance.now();
    const delay = Math.round(Math.max(0, now - expected) * 10) / 10;
    loop.delayMs = delay;
    if (delay > loop.maxDelayMs) loop.maxDelayMs = delay;
    Atomics.add(gauge, SHARED_LOOP, 1);
    expected = now + interval;
    setTimeout(tick, interval);
  };
  setTimeout(tick, interval);
}

/** Arms a device watchdog for `scope.watchdog()`; see {@link ActivateScope.watchdog}. */
function armWatchdog(ms: number, name: string | undefined, cancels: Set<() => void>): Watchdog {
  const index = armed.indexOf(false);
  if (index === -1) {
    throw new RangeError(`at most ${WATCHDOG_LIMIT} watchdogs can be armed at once`);
  }
  armed[index] = true;
  watchdogsArmed++;
  const label = name === undefined ? `watchdog ${watchdogsArmed}` : String(name);
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    armed[index] = false;
    cancels.delete(cancel);
    post({ op: "watchdog", index });
  };
  cancels.add(cancel);
  post({ op: "watchdog", index, armed: { name: label, timeout: ms } });
  return Object.freeze({
    feed() {
      if (!cancelled) Atomics.add(gauge, SHARED_WATCHDOGS + index, 1);
    },
    cancel,
  });
}

// ---- Lifecycle hooks ----

async function runHook(request: HookRequest): Promise<unknown> {
  const state = booted;
  if (state === undefined) throw new RackError("RACK_HOOK_FAILED", "the instance is not booted");
  const { def, ctx } = state;
  switch (request.hook) {
    case "powerOn": {
      listeners.begin(request.listeners ?? []);
      let result: unknown;
      try {
        result = await def.powerOn?.(ctx);
      } catch (error) {
        await listeners.end().catch(() => {
          // powerOn failed already, and its own error is the one the rack reports.
        });
        throw error;
      }
      // A powerOn in which a serve() rejected fails, even if the device caught the rejection.
      // @decision .agents/decisions/261118_070617-panels-as-devices.md#listeners
      await listeners.end();
      impls = checkImpls(state, result);
      return undefined;
    }
    case "selfTest":
      await def.selfTest?.(ctx);
      return undefined;
    case "activate":
      stopScope();
      await def.activate?.(ctx, startScope());
      return undefined;
    case "deactivate":
      stopScope();
      await def.deactivate?.(ctx);
      return undefined;
    case "snapshot":
      return def.snapshot === undefined ? undefined : await def.snapshot(ctx);
    case "restore":
      await def.restore?.(ctx, request.state, request.from ?? "");
      return undefined;
    case "powerOff":
      stopScope();
      try {
        await def.powerOff?.(ctx);
      } finally {
        powered.abort(new RackError("RACK_LINK_DOWN", `${state.name} powered off`));
      }
      return undefined;
    default:
      throw new RackError(
        "RACK_HOOK_FAILED",
        `unknown hook ${String((request as { hook: HookName }).hook)}`,
      );
  }
}

function checkImpls(state: Booted, result: unknown): Map<string, Map<string, Impl>> {
  const checked = new Map<string, Map<string, Impl>>();
  for (const [port, c] of Object.entries(state.def.provides)) {
    const impl = (result as Record<string, Record<string, unknown> | undefined> | undefined)?.[
      port
    ];
    const members = new Map<string, Impl>();
    for (const [member, spec] of Object.entries(c.members)) {
      if (spec.kind !== "rpc") continue;
      const fn = impl?.[member];
      if (typeof fn !== "function") {
        throw new RackError(
          "RACK_HOOK_FAILED",
          `powerOn of ${state.name} returned no implementation for ${port}.${member}`,
        );
      }
      members.set(member, fn.bind(impl) as Impl);
    }
    checked.set(port, members);
  }
  return checked;
}

function startScope(): ActivateScope {
  const controller = new AbortController();
  const cancels = new Set<() => void>();
  scope = { controller, cancels };
  const check = (ms: number) => {
    if (!(typeof ms === "number" && Number.isFinite(ms) && ms >= 0)) {
      throw new RangeError(`timer interval must be a non-negative number, got ${String(ms)}`);
    }
  };
  return Object.freeze({
    signal: controller.signal,
    every(ms: number, task: () => void | Promise<void>) {
      check(ms);
      if (controller.signal.aborted) return () => {};
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stopped = false;
      const run = async () => {
        await guarded("scheduled task", task);
        if (!stopped) timer = setTimeout(run, ms);
      };
      timer = setTimeout(run, ms);
      const cancel = () => {
        stopped = true;
        clearTimeout(timer);
        cancels.delete(cancel);
      };
      cancels.add(cancel);
      return cancel;
    },
    after(ms: number, task: () => void | Promise<void>) {
      check(ms);
      if (controller.signal.aborted) return () => {};
      const timer = setTimeout(() => {
        cancels.delete(cancel);
        void guarded("scheduled task", task);
      }, ms);
      const cancel = () => {
        clearTimeout(timer);
        cancels.delete(cancel);
      };
      cancels.add(cancel);
      return cancel;
    },
    watchdog(ms: number, name?: string): Watchdog {
      if (!(typeof ms === "number" && Number.isFinite(ms) && ms >= WATCHDOG_MIN)) {
        throw new RangeError(
          `a watchdog timeout must be at least ${WATCHDOG_MIN} ms, got ${String(ms)}`,
        );
      }
      if (controller.signal.aborted) return Object.freeze({ feed() {}, cancel() {} });
      return armWatchdog(ms, name, cancels);
    },
  });
}

function stopScope(): void {
  if (scope === undefined) return;
  const { controller, cancels } = scope;
  scope = undefined;
  for (const cancel of [...cancels]) cancel();
  controller.abort(new RackError("RACK_LINK_DOWN", "deactivated"));
}

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
 */
import { type ConnectorInfo, describeConnector, type EventSpec } from "./connector.ts";
import {
  type ActivateScope,
  type CallContext,
  type CallOptions,
  type DeviceContext,
  type DeviceDefinition,
  type DeviceLog,
  type HookName,
  isDevice,
  type LogLevel,
} from "./device.ts";
import { fromWireError, isCloneable, RackError, toWireError } from "./errors.ts";
import type {
  CalledRpcMetrics,
  EmittedEventMetrics,
  InstanceMetrics,
  NeedMetrics,
  PortMetrics,
  ReceivedEventMetrics,
  ServedRpcMetrics,
} from "./metrics.ts";
import {
  type AttachRequest,
  type BootRequest,
  type CallResult,
  type ControlNotice,
  type ControlReply,
  type ControlRequest,
  type DataToWorker,
  type DrainRequest,
  type Fru,
  type HoldEventsRequest,
  type HookRequest,
  type LiveRequest,
  type Marker,
  type NeedDownRequest,
  type NeedHoldRequest,
  type NeedLinkRequest,
  QUEUE_LIMIT,
  type ToConsumer,
  type ToProvider,
} from "./protocol.ts";
import { validate } from "./schema.ts";
import { detach, moveInto, transferList, untransferable } from "./transfer.ts";

// Untyped on purpose: implementations come from device code and are checked at powerOn.
type Impl = (input: unknown, call: CallContext) => unknown;
type EventHandler = (payload: unknown) => void | Promise<void>;
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
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  /** The input until the call goes out on a link. */
  input: unknown;
  /**
   * The buffers the call took from the caller, or the ones it moved into its queued input. They
   * leave with the input; any still attached when the call settles are detached.
   */
  transfer: ArrayBuffer[] | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  cleanup: (() => void) | undefined;
  /** The link the call went out on, and its id there; unset while the call waits. */
  link: NeedLink | undefined;
  id: number;
  queued: boolean;
  settled: boolean;
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
  /** Event handlers by event name; a name is present while it has handlers. */
  readonly handlers: Map<string, Set<{ handler: EventHandler }>>;
  readonly calls: Map<string, CalledRpcMetrics>;
  readonly events: Map<string, ReceivedEventMetrics>;
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
}

interface QueuedEvent {
  port: string;
  event: string;
  payload: unknown;
}

let booted: Booted | undefined;
let impls = new Map<string, Map<string, Impl>>();
let scope: { controller: AbortController; cancels: Set<() => void> } | undefined;
const powered = new AbortController();
let callTimeout = 30_000;
/** Shared with the main thread, which reads the number of calls being served from it. */
let gauge: Int32Array<ArrayBufferLike> = new Int32Array(1);
/** Whether this instance is the one installed in its slot; only then do its events go out. */
let installed = false;
let since = Date.now();
/** Calls being served, from links and from outside the rack. */
let serving = 0;
/** Calls from outside the rack being served, by backplane call id. */
const external = new Map<number, AbortController>();
const needs = new Map<string, NeedState>();
const consumers = new Map<number, ConsumerLink>();
/** Events waiting for held consumer devices, by device name. */
const heldEvents = new Map<string, QueuedEvent[]>();
/** The token of the last hold marker each link brought. */
const markers = new Map<number, number>();
const drains = new Set<{ markers: Marker[]; resolve: () => void }>();
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

// ---- Control channel ----

addEventListener("message", (event: MessageEvent<ControlRequest>) => {
  void control(event.data);
});

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
    case "attach":
      return attach(request);
    case "holdEvents":
      return holdEvents(request);
    case "live":
      return live(request);
    case "drop":
      return drop(request.link);
    case "installed":
      installed = request.installed;
      return undefined;
    case "drain":
      return drain(request);
    case "metrics":
      return snapshot();
  }
}

async function boot(request: BootRequest): Promise<Fru> {
  if (booted !== undefined) throw new RackError("RACK_MANIFEST", "the instance is already booted");
  const module = (await import(request.firmware)) as { default?: unknown };
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
  callTimeout = request.callTimeout;
  gauge = new Int32Array(request.gauge);
  since = Date.now();
  prepare(def);
  const ctx = makeContext(def, { name, u: request.u, config, request });
  booted = { def, ctx, name };
  const data = request.port;
  data.addEventListener("message", (event) =>
    onData(data, (event as MessageEvent<DataToWorker>).data),
  );
  data.start();
  return {
    model: def.model,
    name,
    height: def.height,
    needs: describeAll(def.needs),
    provides: describeAll(def.provides),
    snapshot: def.snapshot !== undefined,
    restore: def.restore !== undefined,
  };
}

function describeAll(ports: DeviceDefinition["needs"]): Record<string, ConnectorInfo> {
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
  for (const [name, c] of Object.entries(def.needs)) {
    const state: NeedState = {
      name,
      current: undefined,
      links: new Map(),
      held: false,
      queue: [],
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
  for (const [name, c] of Object.entries(def.needs)) {
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
    config: input.config,
    log: Object.freeze(logger),
    signal: powered.signal,
    slot: Object.freeze({ name: input.name, u: input.u }),
    firmware: input.request.hash,
    baseDir: input.request.baseDir,
  }) as DeviceContext;
}

function need(name: string): NeedState {
  const state = needs.get(name);
  if (state === undefined) throw new RackError("RACK_NO_ROUTE", `the device has no need ${name}`);
  return state;
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
    const { timeout, signal, transfer } = options;
    const valid = timeout === undefined || (typeof timeout === "number" && timeout >= 0);
    const ms = valid && timeout !== undefined ? timeout : callTimeout;
    const call: Outgoing = {
      need: state,
      member,
      stats,
      started: performance.now(),
      deadline: Date.now() + ms,
      resolve,
      reject,
      input,
      transfer: undefined,
      timer: undefined,
      cleanup: undefined,
      link: undefined,
      id: 0,
      queued: false,
      settled: false,
    };
    stats.calls++;
    stats.pending++;
    try {
      // From here on the call owns the buffers, so they are gone whatever its outcome.
      call.transfer = transferList(transfer, where);
    } catch (error) {
      settle(call, { ok: false, error: error as RackError });
      return;
    }
    if (!valid) {
      settle(call, failure("RACK_INVALID_INPUT", `${where}: timeout must be >= 0 ms`));
      return;
    }
    if (signal?.aborted) {
      settle(call, failure("RACK_CANCELLED", `${where}: call cancelled`));
      return;
    }
    // The caller's host owns the timeout of a call on a link.
    // @decision .agents/decisions/261116_024226-backplane-links.md#rpc
    call.timer = setTimeout(() => {
      const target = call.link?.provider ?? state.name;
      cancelAtProvider(call);
      settle(call, failure("RACK_TIMEOUT", `${target}.${member} timed out after ${ms} ms`));
    }, ms);
    if (signal !== undefined) {
      const onAbort = () => {
        cancelAtProvider(call);
        settle(call, failure("RACK_CANCELLED", `${where}: call cancelled`));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      call.cleanup = () => signal.removeEventListener("abort", onAbort);
    }
    if (state.held) enqueue(state, call);
    else send(state, call);
  });
}

/** Keeps a call until its need is released. */
function enqueue(state: NeedState, call: Outgoing): void {
  const where = `${state.name}.${call.member}`;
  if (state.queue.length >= QUEUE_LIMIT) {
    settle(call, failure("RACK_LINK_DOWN", `${where}: the provider is held and the queue is full`));
    return;
  }
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
  const message = {
    t: "call",
    id,
    member: call.member,
    input: call.input,
    deadline: call.deadline,
  } satisfies ToProvider;
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

function cancelAtProvider(call: Outgoing): void {
  if (call.settled || call.link === undefined) return;
  call.link.port.postMessage({ t: "cancel", id: call.id } satisfies ToProvider);
}

/** Finishes a call once: stops its timer, counts it, and resolves or rejects it. */
function settle(call: Outgoing, outcome: Outcome): void {
  if (call.settled) return;
  call.settled = true;
  clearTimeout(call.timer);
  call.cleanup?.();
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
  stats.pending--;
  stats.timeMs += performance.now() - call.started;
  if (outcome.ok) {
    stats.ok++;
    call.resolve(outcome.value);
    return;
  }
  const { code } = outcome.error;
  stats.errors[code] = (stats.errors[code] ?? 0) + 1;
  call.reject(outcome.error);
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
  const link: NeedLink = { id, port: end, provider, pending: new Map(), nextId: 1 };
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
  for (const call of [...link.pending.values()]) {
    settle(call, { ok: false, error: fromWireError(error) });
  }
  link.port.close();
  markers.delete(id);
  checkDrains();
}

function onNeedLink(state: NeedState, link: NeedLink, message: ToConsumer): void {
  switch (message.t) {
    case "result": {
      const call = link.pending.get(message.id);
      if (call === undefined) return;
      settle(
        call,
        message.ok
          ? { ok: true, value: message.value }
          : { ok: false, error: fromWireError(message.error) },
      );
      return;
    }
    case "event":
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
  for (const { handler } of [...set]) {
    void guarded(`event handler for ${state.name}.${event}`, () => handler(payload));
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
      if (queue.length >= QUEUE_LIMIT) {
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
    try {
      link.port.postMessage({ t: "event", event, payload: value } satisfies ToConsumer);
    } catch {
      // DataCloneError: the payload passed validation but cannot cross threads.
      throw uncloneable();
    }
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
        message.id,
        link.portName,
        message.member,
        message.input,
        message.deadline,
        link.serving,
        (reply, transfer) =>
          transfer === undefined
            ? link.port.postMessage(reply)
            : link.port.postMessage(reply, transfer),
      );
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
      }
    }
  }
}

function drop(id: number): void {
  const link = consumers.get(id);
  if (link === undefined) return;
  consumers.delete(id);
  for (const controller of link.serving.values()) {
    controller.abort(new RackError("RACK_CANCELLED", "call cancelled"));
  }
  link.port.close();
  markers.delete(id);
  checkDrains();
}

// ---- Calls the device serves ----

function onData(data: MessagePort, message: DataToWorker): void {
  if (message.t === "call") {
    void serve(
      message.id,
      message.port,
      message.member,
      message.input,
      message.deadline,
      external,
      (reply, transfer) =>
        transfer === undefined ? data.postMessage(reply) : data.postMessage(reply, transfer),
    );
  } else {
    external.get(message.id)?.abort(new RackError("RACK_CANCELLED", "call cancelled"));
  }
}

async function serve(
  id: number,
  port: string,
  member: string,
  input: unknown,
  deadline: number,
  registry: Map<number, AbortController>,
  reply: (result: CallResult, transfer: ArrayBuffer[] | undefined) => void,
): Promise<void> {
  const state = booted;
  if (state === undefined) return;
  const address = `${state.name}.${port}.${member}`;
  const stats = served.get(port)?.get(member);
  const started = performance.now();
  const controller = new AbortController();
  registry.set(id, controller);
  serving++;
  Atomics.add(gauge, 0, 1);
  if (stats !== undefined) {
    stats.calls++;
    stats.active++;
  }
  const timer = setTimeout(
    () => controller.abort(new RackError("RACK_TIMEOUT", `${address}: deadline passed`)),
    Math.max(0, deadline - Date.now()),
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
  try {
    const spec = state.def.provides[port]?.members[member];
    const impl = impls.get(port)?.get(member);
    if (spec?.kind !== "rpc" || impl === undefined) {
      throw new RackError("RACK_NO_ROUTE", `${address} is not an RPC member`);
    }
    const parsed = await validate(spec.input, input);
    if (!parsed.ok) throw new RackError("RACK_INVALID_INPUT", `${address}: ${parsed.message}`);
    const value = await impl(parsed.value, call);
    const output = await validate(spec.output, value);
    if (!output.ok) throw new RackError("RACK_INVALID_OUTPUT", `${address}: ${output.message}`);
    result = { t: "result", id, ok: true, value: output.value };
  } catch (error) {
    result = { t: "result", id, ok: false, error: toWireError(error) };
  } finally {
    clearTimeout(timer);
    registry.delete(id);
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
    try {
      reply(result, undefined);
    } catch {
      // The link is closed: its consumer is gone and nobody waits for the result.
    }
  }
  // A failed call does not carry the buffers, yet they are gone all the same.
  if (!result.ok && moving !== undefined) detach([...moving]);
  serving--;
  Atomics.sub(gauge, 0, 1);
  if (stats !== undefined) {
    stats.active--;
    stats.timeMs += performance.now() - started;
    if (result.ok) stats.ok++;
    else stats.errors[result.error.code] = (stats.errors[result.error.code] ?? 0) + 1;
  }
  checkDrains();
}

// ---- Draining and metrics ----

function drain({ markers: expected }: DrainRequest): Promise<void> {
  return new Promise((resolve) => {
    drains.add({ markers: expected, resolve });
    checkDrains();
  });
}

/** Resolves the drains whose markers arrived, once no call is being served. */
function checkDrains(): void {
  if (drains.size === 0 || serving > 0) return;
  for (const entry of [...drains]) {
    // A link that closed brings no marker, and no call either.
    if (entry.markers.every(([link, token]) => markers.get(link) === token || !hasLink(link))) {
      drains.delete(entry);
      entry.resolve();
    }
  }
}

function hasLink(id: number): boolean {
  if (consumers.has(id)) return true;
  for (const state of needs.values()) if (state.links.has(id)) return true;
  return false;
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
    for (const member of Object.keys(def?.needs[name]?.members ?? {})) {
      const stats = state.calls.get(member) ?? state.events.get(member);
      if (stats !== undefined) members[member] = stats;
    }
    needed[name] = members;
  }
  return { since, provides, needs: needed };
}

// ---- Lifecycle hooks ----

async function runHook(request: HookRequest): Promise<unknown> {
  const state = booted;
  if (state === undefined) throw new RackError("RACK_HOOK_FAILED", "the instance is not booted");
  const { def, ctx } = state;
  switch (request.hook) {
    case "powerOn":
      impls = checkImpls(state, await def.powerOn?.(ctx));
      return undefined;
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
  });
}

function stopScope(): void {
  if (scope === undefined) return;
  const { controller, cancels } = scope;
  scope = undefined;
  for (const cancel of [...cancels]) cancel();
  controller.abort(new RackError("RACK_LINK_DOWN", "deactivated"));
}

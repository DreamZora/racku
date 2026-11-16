/**
 * Worker host for one `sled` device instance.
 *
 * The rack main thread starts this module in a fresh Worker and boots it with a firmware URL.
 * The host loads the firmware, reports FRU data, runs lifecycle hooks on request, and serves
 * the data channel: it validates RPC input and output for the ports the device provides, sends
 * calls for its needs, and validates the payloads it publishes.
 *
 * @decision .agents/decisions/261112_043035-backplane-protocol.md#channels
 * @decision .agents/decisions/261112_043035-backplane-protocol.md#boot-and-fru
 * @decision .agents/decisions/261112_043035-backplane-protocol.md#where-validation-happens
 * @decision .agents/decisions/261112_043034-device-api.md#device-context
 */
import { type ConnectorInfo, describeConnector, type EventSpec } from "./connector.ts";
import {
  type ActivateScope,
  type DeviceContext,
  type DeviceDefinition,
  type DeviceLog,
  type HookName,
  isDevice,
  type LogLevel,
} from "./device.ts";
import { fromWireError, RackError, toWireError, type WireError } from "./errors.ts";
import type {
  BootRequest,
  CallFromCaller,
  CallResult,
  CallToProvider,
  ControlNotice,
  ControlReply,
  ControlRequest,
  DataFromWorker,
  DataToWorker,
  Fru,
  HookRequest,
} from "./protocol.ts";
import { validate } from "./schema.ts";

// Untyped on purpose: implementations come from device code and are checked at powerOn.
type Impl = (input: unknown, call: { signal: AbortSignal; deadline: number }) => unknown;
type EventHandler = (payload: unknown) => void | Promise<void>;

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  cleanup(): void;
}

interface Booted {
  def: DeviceDefinition;
  ctx: DeviceContext;
  data: MessagePort;
  name: string;
}

let booted: Booted | undefined;
let impls = new Map<string, Map<string, Impl>>();
let scope: { controller: AbortController; cancels: Set<() => void> } | undefined;
const powered = new AbortController();
const pending = new Map<number, Pending>();
const serving = new Map<number, AbortController>();
const handlers = new Map<string, Set<{ handler: EventHandler }>>();
let nextCallId = 1;

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

addEventListener("message", (event: MessageEvent<ControlRequest>) => {
  void control(event.data);
});

async function control(request: ControlRequest): Promise<void> {
  let reply: ControlReply;
  try {
    const value = request.op === "boot" ? await boot(request) : await runHook(request);
    reply = { id: request.id, ok: true, value };
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
  const data = request.port;
  const ctx = makeContext(def, data, { name, u: request.u, config, request });
  booted = { def, ctx, data, name };
  data.addEventListener("message", (event) => onData((event as MessageEvent<DataToWorker>).data));
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

interface ContextInput {
  name: string;
  u: number;
  config: unknown;
  request: BootRequest;
}

function makeContext(def: DeviceDefinition, data: MessagePort, input: ContextInput): DeviceContext {
  const ports: Record<string, Record<string, unknown>> = {};
  const on: Record<string, Record<string, unknown>> = {};
  const emit: Record<string, Record<string, unknown>> = {};
  for (const [need, c] of Object.entries(def.needs)) {
    const client: Record<string, unknown> = {};
    const events: Record<string, unknown> = {};
    for (const [member, spec] of Object.entries(c.members)) {
      if (spec.kind === "rpc") {
        client[member] = (value: unknown, options?: { timeout?: number; signal?: AbortSignal }) =>
          callOut(data, need, member, value, options);
      } else {
        events[member] = (handler: EventHandler) => subscribe(data, need, member, handler);
      }
    }
    ports[need] = Object.freeze(client);
    on[need] = Object.freeze(events);
  }
  for (const [port, c] of Object.entries(def.provides)) {
    const emitters: Record<string, unknown> = {};
    for (const [member, spec] of Object.entries(c.members)) {
      if (spec.kind === "event") {
        emitters[member] = (payload: unknown) =>
          emitOut(data, `${input.name}.${port}.${member}`, port, member, spec, payload);
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

function callOut(
  data: MessagePort,
  need: string,
  member: string,
  input: unknown,
  options: { timeout?: number; signal?: AbortSignal } = {},
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const { timeout, signal } = options;
    if (timeout !== undefined && !(typeof timeout === "number" && timeout >= 0)) {
      reject(new RackError("RACK_INVALID_INPUT", `${need}.${member}: timeout must be >= 0 ms`));
      return;
    }
    if (signal?.aborted) {
      reject(new RackError("RACK_CANCELLED", `${need}.${member}: call cancelled`));
      return;
    }
    const id = nextCallId++;
    const message: CallFromCaller = { t: "call", id, need, member, input, timeout };
    try {
      data.postMessage(message satisfies DataFromWorker);
    } catch {
      // DataCloneError: the caller reports uncloneable input locally.
      reject(new RackError("RACK_INVALID_INPUT", `${need}.${member}: input cannot be cloned`));
      return;
    }
    const onAbort = () => {
      pending.delete(id);
      data.postMessage({ t: "cancel", id } satisfies DataFromWorker);
      reject(new RackError("RACK_CANCELLED", `${need}.${member}: call cancelled`));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    pending.set(id, {
      resolve,
      reject,
      cleanup: () => signal?.removeEventListener("abort", onAbort),
    });
  });
}

function subscribe(
  data: MessagePort,
  need: string,
  event: string,
  handler: EventHandler,
): () => void {
  if (typeof handler !== "function") {
    throw new RackError("RACK_INVALID_INPUT", `${need}.${event}: the handler must be a function`);
  }
  const key = `${need}.${event}`;
  let set = handlers.get(key);
  if (set === undefined) {
    set = new Set();
    handlers.set(key, set);
    data.postMessage({ t: "sub", need, event } satisfies DataFromWorker);
  }
  const entry = { handler };
  const own = set;
  own.add(entry);
  return () => {
    if (!own.delete(entry) || own.size > 0 || handlers.get(key) !== own) return;
    handlers.delete(key);
    data.postMessage({ t: "unsub", need, event } satisfies DataFromWorker);
  };
}

async function emitOut(
  data: MessagePort,
  where: string,
  port: string,
  event: string,
  spec: EventSpec,
  payload: unknown,
): Promise<void> {
  const result = await validate(spec.payload, payload);
  // An event payload is output of the publishing device.
  // @decision .agents/decisions/261115_222025-p0-api-details.md#device-hooks
  if (!result.ok) throw new RackError("RACK_INVALID_OUTPUT", `${where}: ${result.message}`);
  try {
    data.postMessage({ t: "emit", port, event, payload: result.value } satisfies DataFromWorker);
  } catch {
    // DataCloneError: the payload passed validation but cannot cross threads.
    throw new RackError("RACK_INVALID_OUTPUT", `${where}: payload cannot be cloned`);
  }
}

function onData(message: DataToWorker): void {
  switch (message.t) {
    case "call":
      void serve(message);
      return;
    case "cancel":
      serving.get(message.id)?.abort(new RackError("RACK_CANCELLED", "call cancelled"));
      return;
    case "result":
      settle(message);
      return;
    case "event":
      deliver(message.need, message.event, message.payload);
      return;
  }
}

function settle(message: CallResult): void {
  const call = pending.get(message.id);
  if (call === undefined) return;
  pending.delete(message.id);
  call.cleanup();
  if (message.ok) call.resolve(message.value);
  else call.reject(fromWireError(message.error));
}

function deliver(need: string, event: string, payload: unknown): void {
  const set = handlers.get(`${need}.${event}`);
  if (set === undefined) return;
  for (const { handler } of [...set])
    void guarded(`event handler for ${need}.${event}`, () => handler(payload));
}

async function serve(message: CallToProvider): Promise<void> {
  const state = booted;
  if (state === undefined) return;
  const address = `${state.name}.${message.port}.${message.member}`;
  const controller = new AbortController();
  serving.set(message.id, controller);
  const timer = setTimeout(
    () => controller.abort(new RackError("RACK_TIMEOUT", `${address}: deadline passed`)),
    Math.max(0, message.deadline - Date.now()),
  );
  let reply: CallResult;
  try {
    const spec = state.def.provides[message.port]?.members[message.member];
    const impl = impls.get(message.port)?.get(message.member);
    if (spec?.kind !== "rpc" || impl === undefined) {
      throw new RackError("RACK_NO_ROUTE", `${address} is not an RPC member`);
    }
    const input = await validate(spec.input, message.input);
    if (!input.ok) throw new RackError("RACK_INVALID_INPUT", `${address}: ${input.message}`);
    const value = await impl(input.value, {
      signal: controller.signal,
      deadline: message.deadline,
    });
    const output = await validate(spec.output, value);
    if (!output.ok) throw new RackError("RACK_INVALID_OUTPUT", `${address}: ${output.message}`);
    reply = { t: "result", id: message.id, ok: true, value: output.value };
  } catch (error) {
    reply = { t: "result", id: message.id, ok: false, error: toWireError(error) };
  } finally {
    clearTimeout(timer);
    serving.delete(message.id);
  }
  try {
    state.data.postMessage(reply satisfies DataFromWorker);
  } catch {
    // DataCloneError: the provider reports uncloneable output.
    const error: WireError = {
      code: "RACK_INVALID_OUTPUT",
      message: `${address}: output cannot be cloned`,
    };
    state.data.postMessage({
      t: "result",
      id: message.id,
      ok: false,
      error,
    } satisfies DataFromWorker);
  }
}

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

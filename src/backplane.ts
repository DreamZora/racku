/**
 * The backplane: routes calls, results, cancellations, and events between device instances,
 * and holds calls and events for paused slots. It never validates payloads; providers and
 * publishers do that in their own Workers.
 *
 * @decision .agents/decisions/261112_043035-backplane-protocol.md#wiring-and-routing
 * @decision .agents/decisions/261112_043035-backplane-protocol.md#rpc
 * @decision .agents/decisions/261112_043035-backplane-protocol.md#events
 * @decision .agents/decisions/261112_043035-backplane-protocol.md#in-flight-calls-pausing-and-draining
 */
import type { CallOptions } from "./device.ts";
import { fromWireError, RackError, type WireError } from "./errors.ts";
import type { Firmware } from "./firmware.ts";
import type { Instance, RoutedCall, Wire } from "./instance.ts";
import { parseAddress } from "./manifest.ts";
import type { CallFromCaller, CallResult, DataFromWorker, Emit, Fru } from "./protocol.ts";

/** Lifecycle state of a slot as reported by `status()`. */
export type SlotState = "online" | "swapping" | "degraded" | "resetting" | "faulted";

type Outcome = { ok: true; value: unknown } | { ok: false; error: WireError };

interface Call extends RoutedCall {
  readonly provider: string;
  readonly port: string;
  readonly member: string;
  readonly input: unknown;
  readonly deadline: number;
  readonly caller: string;
  readonly deliver: (outcome: Outcome) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  target: Instance | undefined;
  queuedIn: Slot | undefined;
  cleanup: (() => void) | undefined;
}

type Queued =
  | { kind: "call"; call: Call }
  | { kind: "event"; need: string; event: string; payload: unknown };

/** One occupied slot of the rack. */
export interface Slot {
  name: string;
  u: number;
  height: number;
  model: string;
  /** Absolute path of the device file. */
  source: string;
  config: unknown;
  /** Firmware of the installed instance, or of the last one when none is installed. */
  firmware: Firmware;
  /** FRU data of the installed instance, or of the last one. */
  fru: Fru;
  /** Wiring of the device's needs; unchanged across swaps except for new needs. */
  wiring: Map<string, Wire>;
  installed: Instance | null;
  state: SlotState;
  /** A swap or a reset is running. */
  busy: boolean;
  paused: boolean;
  queue: Queued[];
  /** Crash timestamps, pruned to the last 60 seconds when read. */
  crashes: number[];
  error: WireError | undefined;
  /** Unplugged or powered off by `stop()`; calls fail with `RACK_LINK_DOWN`. */
  removed: boolean;
}

/** Most calls and events a paused slot holds. */
export const QUEUE_LIMIT = 10_000;

/** Routes data-bus traffic between the instances installed in slots. */
export class Backplane {
  readonly #slots: ReadonlyMap<string, Slot>;
  readonly #callTimeout: number;
  readonly #warn: (message: string, device?: string) => void;
  #nextId = 1;

  /**
   * @param slots The rack's slots, keyed by device name; read on every call.
   * @param callTimeout Timeout for calls that set none.
   * @param warn Writes a warning to the management bus.
   */
  constructor(
    slots: ReadonlyMap<string, Slot>,
    callTimeout: number,
    warn: (message: string, device?: string) => void,
  ) {
    this.#slots = slots;
    this.#callTimeout = callTimeout;
    this.#warn = warn;
  }

  /** Handles one data-channel message from an instance. */
  onData(instance: Instance, message: DataFromWorker): void {
    switch (message.t) {
      case "call":
        this.#fromCaller(instance, message);
        return;
      case "cancel": {
        const call = instance.outgoing.get(message.id) as Call | undefined;
        instance.outgoing.delete(message.id);
        // The caller already rejected the call locally; only the provider needs to know.
        if (call !== undefined) this.#finish(call, undefined, true);
        return;
      }
      case "result":
        this.#fromProvider(instance, message);
        return;
      case "emit":
        this.#emit(instance, message);
        return;
      case "sub":
        instance.subscriptions.add(`${message.need}.${message.event}`);
        return;
      case "unsub":
        instance.subscriptions.delete(`${message.need}.${message.event}`);
        return;
    }
  }

  /**
   * Calls a port from outside the rack, addressing `<device>.<port>` directly.
   *
   * @throws RackError `RACK_NO_ROUTE`, `RACK_TIMEOUT`, `RACK_CANCELLED`, `RACK_LINK_DOWN`, or
   *   whatever the provider returns.
   */
  call(
    address: string,
    method: string,
    input: unknown,
    options: CallOptions,
    caller: string,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let device: string;
      let port: string;
      try {
        ({ device, port } = parseAddress(address));
      } catch {
        reject(new RackError("RACK_NO_ROUTE", `"${address}" is not a <device>.<port> address`));
        return;
      }
      const slot = this.#slots.get(device);
      const info = slot?.removed ? undefined : slot?.fru.provides[port];
      if (info === undefined) {
        reject(new RackError("RACK_NO_ROUTE", `${address} does not exist`));
        return;
      }
      if (info.members[method] !== "rpc") {
        reject(new RackError("RACK_NO_ROUTE", `${address} has no RPC member ${method}`));
        return;
      }
      const { timeout, signal } = options;
      if (timeout !== undefined && !(typeof timeout === "number" && timeout >= 0)) {
        reject(
          new RackError("RACK_INVALID_INPUT", `${address}.${method}: timeout must be >= 0 ms`),
        );
        return;
      }
      if (signal?.aborted) {
        reject(new RackError("RACK_CANCELLED", `${address}.${method}: call cancelled`));
        return;
      }
      const call = this.#create(device, port, method, input, timeout, caller, (outcome) =>
        outcome.ok ? resolve(outcome.value) : reject(fromWireError(outcome.error)),
      );
      if (signal !== undefined) {
        const onAbort = () =>
          this.#finish(
            call,
            failure("RACK_CANCELLED", `${address}.${method}: call cancelled`),
            true,
          );
        signal.addEventListener("abort", onAbort, { once: true });
        call.cleanup = () => signal.removeEventListener("abort", onAbort);
      }
      this.#dispatch(call);
    });
  }

  /** Holds calls and events addressed to the slot until {@link resume}. */
  pause(slot: Slot): void {
    slot.paused = true;
  }

  /** Hands held calls and events, in order, to whatever instance is installed now. */
  resume(slot: Slot): void {
    slot.paused = false;
    const queue = slot.queue;
    slot.queue = [];
    for (const item of queue) {
      if (item.kind === "call") {
        item.call.queuedIn = undefined;
        this.#dispatch(item.call);
      } else {
        this.#deliver(slot, item.need, item.event, item.payload);
      }
    }
  }

  /** Fails every call the instance is processing as a provider. */
  failInFlight(instance: Instance, code: string, message: string): void {
    for (const call of instance.inFlight.values()) {
      this.#finish(call as Call, failure(code, message), false);
    }
    instance.inFlight.clear();
    instance.checkDrained();
  }

  /** Drops the calls an exited instance made, cancelling them at their providers. */
  releaseCaller(instance: Instance): void {
    for (const call of instance.outgoing.values()) this.#finish(call as Call, undefined, true);
    instance.outgoing.clear();
    instance.subscriptions.clear();
  }

  #fromCaller(caller: Instance, message: CallFromCaller): void {
    const wire = caller.wiring.get(message.need);
    if (wire === undefined) {
      const error = {
        code: "RACK_NO_ROUTE",
        message: `${caller.slot}.${message.need} is not wired`,
      };
      caller.post({ t: "result", id: message.id, ok: false, error });
      return;
    }
    const call = this.#create(
      wire.provider,
      wire.port,
      message.member,
      message.input,
      message.timeout,
      caller.slot,
      (outcome) => {
        caller.outgoing.delete(message.id);
        caller.post({ t: "result", id: message.id, ...outcome });
      },
    );
    caller.outgoing.set(message.id, call);
    this.#dispatch(call);
  }

  #fromProvider(provider: Instance, message: CallResult): void {
    const call = provider.inFlight.get(message.id) as Call | undefined;
    if (call === undefined) return;
    provider.inFlight.delete(message.id);
    this.#finish(
      call,
      message.ok ? { ok: true, value: message.value } : { ok: false, error: message.error },
      false,
    );
    provider.checkDrained();
  }

  #create(
    provider: string,
    port: string,
    member: string,
    input: unknown,
    timeout: number | undefined,
    caller: string,
    deliver: (outcome: Outcome) => void,
  ): Call {
    const ms = timeout ?? this.#callTimeout;
    const call: Call = {
      id: this.#nextId++,
      settled: false,
      provider,
      port,
      member,
      input,
      deadline: Date.now() + ms,
      caller,
      deliver,
      timer: undefined,
      target: undefined,
      queuedIn: undefined,
      cleanup: undefined,
    };
    // The backplane owns the timeout: it fails the call and cancels it at the provider.
    // @decision .agents/decisions/261112_043035-backplane-protocol.md#rpc
    call.timer = setTimeout(() => {
      const where = `${provider}.${port}.${member}`;
      this.#finish(call, failure("RACK_TIMEOUT", `${where} timed out after ${ms} ms`), true);
    }, ms);
    return call;
  }

  #dispatch(call: Call): void {
    if (call.settled) return;
    const slot = this.#slots.get(call.provider);
    if (slot === undefined || slot.removed) {
      this.#finish(call, failure("RACK_LINK_DOWN", `${call.provider} is not in the rack`), false);
      return;
    }
    if (slot.paused) {
      if (slot.queue.length >= QUEUE_LIMIT) {
        const message = `${slot.name} is paused and its queue is full`;
        this.#finish(call, failure("RACK_LINK_DOWN", message), false);
        return;
      }
      slot.queue.push({ kind: "call", call });
      call.queuedIn = slot;
      return;
    }
    const target = slot.installed;
    if (target === null || target.dead) {
      this.#finish(call, failure("RACK_LINK_DOWN", `${slot.name} is ${slot.state}`), false);
      return;
    }
    try {
      target.post({
        t: "call",
        id: call.id,
        port: call.port,
        member: call.member,
        input: call.input,
        deadline: call.deadline,
        caller: call.caller,
      });
    } catch {
      // DataCloneError: input from outside the rack has not crossed a thread yet.
      const where = `${call.provider}.${call.port}.${call.member}`;
      this.#finish(call, failure("RACK_INVALID_INPUT", `${where}: input cannot be cloned`), false);
      return;
    }
    call.target = target;
    target.inFlight.set(call.id, call);
  }

  /**
   * Settles a call once. A call stays in its provider's in-flight set until the provider
   * answers, so draining still waits for work the provider has not finished.
   */
  #finish(call: Call, outcome: Outcome | undefined, cancelProvider: boolean): void {
    if (call.settled) return;
    call.settled = true;
    clearTimeout(call.timer);
    call.cleanup?.();
    if (call.queuedIn !== undefined) {
      const queue = call.queuedIn.queue;
      const index = queue.findIndex((item) => item.kind === "call" && item.call === call);
      if (index >= 0) queue.splice(index, 1);
      call.queuedIn = undefined;
    }
    if (cancelProvider && call.target?.inFlight.has(call.id)) {
      call.target.post({ t: "cancel", id: call.id });
    }
    if (outcome !== undefined) call.deliver(outcome);
  }

  #emit(publisher: Instance, message: Emit): void {
    const slot = this.#slots.get(publisher.slot);
    if (slot === undefined || slot.installed !== publisher) {
      const what = `${message.port}.${message.event}`;
      this.#warn(`dropped event ${what} from an instance that is not installed`, publisher.slot);
      return;
    }
    for (const consumer of this.#slots.values()) {
      for (const [need, wire] of consumer.wiring) {
        if (wire.provider === slot.name && wire.port === message.port) {
          this.#deliver(consumer, need, message.event, message.payload);
        }
      }
    }
  }

  #deliver(consumer: Slot, need: string, event: string, payload: unknown): void {
    if (consumer.removed) return;
    if (consumer.paused) {
      // Delivery is at most once: past the limit, new events are dropped.
      if (consumer.queue.length < QUEUE_LIMIT) {
        consumer.queue.push({ kind: "event", need, event, payload });
      }
      return;
    }
    const target = consumer.installed;
    if (target === null || target.dead || !target.subscriptions.has(`${need}.${event}`)) return;
    target.post({ t: "event", need, event, payload });
  }
}

function failure(code: string, message: string): Outcome {
  return { ok: false, error: { code, message } };
}

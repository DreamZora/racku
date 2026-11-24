/**
 * The backplane: decides which links connect device instances and keeps them pointed at the
 * installed instances through swaps, holds, resets, and exits. Calls, results, and events
 * between devices travel on those links, so the backplane never sees them. It also routes each
 * call from outside the rack to the installed instance, and holds those calls for held slots. It
 * never validates payloads; providers and publishers do that in their own Workers.
 *
 * @decision .agents/decisions/261116_024226-backplane-links.md#links
 * @decision .agents/decisions/261116_024226-backplane-links.md#wiring-and-routing
 * @decision .agents/decisions/261116_024226-backplane-links.md#rpc
 * @decision .agents/decisions/261116_024226-backplane-links.md#in-flight-calls-holding-and-draining
 * @decision .agents/decisions/261116_024226-backplane-links.md#faults-and-resets
 * @decision .agents/decisions/261116_213839-transfer-and-shared-buffers.md#transfer
 * @decision .agents/decisions/261117_063228-bounded-backlogs.md#bounded-calls
 * @decision .agents/decisions/261117_185225-outside-call-metrics.md#decision
 * @decision .agents/decisions/261118_071155-backplane-streams.md#streams-in-calls
 * @decision .agents/decisions/261118_071155-backplane-streams.md#timeouts
 * @decision .agents/decisions/261118_071155-backplane-streams.md#observation
 */
import type { CallOptions } from "./device.ts";
import { fromWireError, RackError, type WireError } from "./errors.ts";
import type { Firmware } from "./firmware.ts";
import type { Instance, RoutedCall, Wire } from "./instance.ts";
import { parseAddress } from "./manifest.ts";
import type { CalledRpcMetrics, OutsideMetrics, StreamMetrics } from "./metrics.ts";
import type {
  CallResult,
  CallToProvider,
  DataFromWorker,
  Fru,
  Marker,
  MemberInfo,
} from "./protocol.ts";
import type { SlotState } from "./reports.ts";
import {
  armTimer,
  cancelStreams,
  putStream,
  StreamChannel,
  type StreamReceiver,
  StreamSender,
  takeStream,
} from "./streams.ts";
import { detach, moveInto, transferList } from "./transfer.ts";

export type { SlotState } from "./reports.ts";

type Outcome = { ok: true; value: unknown } | { ok: false; error: WireError };

/** A call from outside the rack. */
interface Call extends RoutedCall {
  readonly provider: string;
  readonly port: string;
  readonly member: string;
  input: unknown;
  /**
   * The buffers the call took from the caller, or the ones it moved into its queued input. They
   * leave with the input; any still attached when the call settles are detached.
   */
  transfer: ArrayBuffer[] | undefined;
  readonly deadline: number;
  readonly caller: string;
  readonly deliver: (outcome: Outcome) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  target: Instance | undefined;
  queuedIn: Slot | undefined;
  /** The slot whose count of unfinished calls includes this call, until it finishes. */
  counted: Slot | undefined;
  /** The counters of the call's port and member; see `Backplane.outside`. */
  counter: CalledRpcMetrics | undefined;
  /** When the call was made, by `performance.now()`. */
  started: number;
  cleanup: (() => void) | undefined;
  /** The call's timeout in ms; for a call with an input stream, it runs from that stream's end. */
  readonly ms: number;
  /** Idle timeout of the call's streams, in ms. */
  readonly idle: number;
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
  /** Calls and events addressed to the slot wait until it is released or switched. */
  held: boolean;
  /** Calls from outside the rack that wait while the slot is held. */
  queue: Call[];
  /** Calls from outside the rack to the device that haven't finished, sent or held. */
  unfinished: number;
  /** Crash timestamps, pruned to the window of the crash limit when read. */
  crashes: number[];
  /**
   * The longest watchdog timeout of the last instance that crashed or bit, which widens the
   * window of the crash limit; 0 until then.
   */
  longestWatchdog: number;
  error: WireError | undefined;
  /** Unplugged or powered off by `stop()`; calls fail with `RACK_LINK_DOWN`. */
  removed: boolean;
  /**
   * A hot-plug device, or a copy that one owns.
   *
   * @decision .agents/decisions/261121_065823-hot-plug-directories.md#hot-plug-directories
   */
  hotplug: boolean;
}

/** One link between a need of a consumer instance and a port of a provider instance. */
interface Link {
  readonly id: number;
  readonly consumer: Instance;
  readonly need: string;
  readonly provider: Instance;
  readonly port: string;
  /** The consumer sends new calls of the need on this link. */
  current: boolean;
}

/** Errors of requests to instances that are gone or going are expected; their exit cleans up. */
function ignore(): void {}

/**
 * What the every needs of an instance reach: a wire for each device, keyed `<need>:<device>`,
 * and the devices of each need, in slot order.
 *
 * @decision .agents/decisions/261121_065823-hot-plug-directories.md#every-needs
 */
export interface EveryWiring {
  wires: Map<string, Wire>;
  members: Map<string, MemberInfo[]>;
}

function sameMembers(a: readonly MemberInfo[], b: readonly MemberInfo[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The wires of an instance's needs, every needs' links to each device included. */
function* wiresOf(instance: Instance): Generator<[string, Wire]> {
  yield* instance.wiring;
  yield* instance.everyWiring;
}

/** Sets up links between instances and routes calls from outside the rack. */
export class Backplane {
  readonly #slots: ReadonlyMap<string, Slot>;
  readonly #instances: ReadonlySet<Instance>;
  readonly #callTimeout: number;
  readonly #requestTimeout: number;
  readonly #queueLimit: number;
  readonly #everyOf: (instance: Instance) => EveryWiring;
  readonly #links = new Map<number, Link>();
  /** The token of the running hold of each held slot, by slot name. */
  readonly #holds = new Map<string, number>();
  /** The providers queueing events for each held slot, by slot name. */
  readonly #eventHolds = new Map<string, Set<Instance>>();
  /** Counters of the calls from outside the rack, by address and then by member. */
  readonly #outside = new Map<string, Map<string, CalledRpcMetrics>>();
  /** Calls from outside the rack to an address or member that didn't exist. */
  #unrouted = 0;
  /** The streams of the calls from outside the rack, on each instance's data channel. */
  readonly #streams = new WeakMap<Instance, StreamChannel>();
  #nextId = 1;
  #nextLink = 1;
  #nextToken = 1;

  /**
   * @param slots The rack's slots, keyed by device name; read on every call.
   * @param instances Every instance whose Worker has not exited, installed or not.
   * @param callTimeout Timeout for calls that set none.
   * @param requestTimeout Timeout of each link-management request to an instance.
   * @param queueLimit The most unfinished calls from outside the rack to each device.
   * @param everyOf What the every needs of an instance reach now.
   */
  constructor(
    slots: ReadonlyMap<string, Slot>,
    instances: ReadonlySet<Instance>,
    callTimeout: number,
    requestTimeout: number,
    queueLimit: number,
    everyOf: (instance: Instance) => EveryWiring = () => ({ wires: new Map(), members: new Map() }),
  ) {
    this.#slots = slots;
    this.#instances = instances;
    this.#callTimeout = callTimeout;
    this.#requestTimeout = requestTimeout;
    this.#queueLimit = queueLimit;
    this.#everyOf = everyOf;
  }

  // ---- Links ----

  /**
   * Links every need of an instance that has no current link to the instance installed in the
   * provider slot. A need whose provider slot has no instance stays down until
   * {@link install} links it.
   */
  async connect(instance: Instance): Promise<void> {
    const work: Promise<unknown>[] = [];
    for (const [need, wire] of instance.wiring) {
      if (this.#currentLink(instance, need) !== undefined) continue;
      const slot = this.#slots.get(wire.provider);
      const provider = slot?.installed;
      if (slot === undefined || slot.removed || provider == null || provider.dead) continue;
      work.push(this.#link(instance, need, provider, wire.port));
    }
    // Every needs: a link to each device they reach, then the list of them, which the instance
    // has before its hooks run, since it handles its requests in order.
    // @decision .agents/decisions/261121_065823-hot-plug-directories.md#every-needs
    const every = this.#everyOf(instance);
    instance.everyWiring = every.wires;
    instance.everyMembers = every.members;
    for (const [key, wire] of every.wires) {
      if (this.#currentLink(instance, key) !== undefined) continue;
      const slot = this.#slots.get(wire.provider);
      const provider = slot?.installed;
      if (slot === undefined || slot.removed || provider == null || provider.dead) continue;
      work.push(this.#link(instance, key, provider, wire.port));
    }
    for (const [need, members] of every.members) {
      work.push(this.#ask(instance, { op: "members", need, members }));
    }
    await Promise.all(work);
  }

  /**
   * Brings the every needs of an instance up to date: links the devices that they reach now,
   * and then tells the instance which devices each reaches. The links of devices that they no
   * longer reach stay until those devices leave, so that the calls on them finish.
   *
   * @decision .agents/decisions/261121_065823-hot-plug-directories.md#every-needs
   */
  async syncEvery(instance: Instance): Promise<void> {
    if (instance.dead) return;
    const every = this.#everyOf(instance);
    const work: Promise<unknown>[] = [];
    for (const [key, wire] of every.wires) {
      const before = instance.everyWiring.get(key);
      const same = before?.provider === wire.provider && before.port === wire.port;
      if (same && this.#currentLink(instance, key) !== undefined) continue;
      const slot = this.#slots.get(wire.provider);
      const provider = slot?.installed;
      if (slot === undefined || slot.removed || provider == null || provider.dead) continue;
      work.push(this.#link(instance, key, provider, wire.port));
    }
    for (const [need, members] of every.members) {
      const before = instance.everyMembers.get(need);
      if (before !== undefined && sameMembers(before, members)) continue;
      work.push(this.#ask(instance, { op: "members", need, members }));
    }
    instance.everyWiring = every.wires;
    instance.everyMembers = every.members;
    await Promise.all(work);
  }

  /**
   * Switches a slot to `instance`, which the caller has just set as `slot.installed`: every
   * instance with a need wired to the slot gets a current link to it and sends its held calls
   * there, events for the slot go to `instance` only, and calls from outside the rack resume.
   *
   * @param previous The instance the slot had before, told that it is no longer installed.
   */
  async install(slot: Slot, instance: Instance, previous: Instance | null): Promise<void> {
    this.#prune(slot);
    // The hold ends first, so the new links go out released.
    this.#holds.delete(slot.name);
    slot.held = false;
    const work: Promise<unknown>[] = [];
    for (const consumer of this.#instances) {
      if (consumer.dead || consumer === instance) continue;
      for (const [need, wire] of wiresOf(consumer)) {
        if (wire.provider === slot.name) work.push(this.#link(consumer, need, instance, wire.port));
      }
    }
    work.push(this.#liven(slot, instance));
    work.push(this.#ask(instance, { op: "installed", installed: true }));
    if (previous !== null && previous !== instance && !previous.dead) {
      work.push(this.#ask(previous, { op: "installed", installed: false }));
    }
    this.#resume(slot);
    await Promise.all(work);
  }

  /**
   * Holds every call and event addressed to the slot: consumers queue their calls, providers
   * queue their events, and calls from outside the rack wait here. Resolves once every party
   * has confirmed or its request has timed out; a late request still arrives in order, and the
   * drain waits for its marker.
   *
   * @returns The hold markers a drain of the installed instance must wait for.
   */
  async hold(slot: Slot): Promise<Marker[]> {
    const token = this.#nextToken++;
    this.#holds.set(slot.name, token);
    slot.held = true;
    const target = slot.installed !== null && !slot.installed.dead ? slot.installed : null;
    const markers: Marker[] = [];
    const work: Promise<unknown>[] = [];
    const providers = new Set<Instance>();
    for (const link of this.#links.values()) {
      if (target !== null && link.provider === target && link.current) {
        markers.push([link.id, token]);
        work.push(this.#ask(link.consumer, { op: "hold", need: link.need, token }));
      }
      if (link.consumer.slot === slot.name) {
        if (link.consumer === target) markers.push([link.id, token]);
        providers.add(link.provider);
      }
    }
    // Remembered until the hold ends, so every provider that queues events also stops again.
    const holding = this.#eventHolds.get(slot.name) ?? new Set<Instance>();
    for (const provider of providers) {
      holding.add(provider);
      work.push(this.#ask(provider, { op: "holdEvents", consumer: slot.name, token }));
    }
    this.#eventHolds.set(slot.name, holding);
    await Promise.all(work);
    return markers;
  }

  /** Ends a hold without a switch: the installed instance gets its calls and events again. */
  async release(slot: Slot): Promise<void> {
    this.#holds.delete(slot.name);
    slot.held = false;
    const work: Promise<unknown>[] = [];
    for (const consumer of this.#instances) {
      if (consumer.dead) continue;
      for (const [need, wire] of wiresOf(consumer)) {
        if (wire.provider === slot.name) work.push(this.#ask(consumer, { op: "release", need }));
      }
    }
    const target = slot.installed !== null && !slot.installed.dead ? slot.installed : null;
    work.push(this.#liven(slot, target));
    this.#resume(slot);
    await Promise.all(work);
  }

  /**
   * Waits until the hold markers reached the instance and it serves no call, and with `streams`,
   * until no stream is open at the instance either.
   *
   * @returns `false` when `timeout` ms passed first.
   * @decision .agents/decisions/261118_071155-backplane-streams.md#swaps-and-resets
   */
  drain(instance: Instance, markers: Marker[], timeout: number, streams = false): Promise<boolean> {
    return instance.drain(timeout, markers, streams);
  }

  /** Fails every call the instance is serving: at the consumers of its links, and here. */
  fail(instance: Instance, code: string, message: string): void {
    this.failInFlight(instance, code, message);
    for (const link of [...this.#links.values()]) {
      if (link.provider !== instance) continue;
      this.#links.delete(link.id);
      void this.#ask(link.consumer, {
        op: "down",
        need: link.need,
        link: link.id,
        error: { code, message },
      });
    }
  }

  /**
   * Removes the links of an instance that exited: its consumers fail the calls pending on them
   * with `code`, and its providers abort the calls they serve for it.
   */
  disconnect(instance: Instance, code: string, message: string): void {
    this.failInFlight(instance, code, message);
    for (const link of [...this.#links.values()]) {
      if (link.provider === instance) {
        this.#links.delete(link.id);
        void this.#ask(link.consumer, {
          op: "down",
          need: link.need,
          link: link.id,
          error: { code, message },
        });
      } else if (link.consumer === instance) {
        this.#links.delete(link.id);
        void this.#ask(link.provider, { op: "drop", link: link.id, error: { code, message } });
      }
    }
  }

  /**
   * Points one need of a running instance at another provider: its new calls and its
   * subscriptions go to the instance installed there, while calls already sent finish where
   * they went.
   *
   * @decision .agents/decisions/261116_233956-cold-swaps-and-restarts.md#applying-a-changed-plan
   */
  async relink(consumer: Instance, need: string, wire: Wire): Promise<void> {
    const slot = this.#slots.get(wire.provider);
    const provider = slot?.installed;
    if (slot === undefined || slot.removed || provider == null || provider.dead) return;
    await this.#link(consumer, need, provider, wire.port);
  }

  #currentLink(consumer: Instance, need: string): Link | undefined {
    for (const link of this.#links.values()) {
      if (link.consumer === consumer && link.need === need && link.current) return link;
    }
    return undefined;
  }

  /**
   * Creates a link and makes it the need's current one.
   *
   * Both ends go out at once, with the state of this moment: calls the consumer sends before
   * the provider attaches wait in the channel, and each instance applies its requests in the
   * order they were sent. A request that times out still arrives later, so a timeout never
   * undoes a link; only the exit of either instance removes it, through {@link disconnect}.
   */
  #link(consumer: Instance, need: string, provider: Instance, port: string): Promise<unknown> {
    if (consumer.dead || provider.dead) return Promise.resolve();
    const id = this.#nextLink++;
    for (const link of this.#links.values()) {
      if (link.consumer === consumer && link.need === need) link.current = false;
    }
    this.#links.set(id, { id, consumer, need, provider, port, current: true });
    const consumerSlot = this.#slots.get(consumer.slot);
    const providerSlot = this.#slots.get(provider.slot);
    // A link to an instance that is held starts held, behind a marker of that hold.
    const hold =
      providerSlot?.installed === provider ? this.#holds.get(providerSlot.name) : undefined;
    const channel = new MessageChannel();
    return Promise.all([
      this.#ask(
        provider,
        {
          op: "attach",
          link: id,
          end: channel.port2,
          port,
          consumer: consumer.slot,
          live: consumerSlot?.installed === consumer,
          held: this.#holds.has(consumer.slot),
        },
        [channel.port2],
      ),
      this.#ask(
        consumer,
        {
          op: "link",
          need,
          link: id,
          end: channel.port1,
          provider: `${provider.slot}.${port}`,
          hold,
        },
        [channel.port1],
      ),
    ]);
  }

  /**
   * Lets events for the slot flow to the links of `instance` only, or to no link when it is
   * `null`, and ends every event hold for the slot.
   */
  async #liven(slot: Slot, instance: Instance | null): Promise<void> {
    const byProvider = new Map<Instance, number[]>();
    for (const provider of this.#eventHolds.get(slot.name) ?? []) byProvider.set(provider, []);
    this.#eventHolds.delete(slot.name);
    for (const link of this.#links.values()) {
      if (link.consumer.slot !== slot.name) continue;
      const links = byProvider.get(link.provider) ?? [];
      if (link.consumer === instance) links.push(link.id);
      byProvider.set(link.provider, links);
    }
    await Promise.all(
      [...byProvider].map(([provider, links]) =>
        this.#ask(provider, { op: "live", consumer: slot.name, links }),
      ),
    );
  }

  /**
   * Sends a link-management request. A failure means the instance is gone, which its exit
   * handles, or that it is busy, in which case the request still arrives later, in order.
   */
  #ask(
    instance: Instance,
    message: Parameters<Instance["request"]>[0],
    transfer: Bun.Transferable[] = [],
  ): Promise<void> {
    if (instance.dead) return Promise.resolve();
    return instance
      .request(message, this.#requestTimeout, message.op, transfer)
      .then(ignore, ignore);
  }

  // ---- Calls from outside the rack ----

  /** Handles one data-channel message from an instance: a result, or a message of a stream. */
  onData(instance: Instance, message: DataFromWorker): void {
    if (message.t === "result") this.#fromProvider(instance, message);
    else this.#streams.get(instance)?.onMessage(message);
  }

  /** The streams on an instance's data channel, made when a call first carries one. */
  #streamsOf(instance: Instance): StreamChannel {
    let channel = this.#streams.get(instance);
    if (channel === undefined) {
      channel = new StreamChannel((message, transfer) => instance.post(message, transfer));
      this.#streams.set(instance, channel);
    }
    return channel;
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
      const started = performance.now();
      const where = `${address}.${method}`;
      const counter = this.#counterOf(address, method);
      if (counter === undefined) this.#unrouted++;
      else {
        counter.calls++;
        counter.pending++;
      }
      // A call that ends before it is routed counts here; a routed one counts as it settles.
      const end = (error: unknown) => {
        if (counter !== undefined) {
          counted(counter, started, failure(codeOf(error), ""));
          counter.pending--;
        }
        reject(error);
      };
      const { timeout, signal, streamTimeout } = options;
      let transfer: ArrayBuffer[] | undefined;
      try {
        transfer = transferList(options.transfer, where);
      } catch (error) {
        cancelStreams(input, new RackError("RACK_CANCELLED", `${where}: the call failed`));
        end(error);
        return;
      }
      // The call owns its buffers and its stream from here on, so a call that fails early still
      // takes them.
      const refuse = (error: RackError) => {
        if (transfer !== undefined) detach(transfer);
        cancelStreams(input, new RackError("RACK_CANCELLED", `${where}: the call failed`));
        end(error);
      };
      let device: string;
      let port: string;
      try {
        ({ device, port } = parseAddress(address));
      } catch {
        refuse(new RackError("RACK_NO_ROUTE", `"${address}" is not a <device>.<port> address`));
        return;
      }
      const slot = this.#slots.get(device);
      const info = slot?.removed ? undefined : slot?.fru.provides[port];
      if (info === undefined) {
        refuse(new RackError("RACK_NO_ROUTE", `${address} does not exist`));
        return;
      }
      if (info.members[method] !== "rpc") {
        refuse(new RackError("RACK_NO_ROUTE", `${address} has no RPC member ${method}`));
        return;
      }
      if (timeout !== undefined && !(typeof timeout === "number" && timeout >= 0)) {
        refuse(new RackError("RACK_INVALID_INPUT", `${where}: timeout must be >= 0 ms`));
        return;
      }
      if (
        streamTimeout !== undefined &&
        !(typeof streamTimeout === "number" && streamTimeout >= 0)
      ) {
        refuse(new RackError("RACK_INVALID_INPUT", `${where}: streamTimeout must be >= 0 ms`));
        return;
      }
      if (signal?.aborted) {
        refuse(new RackError("RACK_CANCELLED", `${where}: call cancelled`));
        return;
      }
      // Calls from outside the rack are bounded per device, like the calls of a need.
      if (slot !== undefined && slot.unfinished >= this.#queueLimit) {
        const message = `${where}: ${device} has ${this.#queueLimit} unfinished calls from outside the rack already`;
        refuse(new RackError("RACK_OVERLOADED", message));
        return;
      }
      let taken: ReturnType<typeof takeStream>;
      try {
        taken = takeStream(input, "RACK_INVALID_INPUT", where);
      } catch (error) {
        refuse(error as RackError);
        return;
      }
      const ms = timeout ?? this.#callTimeout;
      const call = this.#create(
        device,
        port,
        method,
        taken === undefined ? input : taken.value,
        transfer,
        ms,
        streamTimeout ?? ms,
        caller,
        (outcome) => (outcome.ok ? resolve(outcome.value) : reject(fromWireError(outcome.error))),
      );
      if (slot !== undefined) {
        slot.unfinished++;
        call.counted = slot;
      }
      call.counter = counter;
      call.started = started;
      if (taken !== undefined) {
        try {
          call.sender = new StreamSender(taken.stream, "RACK_INVALID_INPUT", {
            idle: call.idle,
            where,
            counters: streamCounters(counter),
            onEnd: (error) => this.#inputEnded(call, error),
          });
          call.key = taken.key;
          call.streams++;
        } catch (error) {
          this.#finish(
            call,
            {
              ok: false,
              error: { code: "RACK_INVALID_INPUT", message: (error as RackError).message },
            },
            false,
          );
          return;
        }
      } else this.#startTimer(call);
      if (signal !== undefined) {
        const onAbort = () => {
          const error = new RackError("RACK_CANCELLED", `${where}: call cancelled`);
          // The provider's call.signal aborts too, also when the result came and streams still run.
          if (call.settled && call.streams > 0 && !call.finished) {
            call.target?.post({ t: "cancel", id: call.id });
          }
          call.sender?.cancel(error);
          call.receiver?.cancel(error);
          this.#finish(call, failure("RACK_CANCELLED", `${where}: call cancelled`), true);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        call.cleanup = () => signal.removeEventListener("abort", onAbort);
      }
      this.#dispatch(call);
    });
  }

  /** Fails every call from outside the rack that the instance is serving, and their streams. */
  failInFlight(instance: Instance, code: string, message: string): void {
    // The data channel's streams fail with the code its calls get.
    // @decision .agents/decisions/261118_071155-backplane-streams.md#cancellation-and-errors
    this.#streams.get(instance)?.close(new RackError(code, message));
    for (const call of instance.inFlight.values()) {
      this.#finish(call as Call, failure(code, message), false);
    }
    instance.inFlight.clear();
    instance.checkDrained();
  }

  /** Hands calls held for the slot, in order, to whatever instance is installed now. */
  #resume(slot: Slot): void {
    const queue = slot.queue;
    slot.queue = [];
    for (const call of queue) {
      call.queuedIn = undefined;
      if (call.counter !== undefined) call.counter.queued--;
      this.#dispatch(call);
    }
  }

  #fromProvider(provider: Instance, message: CallResult): void {
    const call = provider.inFlight.get(message.id) as Call | undefined;
    const slot = message.ok ? message.stream : undefined;
    if (call === undefined) {
      // Nobody waits for the result any more, so its stream is cancelled at its source.
      if (slot !== undefined) {
        this.#streamsOf(provider).refuse(
          slot[1],
          new RackError("RACK_CANCELLED", "the caller gave up"),
        );
      }
      return;
    }
    provider.inFlight.delete(message.id);
    if (!message.ok) {
      this.#finish(call, { ok: false, error: message.error }, false);
      provider.checkDrained();
      return;
    }
    let value = message.value;
    if (slot !== undefined) {
      const receiver = this.#streamsOf(provider).receive(slot[1], {
        idle: call.idle,
        where: `${call.provider}.${call.port}.${call.member}`,
        counters: streamCounters(call.counter),
        onEnd: () => {
          call.streams--;
          this.#finishIfDone(call);
        },
      });
      call.receiver = receiver;
      call.streams++;
      value = putStream(value, slot[0], receiver.stream);
    }
    this.#finish(call, { ok: true, value }, false);
    provider.checkDrained();
  }

  #create(
    provider: string,
    port: string,
    member: string,
    input: unknown,
    transfer: ArrayBuffer[] | undefined,
    ms: number,
    idle: number,
    caller: string,
    deliver: (outcome: Outcome) => void,
  ): Call {
    return {
      id: this.#nextId++,
      settled: false,
      provider,
      port,
      member,
      input,
      transfer,
      deadline: Date.now() + ms,
      caller,
      deliver,
      timer: undefined,
      target: undefined,
      queuedIn: undefined,
      counted: undefined,
      counter: undefined,
      started: performance.now(),
      cleanup: undefined,
      ms,
      idle,
      sender: undefined,
      key: null,
      receiver: undefined,
      streams: 0,
      finished: false,
    };
  }

  /**
   * Starts the timeout of a call. The backplane owns the timeout of a call from outside the
   * rack: it fails the call and cancels it at the provider.
   *
   * @decision .agents/decisions/261116_024226-backplane-links.md#rpc
   */
  #startTimer(call: Call): void {
    if (call.settled || call.timer !== undefined) return;
    call.timer = armTimer(call.ms, () => {
      const where = `${call.provider}.${call.port}.${call.member}`;
      this.#finish(call, failure("RACK_TIMEOUT", `${where} timed out after ${call.ms} ms`), true);
    });
  }

  /**
   * The input stream of a call ended, failed, or was cancelled. The call's timeout runs from
   * then. A call that still waits to go out fails with the stream's error, such as
   * `RACK_TIMEOUT` once it has waited `streamTimeout`.
   *
   * @decision .agents/decisions/261118_071155-backplane-streams.md#swaps-and-resets
   */
  #inputEnded(call: Call, error: RackError | undefined): void {
    call.streams--;
    if (!call.settled) {
      if (error !== undefined && call.target === undefined) {
        this.#finish(
          call,
          { ok: false, error: { code: error.code, message: error.message } },
          false,
        );
      } else this.#startTimer(call);
    }
    this.#finishIfDone(call);
  }

  #dispatch(call: Call): void {
    if (call.settled) return;
    const slot = this.#slots.get(call.provider);
    if (slot === undefined || slot.removed) {
      this.#finish(call, failure("RACK_LINK_DOWN", `${call.provider} is not in the rack`), false);
      return;
    }
    if (slot.held) {
      // The count of unfinished calls bounds the queue.
      if (call.transfer !== undefined) {
        try {
          // The call takes its buffers at once, even though it goes out later.
          ({ value: call.input, buffers: call.transfer } = moveInto(call.input, call.transfer));
        } catch {
          // DataCloneError: input from outside the rack has not crossed a thread yet.
          const where = `${call.provider}.${call.port}.${call.member}`;
          this.#finish(
            call,
            failure("RACK_INVALID_INPUT", `${where}: input cannot be cloned`),
            false,
          );
          return;
        }
      }
      slot.queue.push(call);
      call.queuedIn = slot;
      if (call.counter !== undefined) call.counter.queued++;
      return;
    }
    const target = slot.installed;
    if (target === null || target.dead) {
      this.#finish(call, failure("RACK_LINK_DOWN", `${slot.name} is ${slot.state}`), false);
      return;
    }
    const message: CallToProvider = {
      t: "call",
      id: call.id,
      port: call.port,
      member: call.member,
      input: call.input,
      // The provider sees no deadline for a call with an input stream; the backplane times it out.
      deadline: call.sender === undefined ? call.deadline : Number.POSITIVE_INFINITY,
      idle: call.idle,
      caller: call.caller,
    };
    if (call.sender !== undefined) {
      message.stream = [call.key, this.#streamsOf(target).attach(call.sender)];
    }
    try {
      target.post(message, call.transfer);
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
   * Settles a call once: its outcome is counted and delivered. A call that fails takes its input
   * stream with it. A call stays in its provider's in-flight set until the provider answers, so
   * draining still waits for work the provider has not finished, and it stays unfinished until
   * its streams end.
   */
  #finish(call: Call, outcome: Outcome | undefined, cancelProvider: boolean): void {
    if (call.settled) return;
    call.settled = true;
    clearTimeout(call.timer);
    if (call.transfer !== undefined) detach(call.transfer);
    if (call.queuedIn !== undefined) {
      const queue = call.queuedIn.queue;
      const index = queue.indexOf(call);
      if (index >= 0) queue.splice(index, 1);
      call.queuedIn = undefined;
      if (call.counter !== undefined) call.counter.queued--;
    }
    if (cancelProvider && call.target?.inFlight.has(call.id)) {
      call.target.post({ t: "cancel", id: call.id });
    }
    if (outcome !== undefined && !outcome.ok) {
      const where = `${call.provider}.${call.port}.${call.member}`;
      call.sender?.cancel(new RackError("RACK_CANCELLED", `${where}: the call failed`));
    }
    if (outcome !== undefined && call.counter !== undefined) {
      counted(call.counter, call.started, outcome);
    }
    this.#finishIfDone(call);
    if (outcome !== undefined) call.deliver(outcome);
  }

  /** Counts a call as finished once it has settled and its streams have ended. */
  #finishIfDone(call: Call): void {
    if (call.finished || !call.settled || call.streams > 0) return;
    call.finished = true;
    call.cleanup?.();
    if (call.counted !== undefined) {
      call.counted.unfinished--;
      call.counted = undefined;
    }
    if (call.counter !== undefined) call.counter.pending--;
  }

  // ---- Counters of calls from outside the rack ----

  /**
   * The counters of the calls from outside the rack to `address` and `member`, made when first
   * needed; `undefined` when the address or the member doesn't exist, so the counters stay
   * bounded by the ports in the rack.
   */
  #counterOf(address: string, member: string): CalledRpcMetrics | undefined {
    let port: string;
    let device: string;
    try {
      ({ device, port } = parseAddress(address));
    } catch {
      // Not a <device>.<port> address: the call counts as unrouted.
      return undefined;
    }
    const slot = this.#slots.get(device);
    if (slot === undefined || slot.removed) return undefined;
    if (slot.fru.provides[port]?.members[member] !== "rpc") return undefined;
    let members = this.#outside.get(address);
    if (members === undefined) {
      members = new Map();
      this.#outside.set(address, members);
    }
    let counter = members.get(member);
    if (counter === undefined) {
      counter = { kind: "rpc", calls: 0, ok: 0, errors: {}, pending: 0, queued: 0, timeMs: 0 };
      members.set(member, counter);
    }
    return counter;
  }

  /** Drops the counters of the members that the slot's device no longer provides. */
  #prune(slot: Slot): void {
    for (const [address, members] of this.#outside) {
      const { device, port } = parseAddress(address);
      if (device !== slot.name) continue;
      for (const member of members.keys()) {
        if (slot.fru.provides[port]?.members[member] !== "rpc") members.delete(member);
      }
      if (members.size === 0) this.#outside.delete(address);
    }
  }

  /** Drops the counters of the calls to a device that left the rack. */
  forget(device: string): void {
    for (const address of [...this.#outside.keys()]) {
      if (parseAddress(address).device === device) this.#outside.delete(address);
    }
  }

  /** A copy of the counters of the calls from outside the rack. */
  outside(): OutsideMetrics {
    const ports: OutsideMetrics["ports"] = {};
    for (const [address, members] of this.#outside) {
      const copy: Record<string, CalledRpcMetrics> = {};
      for (const [member, counter] of members) {
        copy[member] = { ...counter, errors: { ...counter.errors } };
        if (counter.streams !== undefined) {
          copy[member].streams = { ...counter.streams, errors: { ...counter.streams.errors } };
        }
      }
      ports[address] = copy;
    }
    return { ports, unrouted: this.#unrouted };
  }
}

function failure(code: string, message: string): Outcome {
  return { ok: false, error: { code, message } };
}

/** Counts the outcome of a call from outside the rack; its `pending` counts until it finishes. */
function counted(counter: CalledRpcMetrics, started: number, outcome: Outcome): void {
  counter.timeMs += performance.now() - started;
  if (outcome.ok) counter.ok++;
  else counter.errors[outcome.error.code] = (counter.errors[outcome.error.code] ?? 0) + 1;
}

/** The stream counters of a member, made when its calls first carry a stream. */
function streamCounters(counter: CalledRpcMetrics | undefined): StreamMetrics {
  if (counter === undefined) {
    return { opened: 0, open: 0, bytesSent: 0, bytesReceived: 0, errors: {} };
  }
  counter.streams ??= { opened: 0, open: 0, bytesSent: 0, bytesReceived: 0, errors: {} };
  return counter.streams;
}

/** The code of an error that ends a call, as its caller receives it. */
function codeOf(error: unknown): string {
  return error instanceof RackError ? error.code : "RACK_INVALID_INPUT";
}

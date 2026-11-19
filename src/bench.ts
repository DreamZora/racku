/**
 * Entry point of `rack42u/bench`: runs one device in a rack of its own, with stubs that a test
 * implements for its needs, and records what the device does.
 *
 * The bench writes a stub device file for each need, and a probe device file above the device
 * that records its events. Both import their code from this module, so it loads the rack runtime
 * only when a bench starts, which spares those devices' Workers from loading it.
 *
 * @decision .agents/decisions/261118_173457-device-test-bench.md
 */
import { randomBytes } from "node:crypto";
import { mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import {
  type Connector,
  type ConnectorInfo,
  connector,
  type EventSpec,
  event,
  isConnector,
  type Members,
  type RpcSpec,
  rpc,
} from "./connector.ts";
import {
  type CallContext,
  type CallOptions,
  device,
  type PortEmitter,
  type PortImpl,
} from "./device.ts";
import { fromWireError, RackError, toWireError, type WireError } from "./errors.ts";
import type { LogEntry } from "./log.ts";
import { checkDeviceName, rack, type SlotSpec, slot } from "./manifest.ts";
import type { Fru } from "./protocol.ts";
import type { RackHandle, ReloadResult, StartOptions } from "./rack.ts";
import { type StandardSchemaV1, validate } from "./schema.ts";
import { takeStream } from "./streams.ts";

/** The most records of each kind that a bench, and each of its stubs, keeps. */
const RECORD_LIMIT = 10_000;

/** The most bytes of a stream in a stub's call, which crosses read whole. */
const STREAM_LIMIT = 16 * 1024 * 1024;

/** A schema that accepts any value: stub and probe devices leave validation to the test. */
const ANY: StandardSchemaV1 = {
  "~standard": { version: 1, vendor: "rack42u", validate: (value: unknown) => ({ value }) },
};

/** A stream that crossed read whole: where it was in its value, and its bytes. */
interface WholeStream {
  /** The key of its property, or `null` when the value was the stream. */
  key: string | null;
  bytes: Uint8Array;
}

/** A message on a bench's channel, between the test and the stub and probe devices. */
type Message =
  | {
      kind: "call";
      stub: string;
      id: string;
      member: string;
      value: unknown;
      stream?: WholeStream;
      deadline: number;
    }
  | { kind: "cancel"; stub: string; id: string; error: WireError }
  | { kind: "result"; stub: string; id: string; value: unknown; stream?: WholeStream }
  | { kind: "failed"; stub: string; id: string; error: WireError }
  | { kind: "emit"; stub: string; id: string; event: string; payload: unknown }
  | { kind: "emitted"; stub: string; id: string; error?: WireError }
  | { kind: "event"; port: string; event: string; payload: unknown; at: number };

type CallMessage = Extract<Message, { kind: "call" }>;

// ---- The devices that the bench writes ----

/** What a stub device file passes to {@link stubDevice}. The bench writes the file. */
export interface StubDeviceSpec {
  /** The name of the bench's `BroadcastChannel`. */
  channel: string;
  /** The need the stub stands in for, which names its port too. */
  need: string;
  /** The need's connector, by its id and members. */
  connector: ConnectorInfo;
}

/**
 * Defines the device that stands in for one need of a device on a bench: it provides the need's
 * connector, with schemas that accept anything, and passes each call to the test, where the
 * stub's implementation and the connector's schemas run. Only the files the bench writes use it.
 *
 * @param spec The channel, the need, and its connector.
 * @returns The stub device's definition.
 */
export function stubDevice(spec: StubDeviceSpec) {
  const members: Members = {};
  for (const [name, kind] of Object.entries(spec.connector.members)) {
    members[name] = kind === "rpc" ? rpc(ANY, ANY) : event(ANY);
  }
  const provides: Record<string, Connector> = {
    [spec.need]: connector(spec.connector.id, members),
  };
  return device<Record<never, Connector>, Record<string, Connector>>({
    model: "bench-stub",
    provides,
    powerOn(ctx) {
      const channel = new BroadcastChannel(spec.channel);
      ctx.signal.addEventListener("abort", () => channel.close(), { once: true });
      const pending = new Map<
        string,
        { resolve(value: unknown): void; reject(error: unknown): void }
      >();
      const prefix = randomBytes(6).toString("hex");
      let calls = 0;
      const emitters = ctx.emit as Record<
        string,
        Record<string, (payload: unknown) => Promise<void>>
      >;
      const post = (message: Message) => channel.postMessage(message);

      channel.addEventListener("message", (received) => {
        const data = received.data as Message;
        if (!("stub" in data) || data.stub !== spec.need) return;
        if (data.kind === "result" || data.kind === "failed") {
          const waiting = pending.get(data.id);
          if (waiting === undefined) return;
          pending.delete(data.id);
          if (data.kind === "failed") waiting.reject(fromWireError(data.error));
          else waiting.resolve(withStream(data.value, data.stream, streamOf));
        } else if (data.kind === "emit") {
          const emit = emitters[spec.need]?.[data.event];
          const done =
            emit === undefined ? Promise.reject(noEvent(spec, data.event)) : emit(data.payload);
          done.then(
            () => post({ kind: "emitted", stub: spec.need, id: data.id }),
            (error: unknown) =>
              post({ kind: "emitted", stub: spec.need, id: data.id, error: toWireError(error) }),
          );
        }
      });

      const forward = async (member: string, input: unknown, call: CallContext) => {
        const where = `${spec.need}.${member}`;
        const taken = takeStream(input, "RACK_INVALID_INPUT", where);
        const stream: WholeStream | undefined =
          taken === undefined
            ? undefined
            : { key: taken.key, bytes: await readWhole(taken.stream, "RACK_INVALID_INPUT", where) };
        const id = `${prefix}-${++calls}`;
        return new Promise<unknown>((resolve, reject) => {
          const cancel = () => {
            pending.delete(id);
            post({ kind: "cancel", stub: spec.need, id, error: toWireError(call.signal.reason) });
            reject(call.signal.reason);
          };
          if (call.signal.aborted) {
            cancel();
            return;
          }
          call.signal.addEventListener("abort", cancel, { once: true });
          const settle = (finish: () => void) => {
            call.signal.removeEventListener("abort", cancel);
            finish();
          };
          pending.set(id, {
            resolve: (value) => settle(() => resolve(value)),
            reject: (error) => settle(() => reject(error)),
          });
          const value = taken === undefined ? input : taken.value;
          post({
            kind: "call",
            stub: spec.need,
            id,
            member,
            value,
            stream,
            deadline: call.deadline,
          });
        });
      };

      const port: Record<string, (input: unknown, call: CallContext) => Promise<unknown>> = {};
      for (const [member, kind] of Object.entries(spec.connector.members)) {
        if (kind === "rpc") port[member] = (input, call) => forward(member, input, call);
      }
      return { [spec.need]: port };
    },
  });
}

/** What a probe device file passes to {@link probeDevice}. The bench writes the file. */
export interface ProbeDeviceSpec {
  /** The name of the bench's `BroadcastChannel`. */
  channel: string;
  /** The ports of the device on the bench that have events, with their connector ids and events. */
  ports: Record<string, { id: string; events: string[] }>;
}

/**
 * Defines the device above a device on a bench that records its events: it needs each of the
 * device's ports that has events, and passes every event it receives to the test. Only the files
 * the bench writes use it.
 *
 * @param spec The channel, and the ports with their events.
 * @returns The probe device's definition.
 */
export function probeDevice(spec: ProbeDeviceSpec) {
  const needs: Record<string, Connector> = {};
  for (const [port, { id, events }] of Object.entries(spec.ports)) {
    needs[port] = connector(id, Object.fromEntries(events.map((name) => [name, event(ANY)])));
  }
  return device<Record<string, Connector>>({
    model: "bench-probe",
    needs,
    powerOn(ctx) {
      const channel = new BroadcastChannel(spec.channel);
      ctx.signal.addEventListener("abort", () => channel.close(), { once: true });
      const on = ctx.on as Record<
        string,
        Record<string, (handler: (payload: unknown) => void) => void>
      >;
      for (const [port, { events }] of Object.entries(spec.ports)) {
        for (const name of events) {
          on[port]?.[name]?.((payload) => {
            const message: Message = { kind: "event", port, event: name, payload, at: Date.now() };
            channel.postMessage(message);
          });
        }
      }
      return {};
    },
  });
}

// ---- Stubs ----

/** One call that a stub received. */
export interface StubCall {
  member: string;
  /** The input as the device sent it, with a stream in it as its bytes, a `Uint8Array`. */
  input: unknown;
  /** When the stub received it, a millisecond timestamp. */
  at: number;
}

/** A stand-in for one need of a device on a bench; see {@link stub}. */
export interface Stub<M extends Members = Members> {
  /** The connector the stub implements. */
  readonly connector: Connector<M>;
  /** The calls the stub received, oldest first: the last 10 000, invalid ones included. */
  readonly calls: readonly StubCall[];
  /** How many calls older than the ones in `calls` were dropped. */
  readonly dropped: number;
  /**
   * Emits the connector's events to the device, one function per event. The payload is
   * validated as a publisher validates it, and the promise resolves once the stub has emitted
   * it.
   *
   * @throws RackError `RACK_INVALID_OUTPUT` for a payload the schema rejects, `RACK_LINK_DOWN`
   *   while the stub is on no running bench, and `RACK_TIMEOUT` when the stub doesn't answer
   *   within the bench's `callTimeout`.
   */
  readonly emit: PortEmitter<M>;
}

/** A list of the last {@link RECORD_LIMIT} records, with the count of the older ones it dropped. */
class Records<T> {
  readonly items: T[] = [];
  dropped = 0;

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > RECORD_LIMIT) {
      this.items.shift();
      this.dropped++;
    }
  }
}

/** Where a stub is wired while its bench runs. */
interface StubLink {
  channel: BroadcastChannel;
  need: string;
  /** How long an emit waits for the stub device to answer, in ms. */
  timeout: number;
}

/** A stub, with what the bench needs to run it. */
class BenchStub<M extends Members = Members> implements Stub<M> {
  readonly connector: Connector<M>;
  readonly emit: PortEmitter<M>;
  readonly #implementation: Partial<PortImpl<M>>;
  readonly #calls = new Records<StubCall>();
  readonly #running = new Map<string, AbortController>();
  readonly #emits = new Map<
    string,
    { resolve(): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }
  >();
  #emitted = 0;
  #link: StubLink | undefined;

  constructor(target: Connector<M>, implementation: Partial<PortImpl<M>>) {
    this.connector = target;
    this.#implementation = implementation;
    const emit: Record<string, (payload: unknown) => Promise<void>> = {};
    for (const [name, spec] of Object.entries(target.members)) {
      if (spec.kind === "event") emit[name] = (payload) => this.#emit(name, spec, payload);
    }
    this.emit = Object.freeze(emit) as PortEmitter<M>;
  }

  get calls(): readonly StubCall[] {
    return this.#calls.items;
  }

  get dropped(): number {
    return this.#calls.dropped;
  }

  get attached(): boolean {
    return this.#link !== undefined;
  }

  attach(link: StubLink): void {
    this.#link = link;
  }

  /** Ends what the stub still does for its bench, which has stopped. */
  detach(): void {
    const gone = new RackError("RACK_LINK_DOWN", "the bench stopped");
    for (const controller of this.#running.values()) controller.abort(gone);
    this.#running.clear();
    for (const waiting of this.#emits.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(gone);
    }
    this.#emits.clear();
    this.#link = undefined;
  }

  /** Runs one call from the stub device and answers it. */
  async handleCall(message: CallMessage): Promise<void> {
    const link = this.#link;
    if (link === undefined) return;
    const { id, member } = message;
    const where = `${link.need}.${member}`;
    const answer = (reply: Message) => {
      // A bench that stopped meanwhile closed its channel, and no device waits for the answer.
      if (this.#link !== link) return;
      try {
        link.channel.postMessage(reply);
      } catch {
        // The result holds something that can't be cloned, which the device couldn't receive.
        link.channel.postMessage({
          kind: "failed",
          stub: link.need,
          id,
          error: { code: "RACK_INVALID_OUTPUT", message: `${where}: output cannot be cloned` },
        } satisfies Message);
      }
    };
    const fail = (error: unknown) =>
      answer({ kind: "failed", stub: link.need, id, error: toWireError(error) });
    this.#calls.push({
      member,
      input: withStream(message.value, message.stream, (bytes) => bytes),
      at: Date.now(),
    });
    const spec = this.connector.members[member];
    const implementation = (this.#implementation as Record<string, unknown>)[member];
    if (spec?.kind !== "rpc" || typeof implementation !== "function") {
      fail(
        new RackError(
          "RACK_DEVICE_FAULT",
          `the stub of ${this.connector.id} implements no ${member}`,
        ),
      );
      return;
    }
    const controller = new AbortController();
    this.#running.set(id, controller);
    try {
      const input = await validate(
        (spec as RpcSpec).input,
        withStream(message.value, message.stream, streamOf),
      );
      if (!input.ok) throw new RackError("RACK_INVALID_INPUT", `${where}: ${input.message}`);
      const call: CallContext = {
        signal: controller.signal,
        deadline: message.deadline,
        // A stub's result is copied to the device, so there is nothing to move.
        transfer: () => {},
      };
      const returned: unknown = await implementation.call(this.#implementation, input.value, call);
      if (controller.signal.aborted) return;
      const output = await validate((spec as RpcSpec).output, returned);
      if (!output.ok) throw new RackError("RACK_INVALID_OUTPUT", `${where}: ${output.message}`);
      const taken = takeStream(output.value, "RACK_INVALID_OUTPUT", where);
      if (taken === undefined) {
        answer({ kind: "result", stub: link.need, id, value: output.value });
        return;
      }
      const bytes = await readWhole(taken.stream, "RACK_INVALID_OUTPUT", where);
      answer({
        kind: "result",
        stub: link.need,
        id,
        value: taken.value,
        stream: { key: taken.key, bytes },
      });
    } catch (error) {
      if (!controller.signal.aborted) fail(error);
    } finally {
      this.#running.delete(id);
    }
  }

  /** Aborts the implementation of a call that the device no longer waits for. */
  handleCancel(message: Extract<Message, { kind: "cancel" }>): void {
    this.#running.get(message.id)?.abort(fromWireError(message.error));
  }

  handleEmitted(message: Extract<Message, { kind: "emitted" }>): void {
    const waiting = this.#emits.get(message.id);
    if (waiting === undefined) return;
    this.#emits.delete(message.id);
    clearTimeout(waiting.timer);
    if (message.error === undefined) waiting.resolve();
    else waiting.reject(fromWireError(message.error));
  }

  async #emit(name: string, spec: EventSpec, payload: unknown): Promise<void> {
    const link = this.#link;
    if (link === undefined) {
      throw new RackError(
        "RACK_LINK_DOWN",
        `the stub of ${this.connector.id} is on no running bench`,
      );
    }
    const where = `${link.need}.${name}`;
    const checked = await validate(spec.payload, payload);
    if (!checked.ok) throw new RackError("RACK_INVALID_OUTPUT", `${where}: ${checked.message}`);
    const id = `${++this.#emitted}`;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#emits.delete(id);
        reject(
          new RackError("RACK_TIMEOUT", `${where}: the stub didn't emit within ${link.timeout} ms`),
        );
      }, link.timeout);
      this.#emits.set(id, { resolve, reject, timer });
      try {
        const message: Message = {
          kind: "emit",
          stub: link.need,
          id,
          event: name,
          payload: checked.value,
        };
        link.channel.postMessage(message);
      } catch {
        // A payload that can't be cloned can't reach the device either.
        clearTimeout(timer);
        this.#emits.delete(id);
        reject(new RackError("RACK_INVALID_OUTPUT", `${where}: payload cannot be cloned`));
      }
    });
  }
}

/**
 * Makes a stand-in for one need of a device on a bench. The stub runs `implementation` in the
 * test, and validates each call's input and output with the connector's schemas, as the rack
 * validates them at a provider.
 *
 * - An implementation that throws a `RackError` gives the device that error's code; any other
 *   error reaches it as `RACK_DEVICE_FAULT`, as does a call to a member without an
 *   implementation.
 * - An implementation that never settles lets the device's call time out, and its
 *   `call.signal` aborts. `call.transfer()` does nothing: a stub's result is copied.
 * - A stream in a call's input or result crosses read whole, up to 16 MiB; beyond that the call
 *   fails with `RACK_INVALID_INPUT` or `RACK_INVALID_OUTPUT`.
 *
 * A stub serves one bench at a time.
 *
 * @param target The need's connector.
 * @param implementation Functions for the connector's RPC members, as a device's port has them.
 * @returns The stub, with its records and its event emitters.
 * @throws RackError `RACK_MANIFEST` for something that isn't a connector, or an implementation
 *   with a member that isn't one of the connector's RPC members.
 */
export function stub<M extends Members>(
  target: Connector<M>,
  implementation: Partial<PortImpl<M>>,
): Stub<M> {
  if (!isConnector(target)) throw new RackError("RACK_MANIFEST", "stub() requires a connector");
  if (typeof implementation !== "object" || implementation === null) {
    throw new RackError("RACK_MANIFEST", `stub of ${target.id}: implementation must be an object`);
  }
  for (const [name, value] of Object.entries(implementation)) {
    if (target.members[name]?.kind !== "rpc" || typeof value !== "function") {
      throw new RackError(
        "RACK_MANIFEST",
        `stub of ${target.id}: ${name} isn't a function for an RPC member of ${target.id}`,
      );
    }
  }
  return new BenchStub(target, implementation);
}

// ---- The bench ----

/** An event that the device on a bench emitted. */
export interface BenchEvent {
  port: string;
  event: string;
  payload: unknown;
  /** When the probe received it, a millisecond timestamp. */
  at: number;
}

/** A fault of the device on a bench: a crash, or a bite of a watchdog. */
export interface BenchFault {
  /** The firmware of the instance that failed. */
  firmware: string;
  error: WireError;
  /** Whether the rack reset the device after it. */
  reset: boolean;
  at: number;
}

/** Options of {@link bench}. */
export interface BenchOptions<N extends Record<string, Stub> = Record<string, Stub>>
  extends Omit<StartOptions, "logger"> {
  /** One stub per need of the device, own and patched needs included, by need name. */
  needs?: N;
  /** The device's configuration, as `slot()` takes it. */
  config?: unknown;
  /** The device's name, as `slot()` takes it; by default its model. */
  name?: string;
}

/** A device running on a bench; see {@link bench}. */
export interface Bench<N extends Record<string, Stub> = Record<string, Stub>>
  extends AsyncDisposable {
  /** The device's name in its rack. */
  readonly name: string;
  /** The rack around the device, for `status()`, `metrics()`, `history()`, and the rest. */
  readonly rack: RackHandle;
  /** The stubs of the device's needs, as `options.needs` gave them. */
  readonly needs: N;
  /** The events the device emitted to installed subscribers, oldest first: the last 10 000. */
  readonly events: readonly BenchEvent[];
  /** The rack's log entries, the device's included, oldest first: the last 10 000. */
  readonly logs: readonly LogEntry[];
  /** The device's faults, oldest first: the last 10 000. */
  readonly faults: readonly BenchFault[];
  /** How many records older than the ones kept were dropped, by kind. */
  readonly dropped: { readonly events: number; readonly logs: number; readonly faults: number };
  /**
   * Calls an RPC member of one of the device's ports, as `rack.call()` calls `<device>.<port>`.
   *
   * @throws RackError as `rack.call()` does.
   */
  call<T = unknown>(
    port: string,
    member: string,
    input: unknown,
    options?: CallOptions,
  ): Promise<T>;
  /**
   * Replaces the device, optionally with another device file, as `rack.swap()` does.
   *
   * @throws RackError as `rack.swap()` does.
   */
  swap(source?: string | URL): Promise<void>;
  /**
   * Starts the device again from scratch, without its state, as `rack.restart()` does.
   *
   * @throws RackError as `rack.restart()` does.
   */
  restart(): Promise<ReloadResult[]>;
  /** Rebuilds the firmware and replaces the device if its hash changed, as `rack.reload()` does. */
  reload(): Promise<ReloadResult[]>;
  /** Stops the rack, closes the bench's channel, and deletes the bench's files. */
  stop(): Promise<void>;
}

/**
 * Builds a device file into firmware and runs it in a rack of its own, with a stub below it for
 * each of its needs, and a probe above it that records its events. The device runs as in any
 * rack: in its own Worker, with its configuration validated, its hooks, clones at every
 * boundary, timeouts, cancellation, swaps, and resets.
 *
 * The bench writes its stub and probe device files into one directory under `.rack/bench/` in
 * the base directory, and deletes it when it stops. `await using` stops it at the end of the
 * scope.
 *
 * @param source The device file: a path relative to the base directory, or a `file:` URL.
 * @param options The stubs, the device's configuration and name, and the options of `start()`
 *   apart from `logger`, whose entries the bench records.
 * @returns The bench, once the device is online.
 * @throws RackError `RACK_MANIFEST` for a need without a stub, a stub of another connector or one
 *   that lacks members of the need, or a stub for a need the device doesn't have; and as
 *   `start()` does, `RACK_INVALID_CONFIG`, `RACK_HOOK_FAILED`, or `RACK_MANIFEST`.
 */
export async function bench<N extends Record<string, Stub> = Record<never, Stub>>(
  source: string | URL,
  options: BenchOptions<N> = {},
): Promise<Bench<N>> {
  const { needs = {} as N, config, name: chosen, ...startOptions } = options;
  const baseDir = resolvePath(startOptions.baseDir ?? process.cwd());
  const logs = new Records<LogEntry>();
  const logger = (entry: LogEntry) => logs.push(entry);
  const { describeDevice, start } = await import("./rack.ts");
  const fru = await describeDevice(source, config, { ...startOptions, baseDir, logger });
  const name = chosen ?? fru.model;
  const stubs = stubsFor(name, fru, needs);

  const id = randomBytes(8).toString("hex");
  const channelName = `rack42u-bench-${id}`;
  const dir = join(baseDir, ".rack", "bench", id);
  const channel = new BroadcastChannel(channelName);
  const events = new Records<BenchEvent>();
  const faults = new Records<BenchFault>();
  channel.addEventListener("message", (received) => {
    const data = received.data as Message;
    if (data.kind === "event") {
      events.push({ port: data.port, event: data.event, payload: data.payload, at: data.at });
    } else if (data.kind === "call") void stubs.get(data.stub)?.handleCall(data);
    else if (data.kind === "cancel") stubs.get(data.stub)?.handleCancel(data);
    else if (data.kind === "emitted") stubs.get(data.stub)?.handleEmitted(data);
  });
  const timeout = startOptions.callTimeout ?? 30_000;
  for (const [need, target] of stubs) target.attach({ channel, need, timeout });
  const release = async () => {
    channel.close();
    for (const target of stubs.values()) target.detach();
    await rm(dir, { recursive: true, force: true });
    await rmdir(join(baseDir, ".rack", "bench")).catch(() => {
      // Another bench's directory is still there, or the directory is already gone.
    });
  };

  let running: RackHandle;
  try {
    const manifest = await writeRack(dir, channelName, source, name, config, fru);
    running = await start(manifest, { ...startOptions, baseDir, logger });
  } catch (error) {
    await release();
    throw error;
  }
  const unsubscribe = running.subscribe((change) => {
    if (change.type !== "fault" || change.device !== name) return;
    const { firmware, error, reset } = change;
    faults.push({ firmware, error, reset, at: Date.now() });
  });
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      try {
        await running.stop();
      } finally {
        unsubscribe();
        await release();
      }
    })();
    return stopping;
  };
  return {
    name,
    rack: running,
    needs,
    get events() {
      return events.items;
    },
    get logs() {
      return logs.items;
    },
    get faults() {
      return faults.items;
    },
    get dropped() {
      return { events: events.dropped, logs: logs.dropped, faults: faults.dropped };
    },
    call: <T>(port: string, member: string, input: unknown, callOptions?: CallOptions) =>
      running.call(`${name}.${port}`, member, input, callOptions) as Promise<T>,
    swap: (next?: string | URL) => running.swap(name, next),
    restart: () => running.restart(name),
    reload: () => running.reload(),
    stop,
    [Symbol.asyncDispose]: stop,
  };
}

/**
 * Matches the stubs to the device's needs.
 *
 * @throws RackError `RACK_MANIFEST` for a need without a stub, a stub that doesn't fit its need,
 *   a stub given twice or serving another bench, and a stub for a need the device lacks.
 */
function stubsFor(name: string, fru: Fru, needs: Record<string, Stub>): Map<string, BenchStub> {
  const stubs = new Map<string, BenchStub>();
  for (const [need, info] of Object.entries(fru.needs)) {
    const given = needs[need];
    if (given === undefined) {
      throw new RackError(
        "RACK_MANIFEST",
        `bench: ${name} needs ${need}, a ${info.id}, and options.needs has no stub for it`,
      );
    }
    if (!(given instanceof BenchStub)) {
      throw new RackError("RACK_MANIFEST", `bench: options.needs.${need} isn't made by stub()`);
    }
    if (given.connector.id !== info.id) {
      throw new RackError(
        "RACK_MANIFEST",
        `bench: ${name}.${need} needs a ${info.id}, and its stub is a ${given.connector.id}`,
      );
    }
    const missing = Object.entries(info.members)
      .filter(([member, kind]) => given.connector.members[member]?.kind !== kind)
      .map(([member]) => member);
    if (missing.length > 0) {
      throw new RackError(
        "RACK_MANIFEST",
        `bench: the stub of ${info.id} for ${need} lacks ${missing.join(", ")}`,
      );
    }
    if (given.attached || [...stubs.values()].includes(given)) {
      throw new RackError("RACK_MANIFEST", `bench: the stub for ${need} serves another need`);
    }
    stubs.set(need, given);
  }
  for (const need of Object.keys(needs)) {
    if (!Object.hasOwn(fru.needs, need)) {
      throw new RackError("RACK_MANIFEST", `bench: ${name} has no need ${need}`);
    }
  }
  return stubs;
}

/**
 * Writes the stub and probe device files, and returns the manifest of the bench's rack: the
 * stubs from slot 1 up, the device above them, and the probe above the device.
 */
async function writeRack(
  dir: string,
  channel: string,
  source: string | URL,
  name: string,
  config: unknown,
  fru: Fru,
) {
  await mkdir(dir, { recursive: true });
  const taken = new Set([name]);
  const unique = (wanted: string, fallback: string) => {
    const base = isDeviceName(wanted) ? wanted : fallback;
    let candidate = base;
    for (let n = 2; taken.has(candidate); n++) candidate = `${base}-${n}`;
    taken.add(candidate);
    return candidate;
  };
  const slots: Record<number, SlotSpec> = {};
  const patch: [string, string][] = [];
  let u = 1;
  let index = 0;
  for (const [need, info] of Object.entries(fru.needs)) {
    index++;
    const stubName = unique(`stub-${need}`, `stub-${index}`);
    const file = join(dir, `stub-${index}.ts`);
    const spec: StubDeviceSpec = {
      channel,
      need,
      connector: { id: info.id, members: info.members },
    };
    await writeFile(file, deviceFile("stubDevice", spec));
    slots[u++] = slot(file, { name: stubName });
    patch.push([`${name}.${need}`, `${stubName}.${need}`]);
  }
  slots[u] = slot(source, { name, config });
  u += fru.height;
  const ports: ProbeDeviceSpec["ports"] = {};
  for (const [port, info] of Object.entries(fru.provides)) {
    const events = Object.entries(info.members)
      .filter(([, kind]) => kind === "event")
      .map(([member]) => member);
    if (events.length > 0) ports[port] = { id: info.id, events };
  }
  if (Object.keys(ports).length > 0) {
    const probeName = unique("probe", "probe");
    const file = join(dir, "probe.ts");
    await writeFile(file, deviceFile("probeDevice", { channel, ports } satisfies ProbeDeviceSpec));
    slots[u++] = slot(file, { name: probeName });
    for (const port of Object.keys(ports)) patch.push([`${probeName}.${port}`, `${name}.${port}`]);
  }
  return rack("bench", { size: Math.max(42, u - 1), slots, patch });
}

/** The two lines of a device file that the bench writes. */
function deviceFile(factory: "stubDevice" | "probeDevice", spec: unknown): string {
  return `import { ${factory} } from "rack42u/bench";\nexport default ${factory}(${JSON.stringify(spec)});\n`;
}

function isDeviceName(name: string): boolean {
  try {
    checkDeviceName(name);
    return true;
  } catch {
    // Not a valid device name: the caller picks another.
    return false;
  }
}

function noEvent(spec: StubDeviceSpec, name: string): RackError {
  return new RackError("RACK_NO_ROUTE", `${spec.connector.id} has no event ${name}`);
}

/** Puts a stream's bytes back into its value, as `make` turns them into what goes there. */
function withStream(
  value: unknown,
  stream: WholeStream | undefined,
  make: (bytes: Uint8Array) => unknown,
) {
  if (stream === undefined) return value;
  if (stream.key === null) return make(stream.bytes);
  return { ...(value as Record<string, unknown>), [stream.key]: make(stream.bytes) };
}

/** A stream of the given bytes, in one chunk. */
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * Reads a stream of a stub's call whole.
 *
 * @throws RackError with `code` beyond {@link STREAM_LIMIT}, or for a chunk that isn't a
 *   `Uint8Array`, after cancelling the stream; or the stream's own error.
 */
async function readWhole(
  stream: ReadableStream<unknown>,
  code: string,
  where: string,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    let problem: RackError | undefined;
    if (!(value instanceof Uint8Array)) {
      problem = new RackError(code, `${where}: a chunk of the stream isn't a Uint8Array`);
    } else if (size + value.byteLength > STREAM_LIMIT) {
      problem = new RackError(
        code,
        `${where}: the stream carries more than 16 MiB, the most a stub's call takes`,
      );
    }
    if (problem !== undefined) {
      reader.cancel(problem).catch(() => {
        // The source failed as it was cancelled; the call fails with the problem either way.
      });
      throw problem;
    }
    const chunk = value as Uint8Array;
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

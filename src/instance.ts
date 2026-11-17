/**
 * The main thread's handle on one device instance: a Worker running `worker.ts`, its control
 * channel, and the main-thread end of its data channel.
 *
 * @decision .agents/decisions/261116_024226-backplane-links.md#channels
 * @decision .agents/decisions/261116_024226-backplane-links.md#in-flight-calls-holding-and-draining
 * @decision .agents/decisions/261116_024226-backplane-links.md#faults-and-resets
 * @decision .agents/decisions/261117_062959-watchdog.md#feeding-and-checking
 */
import type { HookName } from "./device.ts";
import { fromWireError, RackError } from "./errors.ts";
import type { Firmware } from "./firmware.ts";
import type { InstanceMetrics } from "./metrics.ts";
import {
  type ControlNotice,
  type ControlPayload,
  type DataFromWorker,
  type DataToWorker,
  type Fru,
  type LogNotice,
  type Marker,
  SHARED_LENGTH,
  SHARED_LOOP,
  SHARED_SERVING,
  SHARED_WATCHDOGS,
  type WatchdogNotice,
} from "./protocol.ts";

const WORKER_URL = new URL("./worker.ts", import.meta.url).href;

/** Where an instance reports what it receives. */
export interface InstanceHost {
  onData(instance: Instance, message: DataFromWorker): void;
  onLog(instance: Instance, notice: LogNotice): void;
  /** The Worker exited; `deliberate` is `true` when the rack terminated it. */
  onExit(instance: Instance, deliberate: boolean, detail: string): void;
  /** A watchdog of the active instance went `timeout` ms without a feed; it is no longer checked. */
  onBite(instance: Instance, name: string, timeout: number): void;
}

/** A watchdog of an instance, as `status()` reports it. */
export interface WatchdogStatus {
  name: string;
  timeout: number;
  /** When the rack last saw a feed, or began to check, a millisecond timestamp. */
  lastFed: number;
}

/** A wire from one need of an instance to a provider port. */
export interface Wire {
  provider: string;
  port: string;
}

/** A call from outside the rack that the backplane is routing; see `Backplane`. */
export interface RoutedCall {
  readonly id: number;
  settled: boolean;
}

interface Request {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

/** A watchdog the main thread checks: the event loop's, or one the device armed. */
interface WatchdogState {
  readonly name: string;
  readonly timeout: number;
  /** Index of its feed counter in the shared memory. */
  readonly counter: number;
  /** The counter at the last check. */
  seen: number;
  /** Checks in a row that found no feed. */
  missed: number;
  /** When a check last saw a feed, or when checks began, a millisecond timestamp. */
  fedAt: number;
  timer: ReturnType<typeof setInterval> | undefined;
}

/** The checks without a feed after which a watchdog bites; they run four times per timeout. */
const CHECKS_PER_TIMEOUT = 4;

/** One running instance of a device. */
export class Instance {
  readonly firmware: Firmware;
  /** Name of the slot the instance belongs to; the FRU name once booted. */
  slot: string;
  /** FRU data, set after boot. */
  fru: Fru | undefined;
  /** `powerOn` succeeded, so `powerOff` is due. */
  poweredOn = false;
  /** `activate` succeeded and `deactivate` has not run. */
  active = false;
  /** Wiring of this instance's needs; set when the instance is assembled into the rack. */
  wiring = new Map<string, Wire>();
  /** Calls from outside the rack this instance is serving, keyed by backplane call id. */
  readonly inFlight = new Map<number, RoutedCall>();
  /** Set once the Worker has exited. */
  dead = false;

  readonly #worker: Worker;
  readonly #data: MessagePort;
  /** The Worker's end of the data channel, transferred with the boot request. */
  readonly #bootPort: MessagePort;
  /** Shared with the Worker, which counts the calls it serves and the feeds of its watchdogs. */
  readonly #gauge = new Int32Array(
    new SharedArrayBuffer(SHARED_LENGTH * Int32Array.BYTES_PER_ELEMENT),
  );
  /** The timeout of the event-loop watchdog; 0 when watchdogs are off. */
  #loopTimeout = 0;
  /** Watchdogs by the index of their feed counter, in the order they were armed. */
  readonly #watchdogs = new Map<number, WatchdogState>();
  /** The watchdogs are checked: the instance is active. */
  #watching = false;
  /** Settles when the Worker's thread has stopped, which can come later than {@link dead}. */
  readonly #closed = Promise.withResolvers<void>();
  readonly #host: InstanceHost;
  readonly #requests = new Map<number, Request>();
  readonly #drainWaiters = new Set<() => void>();
  #nextId = 1;
  #deliberate = false;
  #lastError = "";

  /**
   * Starts a Worker for the firmware. The Worker gets a copy of the environment as it is now.
   *
   * @param firmware The firmware to boot later with {@link boot}.
   * @param slot Name of the slot, or the planned name when the model will decide it.
   * @param host Receiver for data messages, logs, and exits.
   */
  constructor(firmware: Firmware, slot: string, host: InstanceHost) {
    this.firmware = firmware;
    this.slot = slot;
    this.#host = host;
    // Bun Workers otherwise see the environment of process start, not of this moment.
    // @decision .agents/decisions/261112_043034-device-api.md#device-context
    this.#worker = new Worker(WORKER_URL, { env: { ...process.env } as Record<string, string> });
    const channel = new MessageChannel();
    this.#data = channel.port1;
    this.#bootPort = channel.port2;
    this.#worker.addEventListener("message", (event: MessageEvent<ControlNotice>) =>
      this.#onControl(event.data),
    );
    this.#worker.addEventListener("error", (event: ErrorEvent) => {
      this.#lastError = event.message;
    });
    this.#worker.addEventListener("close", (event: Event) => {
      const code = (event as CloseEvent).code;
      this.#closed.resolve();
      this.#exit(`exited with code ${code}${this.#lastError ? `: ${this.#lastError}` : ""}`);
    });
    this.#data.addEventListener("message", (event) => {
      if (!this.dead) this.#host.onData(this, (event as MessageEvent<DataFromWorker>).data);
    });
    this.#data.start();
  }

  /** Calls the instance is serving, from links and from outside the rack. */
  get serving(): number {
    return Atomics.load(this.#gauge, SHARED_SERVING);
  }

  /** The instance's watchdogs, the event loop's first; none when watchdogs are off. */
  get watchdogs(): WatchdogStatus[] {
    return [...this.#watchdogs.values()].map(({ name, timeout, fedAt }) => ({
      name,
      timeout,
      lastFed: fedAt,
    }));
  }

  /** The longest timeout among the instance's watchdogs, or 0 when it has none. */
  get longestWatchdog(): number {
    let longest = 0;
    for (const { timeout } of this.#watchdogs.values()) longest = Math.max(longest, timeout);
    return longest;
  }

  /**
   * Loads the firmware in the Worker and reads its FRU data.
   *
   * @throws RackError from the Worker, or `RACK_INVALID_CONFIG` when the config cannot be cloned.
   */
  async boot(options: {
    name: string | undefined;
    u: number;
    config: unknown;
    baseDir: string;
    callTimeout: number;
    /** Timeout of the event-loop watchdog, or 0 to check no watchdogs. */
    watchdog: number;
    timeout: number;
  }): Promise<Fru> {
    this.#loopTimeout = options.watchdog;
    if (options.watchdog > 0) this.#addWatchdog(SHARED_LOOP, "event loop", options.watchdog);
    const fru = (await this.request(
      {
        op: "boot",
        firmware: this.firmware.url,
        hash: this.firmware.hash,
        source: this.firmware.source,
        name: options.name,
        u: options.u,
        config: options.config,
        baseDir: options.baseDir,
        callTimeout: options.callTimeout,
        gauge: this.#gauge.buffer as SharedArrayBuffer,
        watchdog: options.watchdog,
        port: this.#bootPort,
      },
      options.timeout,
      "boot",
      [this.#bootPort],
    )) as Fru;
    this.fru = fru;
    this.slot = fru.name;
    return fru;
  }

  /**
   * Loads the firmware and reads what the device declares, without a configuration or a context.
   * The instance can only be terminated afterwards.
   *
   * @decision .agents/decisions/261116_233919-automatic-assembly.md#scanned-manifests
   * @throws RackError `RACK_MANIFEST` when the firmware does not default-export a device, or
   *   `RACK_HOOK_FAILED` when the Worker does not answer within `timeout` ms.
   */
  async describe(timeout: number): Promise<Fru> {
    return (await this.request(
      { op: "describe", firmware: this.firmware.url, source: this.firmware.source },
      timeout,
      "describe",
    )) as Fru;
  }

  /**
   * Runs a lifecycle hook in the Worker. The watchdogs are checked from the end of `activate` to
   * the start of `deactivate`.
   *
   * @returns The hook's result (the state, for `snapshot`).
   * @throws RackError `RACK_HOOK_FAILED` when the hook fails, times out, or the instance dies.
   */
  async hook(
    hook: HookName,
    timeout: number,
    extra: { state?: unknown; from?: string } = {},
  ): Promise<unknown> {
    // @decision .agents/decisions/261117_062959-watchdog.md#two-kinds-of-watchdog
    if (hook === "deactivate") this.#unwatch();
    try {
      const value = await this.request({ op: "hook", hook, ...extra }, timeout, hook);
      if (hook === "activate") this.#watch();
      return value;
    } catch (error) {
      const cause =
        error instanceof RackError ? error : new RackError("RACK_HOOK_FAILED", String(error));
      if (cause.code === "RACK_HOOK_FAILED") throw cause;
      throw new RackError("RACK_HOOK_FAILED", `${this.slot}: ${hook} failed: ${cause.message}`, {
        hook,
        cause: { code: cause.code, message: cause.message },
      });
    }
  }

  /**
   * Sends a control-channel request and waits for its reply.
   *
   * @param transfer Ports that move to the Worker with the request.
   * @throws RackError from the Worker; `RACK_HOOK_FAILED` after `timeout` ms;
   *   `RACK_DEVICE_FAULT` when the instance is gone or dies first; `RACK_INVALID_CONFIG` when
   *   the request cannot be cloned, which only the boot config can cause.
   */
  request(
    message: ControlPayload,
    timeout: number,
    what: string = message.op,
    transfer: Bun.Transferable[] = [],
  ): Promise<unknown> {
    if (this.dead) {
      return Promise.reject(new RackError("RACK_DEVICE_FAULT", `${this.slot}: instance is gone`));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#requests.delete(id);
        reject(
          new RackError("RACK_HOOK_FAILED", `${this.slot}: ${what} timed out after ${timeout} ms`),
        );
      }, timeout);
      this.#requests.set(id, { resolve, reject, timer });
      try {
        this.#worker.postMessage({ ...message, id }, transfer);
      } catch {
        // DataCloneError: only the boot config comes from outside the framework.
        clearTimeout(timer);
        this.#requests.delete(id);
        reject(new RackError("RACK_INVALID_CONFIG", `${this.slot}: config cannot be cloned`));
      }
    });
  }

  /**
   * Reads the instance's call and event counters.
   *
   * @throws RackError when the instance is gone or does not answer within `timeout` ms.
   */
  async metrics(timeout: number): Promise<InstanceMetrics> {
    return (await this.request({ op: "metrics" }, timeout)) as InstanceMetrics;
  }

  /**
   * Posts a data-channel message to the Worker.
   *
   * @param transfer Buffers to move with the message instead of copying them.
   * @throws DataCloneError when the message cannot be cloned; no buffer is detached then.
   */
  post(message: DataToWorker, transfer?: ArrayBuffer[]): void {
    if (this.dead) return;
    if (transfer === undefined) this.#data.postMessage(message);
    else this.#data.postMessage(message, transfer);
  }

  /**
   * Waits until every hold marker in `markers` has reached the instance and it serves no call,
   * from links or from outside the rack.
   *
   * @returns `true` once drained, `false` after `timeout` ms.
   */
  async drain(timeout: number, markers: Marker[] = []): Promise<boolean> {
    if (this.dead) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeout);
    });
    const drained = (async () => {
      try {
        await this.request({ op: "drain", markers }, timeout);
      } catch {
        // The instance died, which ends its calls too, or it did not answer in time.
        if (!this.dead) return false;
      }
      await this.#externalDrained();
      return true;
    })();
    try {
      return await Promise.race([drained, expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Wakes {@link drain} waiters when no call from outside the rack is in flight any more. */
  checkDrained(): void {
    if (this.inFlight.size > 0) return;
    for (const done of [...this.#drainWaiters]) done();
    this.#drainWaiters.clear();
  }

  /** Terminates the Worker on purpose; the exit is not treated as a crash. */
  terminate(): void {
    if (this.dead) return;
    this.#deliberate = true;
    this.#worker.terminate();
    this.#exit("terminated by the rack");
  }

  /**
   * Terminates the Worker of a hung instance, as {@link terminate} does: the instance is gone at
   * once. A Worker that hangs in JavaScript stops within milliseconds, but one blocked in native
   * code only when that call returns.
   *
   * @returns Whether the Worker's thread stopped within `timeout` ms.
   */
  async kill(timeout: number): Promise<boolean> {
    this.terminate();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeout);
    });
    try {
      return await Promise.race([this.#closed.promise.then(() => true), expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  #externalDrained(): Promise<void> {
    if (this.inFlight.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.#drainWaiters.add(resolve));
  }

  #onControl(notice: ControlNotice): void {
    if ("op" in notice) {
      if (notice.op === "watchdog") this.#onWatchdog(notice);
      else this.#host.onLog(this, notice);
      return;
    }
    const request = this.#requests.get(notice.id);
    if (request === undefined) return;
    this.#requests.delete(notice.id);
    clearTimeout(request.timer);
    if (notice.ok) request.resolve(notice.value);
    else request.reject(fromWireError(notice.error));
  }

  // ---- Watchdogs ----

  /** The device armed a watchdog, or cancelled one. */
  #onWatchdog(notice: WatchdogNotice): void {
    const counter = SHARED_WATCHDOGS + notice.index;
    this.#stopChecking(this.#watchdogs.get(counter));
    this.#watchdogs.delete(counter);
    if (notice.armed === undefined || this.#loopTimeout === 0 || this.dead) return;
    const watchdog = this.#addWatchdog(counter, notice.armed.name, notice.armed.timeout);
    if (this.#watching) this.#startChecking(watchdog);
  }

  #addWatchdog(counter: number, name: string, timeout: number): WatchdogState {
    const watchdog: WatchdogState = {
      name,
      timeout,
      counter,
      seen: 0,
      missed: 0,
      fedAt: Date.now(),
      timer: undefined,
    };
    this.#watchdogs.set(counter, watchdog);
    return watchdog;
  }

  #watch(): void {
    if (this.#watching || this.#loopTimeout === 0 || this.dead) return;
    this.#watching = true;
    for (const watchdog of this.#watchdogs.values()) this.#startChecking(watchdog);
  }

  #unwatch(): void {
    this.#watching = false;
    for (const watchdog of this.#watchdogs.values()) this.#stopChecking(watchdog);
  }

  #startChecking(watchdog: WatchdogState): void {
    this.#stopChecking(watchdog);
    watchdog.seen = Atomics.load(this.#gauge, watchdog.counter);
    watchdog.missed = 0;
    watchdog.fedAt = Date.now();
    // Counting checks instead of comparing clocks keeps a change of the system clock, or a busy
    // main thread, from making a watchdog bite early.
    const timer = setInterval(() => this.#check(watchdog), watchdog.timeout / CHECKS_PER_TIMEOUT);
    timer.unref();
    watchdog.timer = timer;
  }

  #stopChecking(watchdog: WatchdogState | undefined): void {
    if (watchdog?.timer === undefined) return;
    clearInterval(watchdog.timer);
    watchdog.timer = undefined;
  }

  #check(watchdog: WatchdogState): void {
    const count = Atomics.load(this.#gauge, watchdog.counter);
    if (count !== watchdog.seen) {
      watchdog.seen = count;
      watchdog.missed = 0;
      watchdog.fedAt = Date.now();
      return;
    }
    watchdog.missed++;
    if (watchdog.missed < CHECKS_PER_TIMEOUT) return;
    this.#unwatch();
    this.#host.onBite(this, watchdog.name, watchdog.timeout);
  }

  #exit(detail: string): void {
    if (this.dead) return;
    this.#unwatch();
    this.dead = true;
    for (const request of this.#requests.values()) {
      clearTimeout(request.timer);
      request.reject(new RackError("RACK_DEVICE_FAULT", `${this.slot}: instance ${detail}`));
    }
    this.#requests.clear();
    this.#data.close();
    this.#host.onExit(this, this.#deliberate, detail);
  }
}

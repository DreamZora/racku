/**
 * The rack runtime: assembly, power sequencing, swaps, crash resets, and the rack handle.
 *
 * The main thread only builds firmware, runs Workers, sets up the links between them, and routes
 * calls from outside the rack; it never imports device code.
 *
 * @decision .agents/decisions/261112_035942-rack-architecture.md#gravity-rule
 * @decision .agents/decisions/261112_035943-hot-swap.md#the-swap-sequence
 * @decision .agents/decisions/261112_035943-hot-swap.md#the-main-thread-never-loads-device-code
 * @decision .agents/decisions/261116_024226-backplane-links.md#wiring-and-routing
 * @decision .agents/decisions/261116_024226-backplane-links.md#faults-and-resets
 * @decision .agents/decisions/261116_035534-call-metrics.md#reading
 * @decision .agents/decisions/261112_043034-device-api.md#rack-runtime
 * @decision .agents/decisions/261115_222025-p0-api-details.md#rack-handle
 * @decision .agents/decisions/261115_222025-p0-api-details.md#error-codes
 * @decision .agents/decisions/261115_222025-p0-api-details.md#resets
 * @decision .agents/decisions/261116_233919-automatic-assembly.md#scanned-manifests
 * @decision .agents/decisions/261116_233919-automatic-assembly.md#plan-file
 * @decision .agents/decisions/261116_233956-cold-swaps-and-restarts.md#three-ways-to-replace-an-instance
 * @decision .agents/decisions/261117_005743-fallback-rollback-and-history.md#update-history
 * @decision .agents/decisions/261117_062959-watchdog.md#biting
 * @decision .agents/decisions/261117_063228-bounded-backlogs.md#bounded-calls
 * @decision .agents/decisions/261117_185131-ending-instances.md#ending-an-instance
 * @decision .agents/decisions/261117_185131-ending-instances.md#stuck-threads
 * @decision .agents/decisions/261117_185131-ending-instances.md#failed-hot-swaps
 * @decision .agents/decisions/261117_185225-outside-call-metrics.md#decision
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Dirent } from "node:fs";
import { readdir, unlink } from "node:fs/promises";
import { basename, join, resolve as resolvePath } from "node:path";
import { Backplane, type Slot, type SlotState } from "./backplane.ts";
import type { ConnectorInfo } from "./connector.ts";
import { type Control, openControl } from "./control.ts";
import type { CallOptions } from "./device.ts";
import { RackError, toWireError, type WireError } from "./errors.ts";
import { buildFirmware as buildBundle, type Firmware } from "./firmware.ts";
import {
  Instance,
  type InstanceHost,
  timedOut,
  type WatchdogStatus,
  type Wire,
} from "./instance.ts";
import { consoleLogger, type LogEntry, type Logger } from "./log.ts";
import {
  checkDeviceName,
  isRackManifest,
  isSlotSpec,
  slot as mountSpec,
  parseAddress,
  type RackManifest,
  type ScanSpec,
  type SlotSpec,
} from "./manifest.ts";
import type { DeviceMetrics, RackMetrics } from "./metrics.ts";
import { openHttpPanel, type Panel } from "./panel.ts";
import {
  fitPlan,
  formatPlan,
  makePlan,
  type Plan,
  type PlannedInstance,
  type PlanType,
  parsePlan,
} from "./plan.ts";
import {
  type DataFromWorker,
  type Fru,
  type LogNotice,
  type Marker,
  QUEUE_LIMIT,
  WATCHDOG_MIN,
} from "./protocol.ts";
import { detach, transferList } from "./transfer.ts";

export type { SlotState } from "./backplane.ts";

/** State of one device, as returned by {@link RackHandle.status}. */
export interface SlotStatus {
  name: string;
  model: string;
  u: number;
  height: number;
  state: SlotState;
  /** Firmware hash of the installed instance; `null` when none is installed. */
  firmware: string | null;
  /** Absolute path of the device file. */
  source: string;
  /** Calls the installed instance is processing, from other devices and from outside the rack. */
  inFlight: number;
  /** Crashes within the last 60 seconds. */
  crashes: number;
  /** For a copy that serves an `own` need: the instance whose need it serves. */
  owner?: string;
  /** Hash of the firmware the device falls back to when a new instance crashes on probation. */
  knownGood: string | null;
  /** While the installed instance is on probation: when probation ends, a millisecond timestamp. */
  probationUntil?: number;
  /**
   * The installed instance's watchdogs, the event loop's first; empty when watchdogs are off or
   * no instance is installed.
   */
  watchdogs: WatchdogStatus[];
  /**
   * Threads of the device's earlier instances that didn't stop within `hookTimeout` of their
   * termination, stuck in native code. No other instance of the device starts until they stop.
   */
  stuck: StuckThread[];
  /** The last failed swap or crash. */
  error?: WireError;
}

/**
 * A thread of an ended instance that is still running, stuck in native code.
 *
 * @decision .agents/decisions/261117_185131-ending-instances.md#observation
 */
export interface StuckThread {
  /** Firmware hash of the instance. */
  firmware: string;
  /** When the rack terminated the instance, a millisecond timestamp. */
  since: number;
}

/** What a management operation did to a device. */
export type SwapAction = "plug" | "unplug" | "swap";

/**
 * How an instance was replaced: a `hot` swap overlaps the old and the new instance, a `cold`
 * swap stops the old one first, and a `restart` also starts the new one without the old state.
 */
export type ReloadMode = "hot" | "cold" | "restart" | "plug" | "unplug";

/** An event of the rack, delivered to {@link RackHandle.subscribe} listeners. */
export type RackEvent =
  | { type: "power"; device: string; firmware: string; state: "on" | "off" }
  | {
      type: "swap";
      device: string;
      action: SwapAction;
      mode: ReloadMode;
      from: string | null;
      to: string | null;
      error?: WireError;
    }
  | { type: "fault"; device: string; firmware: string; error: WireError; reset: boolean }
  | ({ type: "log" } & LogEntry);

/** One device that {@link RackHandle.reload} or {@link RackHandle.restart} tried to replace. */
export interface ReloadResult {
  device: string;
  from: string | null;
  to: string | null;
  mode: ReloadMode;
  error?: WireError;
}

/** What asked for an update. */
export type UpdateCause =
  | "reload"
  | "swap"
  | "restart"
  | "rollback"
  | "fallback"
  | "plug"
  | "unplug";

/** One update of a device, as {@link RackHandle.history} reports it. */
export interface UpdateRecord {
  /** Increases by one per record within the rack process. */
  seq: number;
  /** When the operation that made the update started, a millisecond timestamp. */
  time: number;
  device: string;
  mode: ReloadMode;
  cause: UpdateCause;
  /** Firmware hash before the update. */
  from: string | null;
  /** Firmware hash the update installed, or tried to install. */
  to: string | null;
  ok: boolean;
  /** Why the update failed, or why the device fell back. */
  error?: WireError;
  /** `seq` of the first record of the same group replacement. */
  group?: number;
}

/** Options of {@link RackHandle.rollback}. */
export interface RollbackOptions {
  /** Firmware hash to go back to; by default, the firmware before the current one. */
  to?: string;
}

/** Options of {@link RackHandle.restart}. */
export interface RestartOptions {
  /** Reload the device's direct consumers after it restarts; default `true`. */
  cascade?: boolean;
}

/** Options of {@link start}. */
export interface StartOptions {
  /** Base directory: relative slot paths resolve against it; defaults to the working directory. */
  baseDir?: string;
  /** Receives every log entry; defaults to one console line per entry. */
  logger?: Logger;
  /** Timeout of calls that set none, in ms; default 30 000. */
  callTimeout?: number;
  /** Timeout of boot, of each lifecycle hook, and of each metrics request, in ms; default 30 000. */
  hookTimeout?: number;
  /** How long retiring instances may finish their calls, in ms; default 10 000. */
  drainTimeout?: number;
  /**
   * How a scanned rack uses its plan file, `<rack name>.plan` in the base directory:
   * - `true`, the default: follow the file while it fits the dependency graph, write it when it
   *   is missing, and refuse to start when it no longer fits.
   * - `"update"`: rewrite the file whenever the graph and the priorities give another plan, as
   *   `rack dev` does.
   * - `false`: neither read nor write it; the graph and the priorities alone give the plan.
   *
   * A rack whose manifest places devices by hand has no plan file and ignores this option.
   */
  plan?: boolean | "update";
  /**
   * How long a new instance stays on probation after an update, in ms; default 60 000. A crash
   * during probation falls back to the device's known-good firmware. 0 turns fallback off.
   */
  probation?: number;
  /** Most update records the history keeps, a positive integer; default 256. */
  historyLimit?: number;
  /**
   * The most calls a need of a device has unfinished, sent or held, and the most events that wait
   * for one subscriber, a positive integer; default 10 000. Calls from outside the rack are
   * counted per device. A call beyond the limit fails at once with `RACK_OVERLOADED`; an event
   * beyond it is dropped for that subscriber and counted in `dropped`.
   */
  queueLimit?: number;
  /**
   * Timeout of every device's event-loop watchdog, in ms, at least 1 000; default 10 000. A
   * device whose event loop stays blocked that long, or whose own watchdog goes unfed for its
   * timeout, is reset as after a crash. 0 turns off every watchdog, for example while a debugger
   * holds devices at breakpoints.
   */
  watchdog?: number;
  /**
   * Opens the management endpoint that `rack ctl` uses, once the rack runs: `true` for the
   * platform's default, a Unix socket on Linux and macOS and loopback TCP on Windows, or
   * `{ port }` for loopback TCP with a bearer token, `token` or `RACK_CONTROL_TOKEN` or a random
   * one. Its `stop` operation stops the rack. `rack start` and `rack dev` open one of their own.
   */
  control?: boolean | { port?: number; token?: string };
}

/** A running rack. */
export interface RackHandle {
  /** One entry per device, ordered by slot from the bottom up; empty after `stop()`. */
  status(): SlotStatus[];
  /**
   * Calls an RPC member of a port from outside the rack.
   *
   * @param address `<device>.<port>`.
   * @throws RackError `RACK_NO_ROUTE` for an unknown address or member, `RACK_LINK_DOWN` when
   *   the device is offline or the rack is stopped, or the error the call produced.
   */
  call(address: string, method: string, input: unknown, options?: CallOptions): Promise<unknown>;
  /**
   * Rebuilds every firmware and replaces only the devices whose hash changed: with a hot swap,
   * with a cold swap for devices that declare `swap: "cold"`, or as a group with the consumers
   * of a contract that changed. Results come bottom up; a failed device carries `error`.
   *
   * A scanned rack also works its plan out again and moves to it: devices are plugged, moved,
   * rewired, and unplugged as the plan says. With `manifest`, the rack takes over an edited
   * manifest the same way, as `rack dev` does when the manifest file changes.
   *
   * @throws RackError `RACK_SWAP_REJECTED` when the plan file of a rack run by `rack start` no
   *   longer fits, or when the manifest changes the rack's name, kind, or panel port.
   */
  reload(manifest?: RackManifest): Promise<ReloadResult[]>;
  /**
   * Stops a device completely and starts it again from scratch, rebuilt from its file and
   * without its state; then its direct consumers reload to adapt to it, keeping their state.
   *
   * @param name The device.
   * @param options `cascade: false` leaves the consumers running.
   * @returns One result per device replaced, in order.
   * @throws RackError `RACK_NO_ROUTE` for an unknown device, or `RACK_SWAP_REJECTED` when the
   *   device cannot be rebuilt, does not fit, or fails to start; its slot then resets.
   */
  restart(name: string, options?: RestartOptions): Promise<ReloadResult[]>;
  /**
   * Replaces a device's firmware with an earlier one that the history still keeps, choosing
   * the kind of replacement as `reload()` does. Undoing a group replacement replaces the group.
   *
   * @param name The device.
   * @param options `to` names the firmware hash; by default, the firmware before the current one.
   * @returns One result per device replaced.
   * @throws RackError `RACK_NO_ROUTE` for an unknown device, or `RACK_SWAP_REJECTED` when there
   *   is no such firmware, it no longer fits the running plan, or the replacement fails.
   */
  rollback(name: string, options?: RollbackOptions): Promise<ReloadResult[]>;
  /**
   * Reads the update history, newest first: every swap, cold swap, restart, group replacement,
   * plug, unplug, rollback, and fallback, whether it succeeded or failed. The rack keeps at most
   * `historyLimit` records, in memory.
   *
   * @param name Only the records of this device.
   */
  history(name?: string): UpdateRecord[];
  /**
   * Replaces a device, optionally with another device file; rolls back on failure.
   *
   * @throws RackError `RACK_NO_ROUTE`, `RACK_SWAP_REJECTED`, `RACK_MANIFEST`,
   *   `RACK_INVALID_CONFIG`, or `RACK_HOOK_FAILED`.
   */
  swap(name: string, source?: string | URL): Promise<void>;
  /**
   * Plugs a device into slot `u`.
   *
   * @throws RackError `RACK_MANIFEST` for layout and wiring problems, `RACK_SWAP_REJECTED`,
   *   `RACK_INVALID_CONFIG`, or `RACK_HOOK_FAILED`.
   */
  plug(u: number, spec: SlotSpec): Promise<void>;
  /**
   * Unplugs a device that nothing uses.
   *
   * @throws RackError `RACK_NO_ROUTE` or `RACK_SWAP_REJECTED`.
   */
  unplug(name: string): Promise<void>;
  /** Adds a listener; returns a function that removes it. */
  subscribe(listener: (event: RackEvent) => void): () => void;
  /**
   * Reads the call and event counters of every installed instance over the management bus.
   * Counters start at zero when an instance boots, so they restart when a device swaps or
   * resets.
   *
   * @returns One entry per device whose installed instance answered within `hookTimeout`,
   *   ordered by slot from the bottom up; no entries after `stop()`.
   */
  metrics(): Promise<RackMetrics>;
  /** Closes the panel and powers devices off from the top down. */
  stop(): Promise<void>;
}

const CRASH_WINDOW = 60_000;
const CRASH_LIMIT = 3;

/**
 * The window of the crash limit: 60 s, or four times the longest watchdog timeout if that is
 * longer, so that a device that hangs again after every reset still reaches the limit.
 *
 * @decision .agents/decisions/261117_062959-watchdog.md#biting
 * @param longestWatchdog The longest watchdog timeout of the device, in ms; 0 for none.
 * @returns The window in ms.
 */
export function crashWindow(longestWatchdog: number): number {
  return Math.max(CRASH_WINDOW, 4 * longestWatchdog);
}

/**
 * Starts a rack: builds the firmware, boots and checks every device, powers them on from the
 * bottom up, and opens the panel.
 *
 * @param manifest A manifest created by `rack()`.
 * @param options Base directory, logger, and timeouts.
 * @returns The rack handle.
 * @throws RackError `RACK_MANIFEST`, `RACK_INVALID_CONFIG`, or `RACK_HOOK_FAILED`; devices
 *   that were already powered on are powered off again first.
 */
export async function start(
  manifest: RackManifest,
  options: StartOptions = {},
): Promise<RackHandle> {
  if (!isRackManifest(manifest)) {
    throw new RackError("RACK_MANIFEST", "start() requires a manifest created by rack()");
  }
  const rack = new Rack(manifest, options);
  await rack.start();
  return rack.handle();
}

type Phase = "starting" | "running" | "stopping" | "stopped";

interface Layout {
  name: string;
  u: number;
  height: number;
}

class Rack implements InstanceHost {
  #manifest: RackManifest;
  readonly #baseDir: string;
  readonly #logger: Logger;
  readonly #callTimeout: number;
  readonly #hookTimeout: number;
  readonly #drainTimeout: number;
  readonly #planMode: boolean | "update";
  /** Patches in effect: the manifest's, or the wiring of a scanned rack's plan. */
  #patch: ReadonlyArray<readonly [string, string]>;
  /** The plan a scanned rack runs. */
  #plan: Plan | undefined;
  /** FRU data of firmware described for planning, by hash. */
  readonly #described = new Map<string, Fru>();
  readonly #probationMs: number;
  readonly #historyLimit: number;
  /** Timeout of the event-loop watchdogs, or 0 when watchdogs are off. */
  readonly #watchdog: number;
  /** The most unfinished calls of a need, or from outside the rack to a device. */
  readonly #queueLimit: number;
  /** Update records, oldest first, at most `#historyLimit`. */
  readonly #history: UpdateRecord[] = [];
  #seq = 0;
  /** Each device's known-good firmware, by device name. */
  readonly #knownGood = new Map<string, Firmware>();
  /** Devices on probation, by name, with the devices that fall back together with them. */
  readonly #probation = new Map<
    string,
    { until: number; timer: ReturnType<typeof setTimeout>; group: readonly string[] }
  >();
  /** Bundles this rack built, by path; only these are ever deleted. */
  readonly #built = new Map<string, Firmware>();
  /** Every firmware this rack knows of, by hash, for rollbacks. */
  readonly #firmwares = new Map<string, Firmware>();
  readonly #slots = new Map<string, Slot>();
  readonly #backplane: Backplane;
  readonly #listeners = new Set<(event: RackEvent) => void>();
  /** Every instance whose Worker has not exited. */
  readonly #instances = new Set<Instance>();
  /** Instances being ended, until their thread stops or turns out stuck; see {@link #end}. */
  readonly #ending = new Map<Instance, Ending>();
  /** Threads of ended instances that didn't stop within `hookTimeout`, until they stop. */
  readonly #stuck = new Map<Instance, Stuck>();
  #phase: Phase = "starting";
  readonly #controlOption: StartOptions["control"];
  #control: Control | undefined;
  #startFault: RackError | undefined;
  #panel: Panel | undefined;
  #operations: Promise<unknown> = Promise.resolve();

  constructor(manifest: RackManifest, options: StartOptions) {
    this.#manifest = manifest;
    this.#baseDir = resolvePath(options.baseDir ?? process.cwd());
    this.#logger = options.logger ?? consoleLogger;
    this.#callTimeout = positive("callTimeout", options.callTimeout ?? 30_000);
    this.#hookTimeout = positive("hookTimeout", options.hookTimeout ?? 30_000);
    this.#drainTimeout = positive("drainTimeout", options.drainTimeout ?? 10_000);
    this.#planMode = options.plan ?? true;
    if (this.#planMode !== true && this.#planMode !== false && this.#planMode !== "update") {
      throw new RackError("RACK_MANIFEST", 'start option plan must be true, false, or "update"');
    }
    this.#patch = manifest.patch;
    this.#controlOption = options.control;
    this.#probationMs = options.probation ?? 60_000;
    if (!(Number.isFinite(this.#probationMs) && this.#probationMs >= 0)) {
      throw new RackError("RACK_MANIFEST", "start option probation must be a number >= 0");
    }
    this.#historyLimit = options.historyLimit ?? 256;
    if (!(Number.isSafeInteger(this.#historyLimit) && this.#historyLimit >= 1)) {
      throw new RackError("RACK_MANIFEST", "start option historyLimit must be a positive integer");
    }
    this.#watchdog = options.watchdog ?? 10_000;
    if (
      !(this.#watchdog === 0 || (Number.isFinite(this.#watchdog) && this.#watchdog >= WATCHDOG_MIN))
    ) {
      throw new RackError(
        "RACK_MANIFEST",
        `start option watchdog must be 0 or at least ${WATCHDOG_MIN} ms`,
      );
    }
    this.#queueLimit = options.queueLimit ?? QUEUE_LIMIT;
    if (!(Number.isSafeInteger(this.#queueLimit) && this.#queueLimit >= 1)) {
      throw new RackError("RACK_MANIFEST", "start option queueLimit must be a positive integer");
    }
    this.#backplane = new Backplane(
      this.#slots,
      this.#instances,
      this.#callTimeout,
      this.#hookTimeout,
      this.#queueLimit,
    );
  }

  handle(): RackHandle {
    return Object.freeze({
      status: () => this.#status(),
      call: (address: string, method: string, input: unknown, options: CallOptions = {}) =>
        this.#phase === "running"
          ? this.#backplane.call(address, method, input, options, "rack")
          : refuse(`${address}.${method}`, options),
      reload: (manifest?: RackManifest) => this.#operate("reload", () => this.#reload(manifest)),
      swap: (name: string, source?: string | URL) =>
        this.#operate("swap", () => this.#swap(name, source)),
      restart: (name: string, options: RestartOptions = {}) =>
        this.#operate("restart", () => this.#restart(name, options.cascade ?? true)),
      rollback: (name: string, options: RollbackOptions = {}) =>
        this.#operate("rollback", () => this.#rollback(name, options.to)),
      history: (name?: string) =>
        this.#history.filter((record) => name === undefined || record.device === name).reverse(),
      plug: (u: number, spec: SlotSpec) => this.#operate("plug", () => this.#plug(u, spec)),
      unplug: (name: string) => this.#operate("unplug", () => this.#unplug(name)),
      subscribe: (listener: (event: RackEvent) => void) => {
        this.#listeners.add(listener);
        return () => {
          this.#listeners.delete(listener);
        };
      },
      stop: () => this.#serialize(() => this.#stop()),
      metrics: () => this.#metrics(),
    });
  }

  // ---- Instance host ----

  onData(instance: Instance, message: DataFromWorker): void {
    this.#backplane.onData(instance, message);
  }

  onLog(instance: Instance, notice: LogNotice): void {
    this.#log(notice.level, notice.message, notice.data, instance.slot);
  }

  onExit(instance: Instance, deliberate: boolean, detail: string): void {
    this.#instances.delete(instance);
    const message = `${instance.slot}: instance ${detail}`;
    this.#backplane.disconnect(
      instance,
      deliberate ? "RACK_LINK_DOWN" : "RACK_DEVICE_FAULT",
      message,
    );
    if (deliberate) return;
    this.#log("error", `${instance.slot} crashed: ${detail}`, {
      firmware: instance.firmware.hash,
    });
    if (this.#phase === "starting") {
      this.#startFault ??= new RackError("RACK_DEVICE_FAULT", message);
      return;
    }
    const slot = this.#slots.get(instance.slot);
    if (this.#phase !== "running" || slot === undefined || slot.installed !== instance) return;
    slot.installed = null;
    instance.active = false;
    this.#crashed(slot, instance, { code: "RACK_DEVICE_FAULT", message });
  }

  /**
   * A watchdog of an active instance bit. Its calls fail at once and the instance is gone, as
   * after a crash, but the slot recovers only once the Worker's thread has stopped, so that two
   * instances of the device never run at the same time. A thread blocked in native code that
   * doesn't stop within `hookTimeout` leaves the slot faulted.
   *
   * @decision .agents/decisions/261117_062959-watchdog.md#biting
   */
  onBite(instance: Instance, name: string, timeout: number): void {
    const message = `${instance.slot}: watchdog "${name}" was not fed for ${timeout} ms`;
    const error: WireError = {
      code: "RACK_DEVICE_FAULT",
      message,
      data: { watchdog: name, timeout },
    };
    this.#log("error", message, { firmware: instance.firmware.hash });
    // Fail the calls in flight with the code of a crash before the exit reports the rest.
    this.#backplane.disconnect(instance, "RACK_DEVICE_FAULT", message);
    const stopped = this.#end(instance, instance.slot);
    if (this.#phase === "starting") {
      this.#startFault ??= new RackError("RACK_DEVICE_FAULT", message, error.data);
      return;
    }
    const slot = this.#slots.get(instance.slot);
    if (this.#phase !== "running" || slot === undefined || slot.installed !== instance) return;
    slot.installed = null;
    instance.active = false;
    if (slot.busy) {
      // A running swap installs its new instance, or resets the slot when it fails.
      this.#crashed(slot, instance, error);
      return;
    }
    slot.busy = true;
    slot.state = "resetting";
    slot.error = error;
    // While the rack waits, probation must not run out and make the firmware known-good.
    const group = this.#probation.get(slot.name)?.group ?? [];
    for (const name of group) clearTimeout(this.#probation.get(name)?.timer);
    void stopped.then((closed) => {
      slot.busy = false;
      if (this.#phase !== "running" || slot.removed || slot.installed !== null) return;
      if (closed) {
        this.#crashed(slot, instance, error);
        return;
      }
      for (const name of group) this.#endProbation(name);
      slot.state = "faulted";
      this.#emit({
        type: "fault",
        device: slot.name,
        firmware: instance.firmware.hash,
        error,
        reset: false,
      });
      this.#log(
        "error",
        `${slot.name} faulted: its Worker did not stop within ${this.#hookTimeout} ms of the watchdog, so its thread is stuck in native code. A swap or a restart brings the device back once the thread stops; only a restart of the rack reclaims a thread that never stops.`,
      );
    });
  }

  /**
   * Recovers a slot whose instance crashed or bit: counts the crash, then falls back while on
   * probation, or resets from the same firmware within the crash limit.
   */
  #crashed(slot: Slot, instance: Instance, error: WireError): void {
    slot.longestWatchdog = instance.longestWatchdog;
    const reset = this.#countCrash(slot, instance.firmware.hash, error);
    const probation = this.#probation.get(slot.name);
    if (probation !== undefined) {
      // A crash on probation falls back to the known-good firmware instead of resetting.
      // @decision .agents/decisions/261117_005743-fallback-rollback-and-history.md#passive-fallback
      for (const name of probation.group) this.#endProbation(name);
      if (!reset || slot.busy) return;
      if (probation.group.length > 1) {
        slot.state = "resetting";
        void this.#operate("fallback", () =>
          this.#fallBackGroup(probation.group, slot.name, error),
        );
      } else {
        const context = { cause: "fallback" as const, started: Date.now(), crash: error };
        void updates.run(context, () => this.#fallBack(slot, error));
      }
      return;
    }
    // A running swap installs its new instance, or resets the slot when it fails.
    // @decision .agents/decisions/261115_222025-p0-api-details.md#resets
    if (reset && !slot.busy) void this.#reset(slot);
  }

  // ---- Start and stop ----

  async start(): Promise<void> {
    try {
      const planText = await this.#prepare();
      if (planText !== undefined) await Bun.write(this.#planPath(), planText);
      for (const slot of this.#ordered()) {
        const instance = slot.installed as Instance;
        // Links to the devices below exist already; this links the devices above to it.
        await this.#backplane.connect(instance);
        await this.#backplane.install(slot, instance, null);
        await this.#powerOn(instance);
        this.#throwStartFault();
        slot.state = "online";
        this.#powered(instance);
      }
      this.#throwStartFault();
      const http = this.#manifest.panel.http;
      if (http !== undefined) {
        this.#panel = openHttpPanel(http, (address, input, options) =>
          this.#phase === "running" || this.#phase === "starting"
            ? this.#backplane.call(address, "handle", input, options, "panel")
            : Promise.reject(new RackError("RACK_LINK_DOWN", "the rack is not running")),
        );
        this.#log("info", "panel http listening", { url: this.#panel.url.href });
      }
      for (const slot of this.#slots.values()) this.#knownGood.set(slot.name, slot.firmware);
      this.#phase = "running";
      const control = this.#controlOption;
      if (control !== undefined && control !== false) {
        const handle = this.handle();
        const { port, token } = control === true ? {} : control;
        this.#control = await openControl(handle, {
          baseDir: this.#baseDir,
          ...(port === undefined ? {} : { port }),
          ...(token === undefined ? {} : { token }),
          stop: () => void handle.stop(),
        });
        this.#log("info", "control listening", { address: this.#control.address });
      }
      this.#log("info", `rack ${this.#manifest.name} started`, { devices: this.#slots.size });
    } catch (error) {
      await this.#abortStart();
      throw error;
    }
  }

  /**
   * Works out the plan without powering anything on: boots and wires every device the way
   * `start()` does, reports the plan, and terminates the instances again.
   */
  async dryRun(write: boolean): Promise<PlanReport> {
    try {
      await this.#prepare();
      const scanned = this.#plan;
      if (scanned === undefined) {
        const instances = this.#ordered().map((slot) => ({
          name: slot.name,
          model: slot.model,
          owner: this.#owners().get(slot.name),
          u: slot.u,
          height: slot.height,
          wiring: Object.fromEntries(slot.wiring),
        }));
        return {
          text: formatPlan(this.#manifest.name, { instances, unused: [] }),
          unused: [],
          file: undefined,
        };
      }
      const path = this.#planPath();
      const text = formatPlan(this.#manifest.name, scanned);
      const file = { path, state: "missing" as PlanFileState, differences: [] as string[] };
      const existing = Bun.file(path);
      if (await existing.exists()) {
        const fit = fitPlan(
          parsePlan(await existing.text(), basename(path)),
          scanned,
          this.#manifest.size,
        );
        if (!fit.fits) file.differences = fit.differences;
        file.state = !fit.fits ? "differs" : fit.sameOrder ? "fits" : "reordered";
      }
      if (write) {
        await Bun.write(path, text);
        file.state = "fits";
        file.differences = [];
      }
      return { text, unused: [...scanned.unused], file };
    } finally {
      await this.#abortStart();
    }
  }

  /**
   * Boots and wires every device of the manifest, or of a scanned rack's plan, without powering
   * any on.
   *
   * @returns The new text of the plan file when it is to be written.
   */
  async #prepare(): Promise<string | undefined> {
    const builds = new Map<string, Promise<Firmware>>();
    let entries: Entry[];
    let planText: string | undefined;
    if (this.#manifest.scan === undefined) {
      entries = this.#manifest.slots.map(({ u, spec }) => ({
        u,
        spec,
        source: resolveSource(spec.source, this.#baseDir),
      }));
    } else {
      ({ entries, planText } = await this.#planScanned(builds));
    }
    for (const { source } of entries) {
      if (!builds.has(source)) builds.set(source, this.#build(source));
    }
    await Promise.allSettled(builds.values());
    const booted = await Promise.allSettled(
      entries.map(async (entry) => {
        const firmware = await builds.get(entry.source)?.catch((error: unknown) => {
          throw new RackError("RACK_MANIFEST", messageOf(error));
        });
        if (firmware === undefined) throw new RackError("RACK_MANIFEST", "missing firmware");
        const instance = await this.#boot(
          firmware,
          entry.spec.name,
          entry.u,
          entry.spec.config,
          "RACK_MANIFEST",
        );
        return { u: entry.u, config: entry.spec.config, firmware, instance };
      }),
    );
    for (const result of booted) if (result.status === "rejected") throw result.reason;
    const ready = booted.map((result) => (result as PromiseFulfilledResult<Booted>).value);
    this.#assemble(ready);
    return planText;
  }

  // ---- Scanned racks ----

  /**
   * Scans the devices of a scanned rack, works out its plan, and lets the plan file decide which
   * plan runs.
   *
   * @returns The slots to boot, and the new text of the plan file when it is to be written.
   */
  async #planScanned(
    builds: Map<string, Promise<Firmware>>,
  ): Promise<{ entries: Entry[]; planText: string | undefined }> {
    const models = await this.#scanModels(builds);
    const computed = this.#computePlan(models);
    const { plan, write } = await this.#choosePlan(computed);
    this.#plan = plan;
    this.#patch = patchesOf(plan);
    const entries: Entry[] = plan.instances.map((instance) => {
      const { source } = models.get(instance.model) as ModelSource;
      const config = this.#configFor(instance, models);
      return { u: instance.u, spec: mountSpec(source, { name: instance.name, config }), source };
    });
    return {
      entries,
      planText: write ? formatPlan(this.#manifest.name, plan) : undefined,
    };
  }

  /** The configuration of a planned instance: by its name, then by its model, then the spec's. */
  #configFor(instance: PlannedInstance, models: ReadonlyMap<string, ModelSource>): unknown {
    const { config } = this.#manifest.scan as ScanSpec;
    if (Object.hasOwn(config, instance.name)) return config[instance.name];
    if (Object.hasOwn(config, instance.model)) return config[instance.model];
    return models.get(instance.model)?.config;
  }

  /** Builds and describes every device file the manifest names, keyed by model name. */
  async #scanModels(builds: Map<string, Promise<Firmware>>): Promise<Map<string, ModelSource>> {
    const scan = this.#manifest.scan as ScanSpec;
    const found: { source: string; config: unknown; variant: string | undefined }[] = [];
    for (const entry of scan.devices) {
      if (typeof entry === "string") {
        for (const source of await deviceFiles(resolvePath(this.#baseDir, entry))) {
          found.push({ source, config: undefined, variant: undefined });
        }
      } else {
        const source = resolveSource(entry.source, this.#baseDir);
        found.push({ source, config: entry.config, variant: entry.name });
      }
    }
    for (const { source } of found) {
      if (!builds.has(source)) builds.set(source, this.#build(source));
    }
    const described = await Promise.all(
      found.map(async (item) => {
        const firmware = await (builds.get(item.source) as Promise<Firmware>).catch(
          (error: unknown) => {
            throw new RackError("RACK_MANIFEST", messageOf(error));
          },
        );
        return { ...item, firmware, fru: await this.#describe(firmware) };
      }),
    );
    const models = new Map<string, ModelSource>();
    for (const item of described) {
      const name = item.variant ?? item.fru.model;
      const explicit = item.variant !== undefined || item.config !== undefined;
      const existing = models.get(name);
      if (existing !== undefined) {
        // A file that a directory scan finds and a spec also names is one model; the spec's
        // configuration wins.
        if (existing.source === item.source && !(existing.explicit && explicit)) {
          if (explicit) models.set(name, { ...existing, config: item.config, explicit });
          continue;
        }
        throw new RackError(
          "RACK_MANIFEST",
          `two device files declare model ${name}: ${existing.source} and ${item.source}`,
        );
      }
      const { fru } = item;
      models.set(name, {
        type: {
          name,
          height: fru.height,
          priority: fru.priority,
          needs: fru.needs,
          provides: fru.provides,
        },
        source: item.source,
        config: item.config,
        explicit,
      });
    }
    return models;
  }

  /** Builds a device file, remembering the bundle so that it can be deleted once unused. */
  async #build(source: string): Promise<Firmware> {
    const firmware = await buildBundle(source, this.#baseDir);
    this.#built.set(firmware.path, firmware);
    this.#firmwares.set(firmware.hash, firmware);
    return firmware;
  }

  /**
   * Reads what a firmware declares, loading it once in a Worker that is ended after. While the
   * thread of an earlier such Worker of the firmware is stuck, it isn't loaded again.
   *
   * @decision .agents/decisions/261117_185131-ending-instances.md#inspecting-firmware
   */
  async #describe(firmware: Firmware): Promise<Fru> {
    const known = this.#described.get(firmware.hash);
    if (known !== undefined) return known;
    const stuck = this.#stuckFirmware(firmware.hash);
    if (stuck !== undefined) {
      throw new RackError("RACK_MANIFEST", this.#stuckMessage(firmware.source, stuck));
    }
    const instance = new Instance(firmware, firmware.source, this);
    try {
      const fru = await instance.describe(this.#hookTimeout);
      this.#described.set(firmware.hash, fru);
      return fru;
    } catch (error) {
      throw new RackError("RACK_MANIFEST", `${firmware.source}: ${asRackError(error).message}`);
    } finally {
      await this.#end(instance, undefined);
    }
  }

  /** Works out the plan from the models, the roots, and the panel routes that name models. */
  #computePlan(models: ReadonlyMap<string, ModelSource>): Plan {
    const scan = this.#manifest.scan as ScanSpec;
    const roots = [...scan.roots];
    for (const address of Object.values(this.#manifest.panel.http?.routes ?? {})) {
      const { device } = parseAddress(address);
      if (models.has(device) && !roots.includes(device)) roots.push(device);
    }
    const types = new Map<string, PlanType>();
    for (const [name, model] of models) types.set(name, model.type);
    return makePlan({ types, roots, use: scan.use, size: this.#manifest.size });
  }

  /**
   * Lets the plan file decide which plan runs: the file while it fits the graph, the computed
   * plan otherwise or without a file, as the `plan` start option says.
   *
   * @throws RackError `RACK_MANIFEST` when the file no longer fits and may not be rewritten.
   */
  async #choosePlan(computed: Plan): Promise<{ plan: Plan; write: boolean }> {
    if (this.#planMode === false) return { plan: computed, write: false };
    const path = this.#planPath();
    const name = basename(path);
    const file = Bun.file(path);
    if (!(await file.exists())) return { plan: computed, write: true };
    const fit = fitPlan(parsePlan(await file.text(), name), computed, this.#manifest.size);
    if (fit.fits && fit.sameOrder) return { plan: fit.plan, write: false };
    if (this.#planMode === "update") {
      const differences = fit.fits ? ["the priorities give another order"] : fit.differences;
      this.#log("info", `${name} changed`, { differences });
      return { plan: computed, write: true };
    }
    if (fit.fits) {
      this.#log("info", `${name} keeps its order; rack plan --write applies the priorities`);
      return { plan: fit.plan, write: false };
    }
    throw new RackError(
      "RACK_MANIFEST",
      `${name} no longer fits the devices: ${fit.differences.join("; ")}; run rack plan --write or rack dev to rewrite it`,
    );
  }

  #planPath(): string {
    return join(this.#baseDir, `${this.#manifest.name}.plan`);
  }

  /** Rejects management operations that would change a scanned rack outside its plan. */
  #requireHandPlaced(): void {
    if (this.#manifest.scan !== undefined) {
      throw new RackError(
        "RACK_SWAP_REJECTED",
        `rack ${this.#manifest.name} is scanned: its instances come and go with its plan; change the device files or the manifest and reload`,
      );
    }
  }

  #throwStartFault(): void {
    if (this.#startFault !== undefined) throw this.#startFault;
  }

  async #abortStart(): Promise<void> {
    this.#phase = "stopping";
    await this.#control?.close().catch(() => undefined);
    this.#control = undefined;
    await this.#panel?.stop().catch(() => undefined);
    this.#panel = undefined;
    for (const slot of this.#ordered().reverse()) {
      const instance = slot.installed;
      slot.installed = null;
      slot.removed = true;
      if (instance === null || instance.dead) continue;
      const answered = !instance.active || (await this.#bestEffort(instance, "deactivate"));
      if (answered && instance.poweredOn) await this.#bestEffort(instance, "powerOff");
    }
    await this.#endAll();
    this.#slots.clear();
    this.#phase = "stopped";
  }

  async #stop(): Promise<void> {
    if (this.#phase !== "running") return;
    this.#phase = "stopping";
    await this.#control?.close().catch(() => undefined);
    this.#control = undefined;
    await this.#panel?.stop();
    this.#panel = undefined;
    // Top down: upper devices finish their work while the devices below still serve them.
    // @decision .agents/decisions/261112_035942-rack-architecture.md#gravity-rule
    for (const slot of this.#ordered().reverse()) {
      const instance = slot.installed;
      if (instance !== null) {
        const wasAlive = !instance.dead;
        await this.#powerDown(instance, []);
        // Terminated now, in order; the wait for the threads comes once, for all of them.
        void this.#end(instance, slot.name);
        if (wasAlive) this.#poweredOff(instance);
      }
      slot.installed = null;
      slot.removed = true;
    }
    await this.#endAll();
    this.#slots.clear();
    this.#phase = "stopped";
    this.#log("info", `rack ${this.#manifest.name} stopped`);
  }

  /**
   * Ends every instance left, and waits for every thread being ended, together: a stuck thread
   * delays a stop by one `hookTimeout` at most. The rack forgets its stuck threads after.
   *
   * @decision .agents/decisions/261117_185131-ending-instances.md#ending-an-instance
   */
  async #endAll(): Promise<void> {
    for (const instance of [...this.#instances]) void this.#end(instance, instance.slot);
    await Promise.all([...this.#ending.values()].map((ending) => ending.done));
    this.#stuck.clear();
  }

  // ---- Assembly ----

  #assemble(entries: Booted[]): void {
    for (const entry of entries) {
      const { name } = entry.instance.fru as Fru;
      checkDeviceName(name);
      if (this.#slots.has(name)) {
        throw new RackError("RACK_MANIFEST", `two devices are named ${name}; set name in slot()`);
      }
      this.#slots.set(name, newSlot(entry));
    }
    this.#checkLayout(this.#layout());
    for (const slot of this.#ordered()) {
      slot.wiring = this.#wire(slot.name, slot.u, slot.fru, new Map());
      (slot.installed as Instance).wiring = slot.wiring;
    }
    const shared = this.#ownershipProblem();
    if (shared !== undefined) throw new RackError("RACK_MANIFEST", shared);
    for (const [consumer] of this.#patch) {
      const { device, port: need } = parseAddress(consumer);
      if (this.#slots.get(device)?.fru.needs[need] === undefined) {
        throw new RackError(
          "RACK_MANIFEST",
          `patch ${consumer}: no device ${device} with need ${need}`,
        );
      }
    }
    for (const [pattern, address] of Object.entries(this.#manifest.panel.http?.routes ?? {})) {
      const { device, port } = parseAddress(address);
      const info = this.#slots.get(device)?.fru.provides[port];
      if (info === undefined || !isHttpPort(info)) {
        throw new RackError(
          "RACK_MANIFEST",
          `panel route ${pattern} -> ${address}: no http/v1 port ${port} on a device ${device}`,
        );
      }
    }
  }

  #checkLayout(layout: Layout[]): void {
    const size = this.#manifest.size;
    const sorted = [...layout].sort((a, b) => a.u - b.u);
    for (const [index, item] of sorted.entries()) {
      const top = item.u + item.height - 1;
      if (top > size) {
        throw new RackError(
          "RACK_MANIFEST",
          `${item.name} at U${item.u} with height ${item.height} exceeds the ${size}U rack`,
        );
      }
      const below = sorted[index - 1];
      if (below !== undefined && below.u + below.height > item.u) {
        throw new RackError(
          "RACK_MANIFEST",
          `${item.name} at U${item.u} overlaps ${below.name} at U${below.u}-U${below.u + below.height - 1}`,
        );
      }
    }
  }

  /**
   * Wires the needs of a device. Needs that keep a compatible wire keep it; the rest follow a
   * patch, or the only port with the same connector among the devices below.
   *
   * @throws RackError `RACK_MANIFEST` when a need cannot be wired.
   */
  #wire(
    name: string,
    u: number,
    fru: Fru,
    previous: ReadonlyMap<string, Wire>,
    frus: ReadonlyMap<string, Fru> = new Map(),
  ): Map<string, Wire> {
    // The FRU a provider will have: a group replacement wires against the new ones.
    const fruOf = (slot: Slot) => frus.get(slot.name) ?? slot.fru;
    const wiring = new Map<string, Wire>();
    for (const [need, info] of Object.entries(fru.needs)) {
      const where = `${name}.${need} (${info.id})`;
      // A patch decides first: when a plan or a manifest changes, its wiring wins.
      const patch = this.#patch.find(([consumer]) => consumer === `${name}.${need}`);
      const kept = patch === undefined ? previous.get(need) : undefined;
      const keptSlot = kept && this.#slots.get(kept.provider);
      const keptPort = kept && keptSlot && !keptSlot.removed && fruOf(keptSlot).provides[kept.port];
      if (kept !== undefined && keptPort && keptPort.id === info.id && covers(keptPort, info)) {
        wiring.set(need, kept);
        continue;
      }
      if (patch !== undefined) {
        const target = parseAddress(patch[1]);
        const provider = this.#slots.get(target.device);
        if (provider === undefined || provider.removed) {
          throw new RackError(
            "RACK_MANIFEST",
            `patch ${where} -> ${patch[1]}: no device ${target.device}`,
          );
        }
        // @decision .agents/decisions/261112_035942-rack-architecture.md#gravity-rule
        if (provider.u >= u) {
          throw new RackError(
            "RACK_MANIFEST",
            `patch ${where} -> ${patch[1]} breaks the gravity rule: U${provider.u} is not below U${u}`,
          );
        }
        const port = fruOf(provider).provides[target.port];
        if (port === undefined || port.id !== info.id) {
          throw new RackError(
            "RACK_MANIFEST",
            `patch ${where} -> ${patch[1]}: not a ${info.id} port`,
          );
        }
        requireCover(where, patch[1], port, info);
        wiring.set(need, { provider: provider.name, port: target.port });
        continue;
      }
      const candidates: { slot: Slot; port: string; info: ConnectorInfo }[] = [];
      let above: string | undefined;
      for (const slot of this.#slots.values()) {
        if (slot.removed || slot.name === name) continue;
        for (const [port, portInfo] of Object.entries(fruOf(slot).provides)) {
          if (portInfo.id !== info.id) continue;
          if (slot.u < u) candidates.push({ slot, port, info: portInfo });
          else above ??= `${slot.name}.${port}`;
        }
      }
      const [only, ...others] = candidates;
      if (only === undefined) {
        const hint = above === undefined ? "" : `; ${above} is above it (gravity rule)`;
        throw new RackError("RACK_MANIFEST", `${where}: no device below U${u} provides it${hint}`);
      }
      if (others.length > 0) {
        const list = candidates.map((c) => `${c.slot.name}.${c.port}`).join(", ");
        throw new RackError("RACK_MANIFEST", `${where} is ambiguous: ${list}; add a patch`);
      }
      requireCover(where, `${only.slot.name}.${only.port}`, only.info, info);
      wiring.set(need, { provider: only.slot.name, port: only.port });
    }
    return wiring;
  }

  /**
   * Checks that the new FRU still provides every port other devices and panel routes use.
   *
   * @throws RackError `RACK_SWAP_REJECTED` otherwise.
   */
  #checkCompatibility(slot: Slot, fru: Fru, group: ReadonlySet<string> = new Set()): void {
    for (const consumer of this.#slots.values()) {
      if (consumer === slot || consumer.removed || group.has(consumer.name)) continue;
      for (const [need, wire] of consumer.wiring) {
        if (wire.provider !== slot.name) continue;
        const needInfo = consumer.fru.needs[need];
        const port = fru.provides[wire.port];
        if (!fits(port, needInfo)) {
          throw new RackError(
            "RACK_SWAP_REJECTED",
            misfit(`${consumer.name}.${need}`, slot.name, wire.port, port, needInfo),
          );
        }
      }
    }
    for (const [pattern, address] of Object.entries(this.#manifest.panel.http?.routes ?? {})) {
      const { device, port } = parseAddress(address);
      if (device !== slot.name) continue;
      const info = fru.provides[port];
      if (info === undefined || !isHttpPort(info)) {
        throw new RackError(
          "RACK_SWAP_REJECTED",
          `panel route ${pattern} uses ${address}, which the new firmware does not provide as http/v1`,
        );
      }
    }
  }

  /** Names the devices and panel routes that use a device. */
  #usersOf(name: string): string[] {
    const users: string[] = [];
    for (const consumer of this.#slots.values()) {
      if (consumer.name === name || consumer.removed) continue;
      for (const [need, wire] of consumer.wiring) {
        if (wire.provider === name) users.push(`${consumer.name}.${need}`);
      }
    }
    for (const [pattern, address] of Object.entries(this.#manifest.panel.http?.routes ?? {})) {
      if (parseAddress(address).device === name) users.push(`panel route ${pattern}`);
    }
    return users;
  }

  /**
   * Names an `own` need whose provider is also wired to another need, if there is one.
   *
   * @param change A device whose wiring is about to change, with its new FRU and wiring.
   * @decision .agents/decisions/261116_233919-automatic-assembly.md#shared-and-own-needs
   */
  #ownershipProblem(change?: {
    name: string;
    fru: Fru;
    wiring: ReadonlyMap<string, Wire>;
  }): string | undefined {
    const users = new Map<string, string[]>();
    const owners = new Map<string, string>();
    const consider = (name: string, fru: Fru, wiring: ReadonlyMap<string, Wire>) => {
      for (const [need, wire] of wiring) {
        const user = `${name}.${need}`;
        users.set(wire.provider, [...(users.get(wire.provider) ?? []), user]);
        if (fru.needs[need]?.own) owners.set(wire.provider, user);
      }
    };
    for (const slot of this.#slots.values()) {
      if (!slot.removed && slot.name !== change?.name) consider(slot.name, slot.fru, slot.wiring);
    }
    if (change !== undefined) consider(change.name, change.fru, change.wiring);
    for (const [provider, owner] of owners) {
      const others = (users.get(provider) ?? []).filter((user) => user !== owner);
      if (others.length > 0) {
        return `${owner} owns ${provider}, but ${others.join(", ")} ${others.length === 1 ? "is" : "are"} wired to it too`;
      }
    }
    return undefined;
  }

  /** Maps each copy that serves an `own` need to the instance whose need it serves. */
  #owners(): Map<string, string> {
    const owners = new Map<string, string>();
    for (const slot of this.#slots.values()) {
      if (slot.removed) continue;
      for (const [need, wire] of slot.wiring) {
        if (slot.fru.needs[need]?.own) owners.set(wire.provider, slot.name);
      }
    }
    return owners;
  }

  // ---- Management operations ----

  /**
   * Runs a management operation in the queue, as an update with a cause for the history, and
   * deletes the bundles that nothing uses any more once it ends.
   */
  #operate<T>(cause: UpdateCause, operation: () => Promise<T>): Promise<T> {
    return this.#serialize(async () => {
      try {
        return await updates.run({ cause, started: Date.now() }, operation);
      } finally {
        await this.#collectGarbage();
      }
    });
  }

  /** Runs management operations one at a time, in call order. */
  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#operations.then(operation);
    this.#operations = run.catch(() => undefined);
    return run;
  }

  #requireRunning(): void {
    if (this.#phase !== "running") {
      throw new RackError("RACK_SWAP_REJECTED", "the rack is not running");
    }
  }

  async #reload(manifest?: RackManifest): Promise<ReloadResult[]> {
    this.#requireRunning();
    if (manifest !== undefined) this.#adopt(manifest);
    const builds = new Map<string, Promise<Firmware>>();
    let change: Change | undefined;
    if (this.#manifest.scan !== undefined) {
      change = await this.#beginChange(await this.#replan(builds), builds);
    } else if (manifest !== undefined) {
      change = await this.#beginChange(await this.#targetOf(manifest, builds), builds);
    }
    const slots = this.#ordered();
    for (const slot of slots) {
      if (!builds.has(slot.source)) builds.set(slot.source, this.#build(slot.source));
    }
    await Promise.allSettled(builds.values());
    const results: ReloadResult[] = [...(change?.results ?? [])];
    const done = new Set<string>();
    for (const slot of slots) {
      if (slot.removed || this.#phase !== "running" || done.has(slot.name)) continue;
      const from = slot.installed?.firmware.hash ?? null;
      let firmware: Firmware;
      try {
        firmware = (await builds.get(slot.source)) as Firmware;
      } catch (error) {
        if (slot.installed !== null && !slot.busy) slot.state = "degraded";
        const failure = new RackError("RACK_SWAP_REJECTED", messageOf(error));
        this.#swapFailed(slot.name, "swap", from, null, failure, slot);
        results.push({
          device: slot.name,
          from,
          to: null,
          mode: "hot",
          error: toWireError(failure),
        });
        continue;
      }
      if (firmware.hash === slot.firmware.hash && !change?.forced.has(slot.name)) continue;
      results.push(...(await this.#replace(slot, firmware, slot.source, builds, done)).results);
    }
    if (change !== undefined) results.push(...(await this.#finishChange(change, done, results)));
    return results;
  }

  /**
   * Scans a running scanned rack again and picks the plan it should run now: the computed one,
   * or under `rack start` the plan file, which must fit the devices.
   *
   * @returns The layout to move to.
   * @throws RackError `RACK_SWAP_REJECTED` when the plan file no longer fits the devices.
   * @decision .agents/decisions/261116_233956-cold-swaps-and-restarts.md#applying-a-changed-plan
   */
  async #replan(builds: Map<string, Promise<Firmware>>): Promise<Target> {
    const models = await this.#scanModels(builds);
    const computed = this.#computePlan(models);
    let next = computed;
    if (this.#planMode === true) {
      // rack start follows the plan file, so a new layout runs once the file records it.
      // @decision .agents/decisions/261116_233919-automatic-assembly.md#plan-file
      const path = this.#planPath();
      const file = Bun.file(path);
      if (await file.exists()) {
        const fit = fitPlan(
          parsePlan(await file.text(), basename(path)),
          computed,
          this.#manifest.size,
        );
        if (!fit.fits) {
          throw new RackError(
            "RACK_SWAP_REJECTED",
            `${basename(path)} no longer fits the devices: ${fit.differences.join("; ")}; run rack plan --write to apply the new plan`,
          );
        }
        next = fit.plan;
      }
    }
    const devices = new Map<string, TargetDevice>();
    for (const instance of next.instances) {
      const { source } = models.get(instance.model) as ModelSource;
      devices.set(instance.name, {
        u: instance.u,
        source,
        config: this.#configFor(instance, models),
      });
    }
    return { devices, patch: patchesOf(next), plan: next };
  }

  /**
   * The layout an edited manifest that places devices by hand asks for.
   *
   * @throws RackError `RACK_SWAP_REJECTED` when a device file does not build or two devices
   *   share a name.
   */
  async #targetOf(manifest: RackManifest, builds: Map<string, Promise<Firmware>>): Promise<Target> {
    const devices = new Map<string, TargetDevice>();
    for (const { u, spec } of manifest.slots) {
      const source = resolveSource(spec.source, this.#baseDir);
      let build = builds.get(source);
      if (build === undefined) {
        build = this.#build(source);
        builds.set(source, build);
      }
      const firmware = await build.catch((error: unknown) => {
        throw new RackError("RACK_SWAP_REJECTED", messageOf(error));
      });
      const name = spec.name ?? (await this.#describeForSwap(firmware)).model;
      if (devices.has(name)) {
        throw new RackError(
          "RACK_SWAP_REJECTED",
          `two devices are named ${name}; set name in slot()`,
        );
      }
      devices.set(name, { u, source, config: spec.config });
    }
    return { devices, patch: manifest.patch, plan: undefined };
  }

  /**
   * Starts moving the running rack to a target layout:
   * - marks the devices that leave, which keep serving until nothing uses them;
   * - moves the devices that stay to their new slots, which restarts nothing;
   * - adopts the new wiring, and records changed sources and configurations;
   * - plugs the devices that arrive, from the bottom up.
   *
   * Replacements follow in the caller, and rewiring and unplugging in {@link #finishChange}.
   * Each step leaves a valid rack.
   *
   * @throws RackError `RACK_SWAP_REJECTED` when the devices that stay do not fit their new slots;
   *   nothing changes then.
   * @decision .agents/decisions/261116_233956-cold-swaps-and-restarts.md#applying-a-changed-plan
   */
  async #beginChange(target: Target, builds: Map<string, Promise<Firmware>>): Promise<Change> {
    const current = [...this.#slots.values()].filter((slot) => !slot.removed);
    const staying = current.filter((slot) => target.devices.has(slot.name));
    const leaving = current.filter((slot) => !target.devices.has(slot.name));
    const wanted = (slot: Slot) => target.devices.get(slot.name) as TargetDevice;
    try {
      this.#checkLayout(
        staying.map((slot) => ({ name: slot.name, u: wanted(slot).u, height: slot.height })),
      );
    } catch (error) {
      throw new RackError("RACK_SWAP_REJECTED", asRackError(error).message);
    }
    for (const slot of leaving) slot.removed = true;
    this.#patch = target.patch;
    const forced = new Set<string>();
    for (const slot of staying) {
      const next = wanted(slot);
      slot.u = next.u;
      slot.source = next.source;
      if (!Bun.deepEquals(next.config, slot.config, true)) {
        slot.config = next.config;
        forced.add(slot.name);
      }
    }
    const results: ReloadResult[] = [];
    const arriving = [...target.devices].filter(([name]) => !this.#slots.has(name));
    arriving.sort(([, a], [, b]) => a.u - b.u);
    for (const [name, next] of arriving) {
      let firmware: Firmware | undefined;
      try {
        let build = builds.get(next.source);
        if (build === undefined) {
          build = this.#build(next.source);
          builds.set(next.source, build);
        }
        firmware = await build;
        await this.#plugSlot(
          next.u,
          mountSpec(next.source, { name, config: next.config }),
          firmware,
          name,
        );
        results.push({ device: name, from: null, to: firmware.hash, mode: "plug" });
      } catch (error) {
        const failure = toWireError(asRackError(error));
        results.push({
          device: name,
          from: null,
          to: firmware?.hash ?? null,
          mode: "plug",
          error: failure,
        });
      }
    }
    return { target, forced, leaving, results };
  }

  /**
   * Finishes moving the running rack to a target layout, after the replacements: rewires the
   * devices that stayed and were not replaced, unplugs the devices that left once nothing uses
   * them, from the top down, and records the plan of a scanned rack.
   *
   * @param replaced Devices the replacements already rewired.
   * @param earlier Results so far, to tell whether every step succeeded.
   */
  async #finishChange(
    change: Change,
    replaced: ReadonlySet<string>,
    earlier: readonly ReloadResult[],
  ): Promise<ReloadResult[]> {
    const results: ReloadResult[] = [];
    for (const slot of this.#ordered()) {
      const instance = slot.installed;
      if (slot.removed || replaced.has(slot.name) || instance === null) continue;
      const hash = instance.firmware.hash;
      let wiring: Map<string, Wire>;
      try {
        wiring = this.#wire(slot.name, slot.u, slot.fru, slot.wiring);
        const shared = this.#ownershipProblem({ name: slot.name, fru: slot.fru, wiring });
        if (shared !== undefined) throw new RackError("RACK_SWAP_REJECTED", shared);
      } catch (error) {
        const failure = toWireError(asRackError(error));
        results.push({ device: slot.name, from: hash, to: hash, mode: "hot", error: failure });
        continue;
      }
      const changed = [...wiring].filter(([need, wire]) => {
        const before = slot.wiring.get(need);
        return before?.provider !== wire.provider || before?.port !== wire.port;
      });
      if (changed.length === 0) continue;
      slot.wiring = wiring;
      instance.wiring = wiring;
      for (const [need, wire] of changed) await this.#backplane.relink(instance, need, wire);
      this.#log("info", `${slot.name} rewired`, {
        needs: changed.map(([need, wire]) => `${need} -> ${wire.provider}.${wire.port}`),
      });
    }
    for (const slot of [...change.leaving].sort((a, b) => b.u - a.u)) {
      const from = slot.installed?.firmware.hash ?? null;
      const users = this.#usersOf(slot.name);
      if (users.length > 0) {
        slot.removed = false;
        const message = `${slot.name} is still used by ${users.join(", ")}`;
        const failure = toWireError(new RackError("RACK_SWAP_REJECTED", message));
        results.push({ device: slot.name, from, to: from, mode: "unplug", error: failure });
        continue;
      }
      try {
        await this.#unplugSlot(slot, from);
        results.push({ device: slot.name, from, to: null, mode: "unplug" });
      } catch (error) {
        const failure = toWireError(asRackError(error));
        results.push({ device: slot.name, from, to: from, mode: "unplug", error: failure });
      }
    }
    const routes = this.#manifest.panel.http?.routes;
    if (this.#panel !== undefined && routes !== undefined) this.#panel.setRoutes(routes);
    const plan = change.target.plan;
    if (plan !== undefined) {
      const complete = [...earlier, ...results].every((result) => result.error === undefined);
      if (complete) {
        this.#plan = plan;
        if (this.#planMode === "update") {
          await Bun.write(this.#planPath(), formatPlan(this.#manifest.name, plan));
        }
      } else {
        this.#plan = this.#runningPlan(plan);
        this.#log("warn", "the new plan was applied in part; the plan file is unchanged");
      }
    }
    return results;
  }

  /** The plan a scanned rack actually runs, read from its slots. */
  #runningPlan(target: Plan): Plan {
    const models = new Map<string, string>();
    for (const instance of [...(this.#plan?.instances ?? []), ...target.instances]) {
      models.set(instance.name, instance.model);
    }
    const owners = this.#owners();
    const instances = this.#ordered()
      .filter((slot) => !slot.removed)
      .map(
        (slot): PlannedInstance => ({
          name: slot.name,
          model: models.get(slot.name) ?? slot.model,
          owner: owners.get(slot.name),
          u: slot.u,
          height: slot.height,
          wiring: Object.fromEntries(slot.wiring),
        }),
      );
    return { instances, unused: target.unused };
  }

  /**
   * Takes over an edited manifest. The rack keeps its name, its kind, and its panel port, which
   * need a restart to change; its size, devices, wiring, and panel routes follow the new
   * manifest.
   *
   * @throws RackError `RACK_SWAP_REJECTED` for a change that needs a restart.
   */
  #adopt(manifest: RackManifest): void {
    if (!isRackManifest(manifest)) {
      throw new RackError("RACK_SWAP_REJECTED", "reload() takes a manifest created by rack()");
    }
    const old = this.#manifest;
    const restart = (what: string) =>
      new RackError("RACK_SWAP_REJECTED", `restart the rack to ${what}`);
    if (manifest.name !== old.name) throw restart("rename it");
    if ((manifest.scan === undefined) !== (old.scan === undefined)) {
      throw restart("switch between slots and scanned devices");
    }
    if (manifest.panel.http?.port !== old.panel.http?.port) throw restart("change its panel");
    this.#manifest = manifest;
  }

  async #swap(name: string, source: string | URL | undefined): Promise<void> {
    this.#requireRunning();
    if (source !== undefined) {
      try {
        this.#requireHandPlaced();
      } catch (error) {
        const from = this.#slots.get(name)?.installed?.firmware.hash ?? null;
        throw this.#swapFailed(name, "swap", from, null, asRackError(error));
      }
    }
    const slot = this.#slots.get(name);
    if (slot === undefined || slot.removed) {
      throw new RackError("RACK_NO_ROUTE", `no device named ${name}`);
    }
    const path = source === undefined ? slot.source : resolveSource(source, this.#baseDir);
    let firmware: Firmware;
    try {
      firmware = await this.#build(path);
    } catch (error) {
      const from = slot.installed?.firmware.hash ?? null;
      if (slot.installed !== null && !slot.busy) slot.state = "degraded";
      const failure = new RackError("RACK_SWAP_REJECTED", messageOf(error));
      throw this.#swapFailed(name, "swap", from, null, failure, slot);
    }
    const builds = new Map([[path, Promise.resolve(firmware)]]);
    const { error } = await this.#replace(slot, firmware, path, builds);
    if (error !== undefined) throw error;
  }

  /**
   * Replaces a device with new firmware, choosing the kind of replacement: a group with the
   * consumers of a contract that the new firmware changes, a cold swap when the old or the new
   * firmware declares `swap: "cold"`, and a hot swap otherwise.
   *
   * @param builds Firmware built for this replacement, by source; consumers of a changed
   *   contract take their new firmware from it, or are built into it.
   * @param done Collects the names of the devices replaced, so that a caller can skip them.
   * @returns One result per device replaced or tried, and the error when the replacement failed.
   * @decision .agents/decisions/261116_233956-cold-swaps-and-restarts.md#choosing-the-kind-in-reload
   */
  async #replace(
    slot: Slot,
    firmware: Firmware,
    source: string,
    builds: Map<string, Promise<Firmware>>,
    done: Set<string> = new Set(),
  ): Promise<{ results: ReloadResult[]; error?: RackError }> {
    const from = slot.installed?.firmware.hash ?? null;
    let members: Member[];
    let cold: boolean;
    try {
      const fru = await this.#describeForSwap(firmware);
      members = await this.#groupFor(slot, firmware, source, fru, builds);
      cold = members.length > 1 || slot.fru.swap === "cold" || fru.swap === "cold";
    } catch (error) {
      if (slot.installed !== null && !slot.busy) slot.state = "degraded";
      const failure = this.#swapFailed(
        slot.name,
        "swap",
        from,
        firmware.hash,
        asRackError(error),
        slot,
      );
      done.add(slot.name);
      return {
        results: [
          { device: slot.name, from, to: firmware.hash, mode: "hot", error: toWireError(failure) },
        ],
        error: failure,
      };
    }
    for (const member of members) done.add(member.slot.name);
    if (!cold) {
      try {
        await this.#swapSlot(slot, firmware, source);
        return { results: [{ device: slot.name, from, to: firmware.hash, mode: "hot" }] };
      } catch (error) {
        const failure = asRackError(error);
        return {
          results: [
            {
              device: slot.name,
              from,
              to: firmware.hash,
              mode: "hot",
              error: toWireError(failure),
            },
          ],
          error: failure,
        };
      }
    }
    return this.#replaceAll(members, new Set());
  }

  /** Runs {@link #replaceCold} and reports one result per member. */
  async #replaceAll(
    members: Member[],
    fresh: ReadonlySet<string>,
  ): Promise<{ results: ReloadResult[]; error?: RackError }> {
    const ordered = [...members].sort((a, b) => a.slot.u - b.slot.u);
    const results = ordered.map(
      (member): ReloadResult => ({
        device: member.slot.name,
        from: member.slot.installed?.firmware.hash ?? null,
        to: member.firmware.hash,
        mode: fresh.has(member.slot.name) ? "restart" : "cold",
      }),
    );
    try {
      await this.#replaceCold(ordered, fresh);
      return { results };
    } catch (error) {
      const failure = asRackError(error);
      const wire = toWireError(failure);
      return { results: results.map((result) => ({ ...result, error: wire })), error: failure };
    }
  }

  /** Reads what a firmware declares, with the error code of a swap. */
  async #describeForSwap(firmware: Firmware): Promise<Fru> {
    try {
      return await this.#describe(firmware);
    } catch (error) {
      throw new RackError("RACK_SWAP_REJECTED", asRackError(error).message);
    }
  }

  /**
   * Collects the devices a replacement must take along: every consumer whose wired needs the
   * new firmware no longer fits, with that consumer's own new firmware, and so on upward.
   *
   * @returns The device itself first, then the consumers it takes along.
   * @throws RackError `RACK_SWAP_REJECTED` when such a consumer has no new firmware.
   * @decision .agents/decisions/261116_233956-cold-swaps-and-restarts.md#contract-changes
   */
  async #groupFor(
    slot: Slot,
    firmware: Firmware,
    source: string,
    fru: Fru,
    builds: Map<string, Promise<Firmware>>,
  ): Promise<Member[]> {
    const members: Member[] = [{ slot, firmware, source }];
    const frus = new Map<string, Fru>([[slot.name, fru]]);
    for (let index = 0; index < members.length; index++) {
      const provider = (members[index] as Member).slot;
      const provides = (frus.get(provider.name) as Fru).provides;
      for (const consumer of this.#ordered()) {
        if (consumer.removed || frus.has(consumer.name)) continue;
        const broken = [...consumer.wiring].find(
          ([need, wire]) =>
            wire.provider === provider.name && !fits(provides[wire.port], consumer.fru.needs[need]),
        );
        if (broken === undefined) continue;
        const [need, wire] = broken;
        const why = misfit(
          `${consumer.name}.${need}`,
          provider.name,
          wire.port,
          provides[wire.port],
          consumer.fru.needs[need],
        );
        let build = builds.get(consumer.source);
        if (build === undefined) {
          build = this.#build(consumer.source);
          builds.set(consumer.source, build);
        }
        let next: Firmware;
        try {
          next = await build;
        } catch (error) {
          throw new RackError(
            "RACK_SWAP_REJECTED",
            `${why}; ${consumer.name} does not build: ${messageOf(error)}`,
          );
        }
        if (next.hash === consumer.firmware.hash) {
          throw new RackError(
            "RACK_SWAP_REJECTED",
            `${why}; ${consumer.name} has no new firmware to replace with it`,
          );
        }
        members.push({ slot: consumer, firmware: next, source: consumer.source });
        frus.set(consumer.name, await this.#describeForSwap(next));
      }
    }
    return members;
  }

  /**
   * Replaces a group of devices without letting an old and a new instance overlap:
   * 1. Boots every new instance in standby and checks how it fits. A failure changes nothing.
   * 2. Stops the old instances from the top down, each held and drained right before it stops,
   *    so a device that is still finishing calls can reach the devices below it.
   * 3. Starts the new instances from the bottom up, each restoring its predecessor's snapshot
   *    unless it is in `fresh`, and installs each one.
   *
   * When a start fails, the whole group starts again from its old firmware and snapshots, and
   * a device whose old firmware fails too is marked faulted.
   *
   * @param crash For a group fallback, the device that crashed on probation and its crash: that
   *   device is installed `degraded`, with the crash as its error.
   * @throws RackError the first failure, after every member has been reported.
   * @decision .agents/decisions/261116_233956-cold-swaps-and-restarts.md#cold-swaps
   * @decision .agents/decisions/261116_233956-cold-swaps-and-restarts.md#restarts
   */
  async #replaceCold(
    members: Member[],
    fresh: ReadonlySet<string>,
    crash?: { device: string; error: WireError },
  ): Promise<void> {
    const ordered = [...members].sort((a, b) => a.slot.u - b.slot.u);
    const modeOf = (member: Member): ReloadMode =>
      fresh.has(member.slot.name) ? "restart" : "cold";
    const fromOf = new Map(ordered.map((m) => [m.slot, m.slot.installed?.firmware.hash ?? null]));
    // The records of a group replacement share a group, and its devices share their probation.
    const group: GroupKey | undefined =
      ordered.length > 1 ? { devices: ordered.map((m) => m.slot.name) } : undefined;
    const report = (failure: RackError): RackError => {
      for (const m of ordered) {
        const from = fromOf.get(m.slot) ?? null;
        this.#swapFailed(
          m.slot.name,
          "swap",
          from,
          m.firmware.hash,
          failure,
          m.slot,
          modeOf(m),
          group,
        );
      }
      return failure;
    };
    const busy = ordered.find((m) => m.slot.busy);
    if (busy !== undefined) {
      throw report(
        new RackError("RACK_SWAP_REJECTED", `${busy.slot.name} is resetting; try again later`),
      );
    }
    const before = new Map(ordered.map((m) => [m.slot, snapshotOf(m.slot)]));
    for (const m of ordered) {
      m.slot.busy = true;
      m.slot.state = "swapping";
    }
    const neos = new Map<Slot, Instance>();
    try {
      for (const m of ordered) {
        neos.set(
          m.slot,
          await this.#boot(m.firmware, m.slot.name, m.slot.u, m.slot.config, "RACK_SWAP_REJECTED"),
        );
      }
      const frus = new Map(
        ordered.map((m) => [m.slot.name, (neos.get(m.slot) as Instance).fru as Fru]),
      );
      const group = new Set(frus.keys());
      for (const m of ordered) {
        const neo = neos.get(m.slot) as Instance;
        const fru = frus.get(m.slot.name) as Fru;
        if (fru.height !== m.slot.height) {
          this.#checkLayout(
            this.#layout().map((item) =>
              item.name === m.slot.name ? { ...item, height: fru.height } : item,
            ),
          );
        }
        neo.wiring = this.#wire(m.slot.name, m.slot.u, fru, m.slot.wiring, frus);
        const shared = this.#ownershipProblem({ name: m.slot.name, fru, wiring: neo.wiring });
        if (shared !== undefined) throw new RackError("RACK_SWAP_REJECTED", shared);
        this.#checkCompatibility(m.slot, fru, group);
      }
    } catch (error) {
      await Promise.all([...neos].map(([slot, neo]) => this.#end(neo, slot.name)));
      for (const m of ordered) {
        m.slot.busy = false;
        const old = m.slot.installed;
        if (old === null) m.slot.state = "faulted";
        else if (old.dead) this.#recover(m.slot);
        else m.slot.state = "degraded";
      }
      throw report(asRackError(error));
    }
    // Requests are break-before-make here: the old instances stop before the new ones start.
    // @decision .agents/decisions/261116_233956-cold-swaps-and-restarts.md#three-ways-to-replace-an-instance
    const states = new Map<Slot, { state: unknown; from: string }>();
    for (const m of [...ordered].reverse()) {
      const restores = ((neos.get(m.slot) as Instance).fru as Fru).restore;
      const saved = await this.#stopForReplacement(m.slot, restores && !fresh.has(m.slot.name));
      if (saved !== undefined) states.set(m.slot, saved);
    }
    const started: Member[] = [];
    let failure: RackError | undefined;
    // A new instance starts only once the old one's thread has stopped.
    // @decision .agents/decisions/261117_185131-ending-instances.md#stuck-threads
    const jammed = ordered.find((m) => this.#stuckDevice(m.slot.name) !== undefined);
    if (jammed !== undefined) {
      failure = new RackError(
        "RACK_DEVICE_FAULT",
        `${jammed.slot.name}: the old instance's thread did not stop within ${this.#hookTimeout} ms; it is stuck in native code`,
      );
    } else {
      for (const m of ordered) {
        const neo = neos.get(m.slot) as Instance;
        try {
          await this.#startReplacement(m.slot, neo, states.get(m.slot));
          const crashed = crash !== undefined && crash.device === m.slot.name;
          await this.#installReplacement(
            m.slot,
            neo,
            m.firmware,
            m.source,
            crashed ? { state: "degraded", error: crash.error } : undefined,
          );
          started.push(m);
        } catch (error) {
          failure = asRackError(error);
          break;
        }
      }
    }
    if (failure !== undefined) {
      await this.#rollBackCold(ordered, neos, before, states, started);
      for (const m of ordered) m.slot.busy = false;
      throw report(failure);
    }
    for (const m of ordered) {
      m.slot.busy = false;
      const from = fromOf.get(m.slot) ?? null;
      const mode = modeOf(m);
      this.#emit(
        { type: "swap", device: m.slot.name, action: "swap", mode, from, to: m.firmware.hash },
        group,
      );
      this.#log("info", `${m.slot.name} ${mode === "restart" ? "restarted" : "swapped cold"}`, {
        from,
        to: m.firmware.hash,
      });
      // A crash while the slot was busy was counted but not reset; the reset starts now.
      // @decision .agents/decisions/261115_222025-p0-api-details.md#resets
      if ((neos.get(m.slot) as Instance).dead && m.slot.installed === null) this.#recover(m.slot);
    }
  }

  /**
   * Stops the installed instance of a slot for a cold replacement: holds the slot, lets the
   * instance finish its calls, takes its snapshot when asked, powers it off, and ends it. The
   * slot stays held, without an instance, until the next one is installed. When the instance's
   * thread doesn't stop, the rack records it as stuck.
   *
   * @returns The snapshot and the firmware it came from, when one was taken.
   */
  async #stopForReplacement(
    slot: Slot,
    takeSnapshot: boolean,
  ): Promise<{ state: unknown; from: string } | undefined> {
    const old = slot.installed;
    const markers = await this.#backplane.hold(slot);
    if (old === null) return undefined;
    const alive = !old.dead;
    const saved = await this.#powerDown(old, markers, takeSnapshot);
    slot.installed = null;
    const stopped = this.#end(old, slot.name);
    if (alive) this.#poweredOff(old);
    await stopped;
    return saved;
  }

  /** Powers a standby instance on, restoring `saved` when given; throws when any step fails. */
  async #startReplacement(
    slot: Slot,
    instance: Instance,
    saved: { state: unknown; from: string } | undefined,
  ): Promise<void> {
    await this.#backplane.connect(instance);
    await instance.hook("powerOn", this.#hookTimeout);
    instance.poweredOn = true;
    await instance.hook("selfTest", this.#hookTimeout);
    if (saved !== undefined) await instance.hook("restore", this.#hookTimeout, saved);
    await instance.hook("activate", this.#hookTimeout);
    instance.active = true;
    if (instance.dead) {
      throw new RackError(
        "RACK_SWAP_REJECTED",
        `${slot.name}: the new instance exited while it started`,
      );
    }
  }

  /**
   * Installs a started instance in its slot, which switches the held calls to it.
   *
   * @param outcome The state and error the slot reports from the moment the instance is
   *   installed: `degraded` after a fallback or a rollback, so status() never shows it online in
   *   between.
   */
  async #installReplacement(
    slot: Slot,
    instance: Instance,
    firmware: Firmware,
    source: string,
    outcome: { state: "online" | "degraded"; error?: WireError } = { state: "online" },
  ): Promise<void> {
    slot.installed = instance;
    slot.firmware = firmware;
    slot.fru = instance.fru as Fru;
    slot.model = slot.fru.model;
    slot.height = slot.fru.height;
    slot.wiring = instance.wiring;
    slot.source = source;
    slot.state = outcome.state;
    slot.error = outcome.error;
    slot.crashes = [];
    await this.#backplane.install(slot, instance, null);
    if (!instance.dead) this.#powered(instance);
  }

  /**
   * Brings a group back to its old firmware after a cold replacement failed to start: stops the
   * new instances already installed, from the top down, then starts the old firmware from the
   * bottom up with the snapshots taken before. A device whose old firmware fails too is marked
   * faulted, and the calls held for it fail.
   */
  async #rollBackCold(
    ordered: Member[],
    neos: ReadonlyMap<Slot, Instance>,
    before: ReadonlyMap<Slot, SlotRecord>,
    states: ReadonlyMap<Slot, { state: unknown; from: string }>,
    started: Member[],
  ): Promise<void> {
    for (const m of [...started].reverse()) await this.#stopForReplacement(m.slot, false);
    // A new instance that powered on may hold what the old firmware needs, such as a lock, so
    // it powers off before the old firmware starts again.
    for (const [slot, neo] of neos) {
      const answered = neo.dead || !neo.active || (await this.#bestEffort(neo, "deactivate"));
      if (answered && !neo.dead && neo.poweredOn) await this.#bestEffort(neo, "powerOff");
      await this.#end(neo, slot.name);
    }
    for (const m of ordered) {
      const was = before.get(m.slot) as SlotRecord;
      Object.assign(m.slot, was.fields);
      if (!was.running) {
        m.slot.state = "faulted";
        await this.#backplane.release(m.slot);
        continue;
      }
      try {
        const instance = await this.#boot(
          was.fields.firmware,
          m.slot.name,
          m.slot.u,
          m.slot.config,
          "RACK_SWAP_REJECTED",
        );
        instance.wiring = was.fields.wiring;
        await this.#startReplacement(m.slot, instance, states.get(m.slot));
        await this.#installReplacement(m.slot, instance, was.fields.firmware, was.fields.source, {
          state: "degraded",
        });
      } catch (error) {
        this.#log("error", `${m.slot.name}: the old firmware did not start again`, {
          error: toWireError(error),
        });
        m.slot.installed = null;
        m.slot.state = "faulted";
        await this.#backplane.release(m.slot);
      }
    }
  }

  /**
   * Stops a device completely and starts it again from scratch, rebuilt from its file and
   * without its state, as a cold replacement; then reloads its direct consumers so they run
   * their `powerOn` again against it.
   *
   * @decision .agents/decisions/261116_233956-cold-swaps-and-restarts.md#restarts
   */
  async #restart(name: string, cascade: boolean): Promise<ReloadResult[]> {
    this.#requireRunning();
    const slot = this.#slots.get(name);
    if (slot === undefined || slot.removed) {
      throw new RackError("RACK_NO_ROUTE", `no device named ${name}`);
    }
    const from = slot.installed?.firmware.hash ?? null;
    const builds = new Map<string, Promise<Firmware>>();
    let members: Member[];
    try {
      const build = this.#build(slot.source);
      builds.set(slot.source, build);
      const firmware = await build.catch((error: unknown) => {
        throw new RackError("RACK_SWAP_REJECTED", messageOf(error));
      });
      const fru = await this.#describeForSwap(firmware);
      members = await this.#groupFor(slot, firmware, slot.source, fru, builds);
    } catch (error) {
      throw this.#swapFailed(name, "swap", from, null, asRackError(error), slot, "restart");
    }
    const { results, error } = await this.#replaceAll(members, new Set([name]));
    if (error !== undefined) throw error;
    if (!cascade) return results;
    const replaced = new Set(members.map((member) => member.slot.name));
    for (const consumer of this.#ordered()) {
      if (consumer.removed || replaced.has(consumer.name)) continue;
      if (![...consumer.wiring.values()].some((wire) => wire.provider === name)) continue;
      const current = consumer.firmware;
      if (consumer.fru.swap === "cold") {
        const member = { slot: consumer, firmware: current, source: consumer.source };
        results.push(...(await this.#replaceAll([member], new Set())).results);
        continue;
      }
      const hash = consumer.installed?.firmware.hash ?? null;
      try {
        await this.#swapSlot(consumer, current, consumer.source);
        results.push({ device: consumer.name, from: hash, to: current.hash, mode: "hot" });
      } catch (failure) {
        results.push({
          device: consumer.name,
          from: hash,
          to: current.hash,
          mode: "hot",
          error: toWireError(failure),
        });
      }
    }
    return results;
  }

  /**
   * Runs the swap sequence: standby instance, compatibility check, `powerOn` and `selfTest`,
   * handover, one-step switch, and retirement of the old instance; rolls back on failure.
   */
  async #swapSlot(slot: Slot, firmware: Firmware, source: string): Promise<void> {
    const from = slot.installed?.firmware.hash ?? null;
    if (slot.busy) {
      const busy = new RackError(
        "RACK_SWAP_REJECTED",
        `${slot.name} is resetting; try again later`,
      );
      throw this.#swapFailed(slot.name, "swap", from, firmware.hash, busy);
    }
    slot.busy = true;
    const old = slot.installed;
    slot.state = "swapping";
    let neo: Instance | undefined;
    let deactivating = false;
    let deactivated = false;
    let held = false;
    let markers: Marker[] = [];
    try {
      neo = await this.#boot(firmware, slot.name, slot.u, slot.config, "RACK_SWAP_REJECTED");
      const fru = neo.fru as Fru;
      if (fru.height !== slot.height) {
        this.#checkLayout(
          this.#layout().map((item) =>
            item.name === slot.name ? { ...item, height: fru.height } : item,
          ),
        );
      }
      neo.wiring = this.#wire(slot.name, slot.u, fru, slot.wiring);
      const shared = this.#ownershipProblem({ name: slot.name, fru, wiring: neo.wiring });
      if (shared !== undefined) throw new RackError("RACK_SWAP_REJECTED", shared);
      this.#checkCompatibility(slot, fru);
      // A standby instance can call its needs from powerOn on; events reach it once installed.
      await this.#backplane.connect(neo);
      await neo.hook("powerOn", this.#hookTimeout);
      neo.poweredOn = true;
      await neo.hook("selfTest", this.#hookTimeout);
      // Background tasks are break-before-make: the old ones stop before the new ones start.
      if (old !== null && !old.dead) {
        deactivating = true;
        await old.hook("deactivate", this.#hookTimeout);
        old.active = false;
        deactivated = true;
      }
      if (old !== null && !old.dead && old.fru?.snapshot && fru.restore) {
        markers = await this.#backplane.hold(slot);
        held = true;
        if (!(await this.#backplane.drain(old, markers, this.#drainTimeout))) {
          throw new RackError(
            "RACK_SWAP_REJECTED",
            `${slot.name}: in-flight calls did not finish within ${this.#drainTimeout} ms of the state handover`,
          );
        }
        const state = await old.hook("snapshot", this.#hookTimeout);
        await neo.hook("restore", this.#hookTimeout, { state, from: old.firmware.hash });
      }
      await neo.hook("activate", this.#hookTimeout);
      neo.active = true;
      this.#requireRunning();
      // Every switch is held first, so two instances of the slot never both receive new calls.
      // @decision .agents/decisions/261116_024226-backplane-links.md#wiring-and-routing
      if (!held) {
        markers = await this.#backplane.hold(slot);
        held = true;
      }
      // The new instance may have exited while the hold waited; it must not be installed then.
      if (neo.dead) {
        throw new RackError(
          "RACK_SWAP_REJECTED",
          `${slot.name}: the new instance exited before the switch`,
        );
      }
    } catch (error) {
      // The new instance goes at once, but the wait for its thread comes after the old instance
      // serves again, so that a stuck new instance doesn't keep the old one waiting.
      const neoStopped = neo === undefined ? Promise.resolve(true) : this.#end(neo, slot.name);
      const failure = asRackError(error);
      // An old instance that began to deactivate activates again, which also has its watchdogs
      // watch it again. One that didn't answer deactivate, or doesn't activate again, can't keep
      // serving, and goes the way of a watchdog bite.
      // @decision .agents/decisions/261117_185131-ending-instances.md#failed-hot-swaps
      let lost: WireError | undefined;
      if (old !== null && !old.dead && deactivating) {
        if (!deactivated && timedOut(error)) {
          lost = {
            code: "RACK_DEVICE_FAULT",
            message: `${slot.name}: the old instance did not answer deactivate within ${this.#hookTimeout} ms`,
          };
        } else {
          try {
            await old.hook("activate", this.#hookTimeout);
            old.active = true;
          } catch (reactivation) {
            lost = {
              code: "RACK_DEVICE_FAULT",
              message: `${slot.name}: the old instance did not activate again: ${asRackError(reactivation).message}`,
            };
          }
        }
      }
      if (old !== null && lost !== undefined) {
        slot.installed = null;
        slot.state = "resetting";
        old.active = false;
        this.#log("error", lost.message, { firmware: old.firmware.hash });
        // Fail the calls in flight with the code of a crash before the end reports the rest.
        this.#backplane.disconnect(old, "RACK_DEVICE_FAULT", lost.message);
        await this.#end(old, slot.name);
      } else if (old !== null && !old.dead) {
        slot.state = "degraded";
      }
      if (held) await this.#backplane.release(slot);
      await neoStopped;
      slot.busy = false;
      const reported = this.#swapFailed(slot.name, "swap", from, firmware.hash, failure, slot);
      if (old !== null && lost !== undefined) this.#crashed(slot, old, lost);
      else if (old === null) slot.state = "faulted";
      else if (old.dead) this.#recover(slot);
      throw reported;
    }
    // Requests are make-before-break: the routes switch to the new instance in one step.
    // @decision .agents/decisions/261112_035943-hot-swap.md#the-swap-sequence
    slot.installed = neo;
    slot.firmware = firmware;
    slot.fru = neo.fru as Fru;
    slot.model = slot.fru.model;
    slot.height = slot.fru.height;
    slot.wiring = neo.wiring;
    slot.source = source;
    slot.state = "online";
    slot.error = undefined;
    slot.crashes = [];
    await this.#backplane.install(slot, neo, old);
    if (!neo.dead) this.#powered(neo);
    if (old !== null) await this.#retire(old, markers);
    slot.busy = false;
    this.#emit({
      type: "swap",
      device: slot.name,
      action: "swap",
      mode: "hot",
      from,
      to: firmware.hash,
    });
    this.#log("info", `${slot.name} swapped`, { from, to: firmware.hash });
    // A crash while the slot was busy was counted but not reset; the reset starts now.
    // @decision .agents/decisions/261115_222025-p0-api-details.md#resets
    if (neo.dead && slot.installed === null) this.#recover(slot);
  }

  async #plug(u: number, spec: SlotSpec): Promise<void> {
    this.#requireRunning();
    try {
      this.#requireHandPlaced();
    } catch (error) {
      throw this.#swapFailed(
        String(spec?.name ?? spec?.source),
        "plug",
        null,
        null,
        asRackError(error),
      );
    }
    if (!isSlotSpec(spec)) {
      throw new RackError("RACK_MANIFEST", "plug() requires a spec created by slot()");
    }
    if (!Number.isInteger(u) || u < 1 || u > this.#manifest.size) {
      throw new RackError("RACK_MANIFEST", `slot ${u} is outside 1..${this.#manifest.size}`);
    }
    const source = resolveSource(spec.source, this.#baseDir);
    const label = spec.name ?? source;
    let firmware: Firmware;
    try {
      firmware = await this.#build(source);
    } catch (error) {
      const failure = new RackError("RACK_SWAP_REJECTED", messageOf(error));
      throw this.#swapFailed(label, "plug", null, null, failure);
    }
    await this.#plugSlot(u, spec, firmware, label);
  }

  /** Boots, wires, powers on, and installs a new device at slot `u`. */
  async #plugSlot(u: number, spec: SlotSpec, firmware: Firmware, label: string): Promise<void> {
    let instance: Instance | undefined;
    try {
      instance = await this.#boot(firmware, spec.name, u, spec.config, "RACK_SWAP_REJECTED");
      const fru = instance.fru as Fru;
      checkDeviceName(fru.name);
      if (this.#slots.has(fru.name)) {
        throw new RackError("RACK_MANIFEST", `a device named ${fru.name} is already in the rack`);
      }
      this.#checkLayout([...this.#layout(), { name: fru.name, u, height: fru.height }]);
      instance.wiring = this.#wire(fru.name, u, fru, new Map());
      const shared = this.#ownershipProblem({ name: fru.name, fru, wiring: instance.wiring });
      if (shared !== undefined) throw new RackError("RACK_SWAP_REJECTED", shared);
      await this.#backplane.connect(instance);
      await this.#powerOn(instance);
      this.#requireRunning();
    } catch (error) {
      if (instance !== undefined) await this.#end(instance, instance.fru?.name ?? spec.name);
      const name = instance?.fru?.name ?? label;
      throw this.#swapFailed(name, "plug", null, firmware.hash, asRackError(error));
    }
    const slot = newSlot({ u, config: spec.config, firmware, instance });
    slot.wiring = instance.wiring;
    slot.state = "online";
    this.#slots.set(slot.name, slot);
    await this.#backplane.install(slot, instance, null);
    if (!instance.dead) this.#powered(instance);
    this.#emit({
      type: "swap",
      device: slot.name,
      action: "plug",
      mode: "plug",
      from: null,
      to: firmware.hash,
    });
    this.#log("info", `${slot.name} plugged in at U${u}`, { firmware: firmware.hash });
  }

  async #unplug(name: string): Promise<void> {
    this.#requireRunning();
    try {
      this.#requireHandPlaced();
    } catch (error) {
      const from = this.#slots.get(name)?.installed?.firmware.hash ?? null;
      throw this.#swapFailed(name, "unplug", from, null, asRackError(error));
    }
    const slot = this.#slots.get(name);
    if (slot === undefined || slot.removed) {
      throw new RackError("RACK_NO_ROUTE", `no device named ${name}`);
    }
    const from = slot.installed?.firmware.hash ?? null;
    if (slot.busy) {
      const busy = new RackError("RACK_SWAP_REJECTED", `${name} is resetting; try again later`);
      throw this.#swapFailed(name, "unplug", from, null, busy);
    }
    const users = this.#usersOf(name);
    if (users.length > 0) {
      const inUse = new RackError(
        "RACK_SWAP_REJECTED",
        `${name} is still used by ${users.join(", ")}`,
      );
      throw this.#swapFailed(name, "unplug", from, null, inUse);
    }
    await this.#unplugSlot(slot, from);
  }

  /**
   * Retires a device that nothing uses any more and removes its slot, once no thread of the
   * device runs. While one is stuck, the device stays in the rack, `faulted`.
   *
   * @throws RackError `RACK_DEVICE_FAULT` when a thread of the device is stuck.
   * @decision .agents/decisions/261117_185131-ending-instances.md#stuck-threads
   */
  async #unplugSlot(slot: Slot, from: string | null): Promise<void> {
    const { name } = slot;
    const jammed = (stuck: Stuck): RackError => {
      slot.removed = false;
      slot.busy = false;
      slot.state = "faulted";
      const failure = new RackError(
        "RACK_DEVICE_FAULT",
        `${name} stays in the rack: ${this.#stuckMessage(name, stuck)}`,
      );
      return this.#swapFailed(name, "unplug", from, null, failure, slot);
    };
    const before = this.#stuckDevice(name);
    if (before !== undefined) throw jammed(before);
    slot.removed = true;
    slot.busy = true;
    const instance = slot.installed;
    slot.installed = null;
    if (instance !== null) await this.#retire(instance);
    const stuck = this.#stuckDevice(name);
    if (stuck !== undefined) throw jammed(stuck);
    this.#slots.delete(name);
    this.#backplane.forget(name);
    this.#emit({ type: "swap", device: name, action: "unplug", mode: "unplug", from, to: null });
    this.#log("info", `${name} unplugged`);
  }

  // ---- Update safety ----

  /**
   * Replaces a device's firmware with an earlier one: by default the firmware before the
   * current one, undoing the update that installed it, together with its group.
   *
   * @decision .agents/decisions/261117_005743-fallback-rollback-and-history.md#active-rollback
   */
  async #rollback(name: string, to: string | undefined): Promise<ReloadResult[]> {
    this.#requireRunning();
    const slot = this.#slots.get(name);
    if (slot === undefined || slot.removed) {
      throw new RackError("RACK_NO_ROUTE", `no device named ${name}`);
    }
    const current = slot.firmware.hash;
    const reject = (message: string) =>
      this.#swapFailed(
        name,
        "swap",
        current,
        to ?? null,
        new RackError("RACK_SWAP_REJECTED", message),
        slot,
      );
    const last = this.#history.findLast(
      (record) =>
        record.device === name && record.ok && record.to === current && record.from !== null,
    );
    const target = to ?? last?.from ?? undefined;
    if (target === undefined || target === null)
      throw reject(`${name} has no earlier firmware to roll back to`);
    if (target === current) throw reject(`${name} already runs firmware ${target}`);
    // Undoing a group replacement takes the whole group back.
    const records =
      to === undefined && last?.group !== undefined
        ? this.#history.filter((record) => record.group === last.group && record.ok)
        : [{ device: name, from: target }];
    const members: Member[] = [];
    for (const record of records) {
      const member = this.#slots.get(record.device);
      const firmware = record.from === null ? undefined : this.#firmwares.get(record.from);
      if (member === undefined || member.removed) continue;
      if (firmware === undefined || !(await Bun.file(firmware.path).exists())) {
        throw reject(`firmware ${record.from} of ${record.device} is no longer kept`);
      }
      const fru = await this.#describeForSwap(firmware);
      // A rollback restores code only: the plan, with every need and its wire, stays as it runs.
      // Connectors may differ, as when a group undoes a contract change; the replacement checks them.
      const needs = (info: Fru) => Object.keys(info.needs).sort().join(",");
      if (needs(fru) !== needs(member.fru)) {
        throw reject(
          `firmware ${firmware.hash} of ${record.device} has other needs than the running plan`,
        );
      }
      members.push({ slot: member, firmware, source: firmware.source });
    }
    const only = members[0] as Member;
    if (members.length === 1 && only.slot.fru.swap !== "cold") {
      const fru = await this.#describeForSwap(only.firmware);
      if (fru.swap !== "cold") {
        const from = only.slot.installed?.firmware.hash ?? null;
        await this.#swapSlot(only.slot, only.firmware, only.source);
        return [{ device: name, from, to: only.firmware.hash, mode: "hot" }];
      }
    }
    const { results, error } = await this.#replaceAll(members, new Set());
    if (error !== undefined) throw error;
    return results;
  }

  /**
   * Starts a device again from its known-good firmware, fresh, after its new instance crashed on
   * probation; the slot reports `degraded`, with the crash as its error.
   *
   * @decision .agents/decisions/261117_005743-fallback-rollback-and-history.md#passive-fallback
   */
  async #fallBack(slot: Slot, crash: WireError): Promise<void> {
    const good = this.#knownGood.get(slot.name);
    const from = slot.firmware.hash;
    if (good === undefined || good.hash === from) {
      await this.#reset(slot);
      return;
    }
    this.#log(
      "warn",
      `${slot.name} crashed on probation; falling back to its known-good firmware`,
      {
        from,
        to: good.hash,
      },
    );
    slot.firmware = good;
    slot.source = good.source;
    await this.#reset(slot, crash);
    if (slot.installed !== null) {
      this.#emit({
        type: "swap",
        device: slot.name,
        action: "swap",
        mode: "restart",
        from,
        to: good.hash,
      });
    }
  }

  /**
   * Takes a group replaced together back to its known-good firmware after one of its devices
   * crashed on probation, so the providers and consumers keep matching contracts.
   */
  async #fallBackGroup(names: readonly string[], crashed: string, crash: WireError): Promise<void> {
    const members: Member[] = [];
    for (const name of names) {
      const slot = this.#slots.get(name);
      const good = this.#knownGood.get(name);
      if (slot === undefined || slot.removed || good === undefined) continue;
      members.push({ slot, firmware: good, source: good.source });
    }
    try {
      const context = { cause: "fallback" as const, started: Date.now(), crash };
      await updates.run(context, () =>
        this.#replaceCold(members, new Set([crashed]), { device: crashed, error: crash }),
      );
    } catch (error) {
      this.#log("error", "the group did not fall back to its known-good firmware", {
        error: toWireError(error),
      });
      const slot = this.#slots.get(crashed);
      if (slot !== undefined && slot.installed === null && !slot.busy) this.#recover(slot);
    }
  }

  /**
   * Puts the devices of a successful update on probation. A device whose firmware is its
   * known-good one needs none; with probation off, the new firmware is known-good at once.
   */
  #startProbation(names: readonly string[]): void {
    for (const name of names) {
      const slot = this.#slots.get(name);
      if (slot === undefined || slot.removed) continue;
      this.#endProbation(name);
      if (this.#probationMs === 0) {
        this.#knownGood.set(name, slot.firmware);
        continue;
      }
      if (this.#knownGood.get(name)?.hash === slot.firmware.hash) continue;
      const firmware = slot.firmware;
      const timer = setTimeout(() => {
        this.#probation.delete(name);
        if (this.#slots.get(name)?.firmware === firmware) this.#knownGood.set(name, firmware);
      }, this.#probationMs);
      timer.unref?.();
      this.#probation.set(name, { until: Date.now() + this.#probationMs, timer, group: names });
    }
  }

  #endProbation(name: string): void {
    const probation = this.#probation.get(name);
    if (probation === undefined) return;
    clearTimeout(probation.timer);
    this.#probation.delete(name);
  }

  /**
   * Deletes the bundles this rack built that nothing needs: no instance, no slot, no known-good
   * firmware, and no kept record. Bundles that other racks built are never touched.
   *
   * @decision .agents/decisions/261117_005743-fallback-rollback-and-history.md#update-history
   */
  async #collectGarbage(): Promise<void> {
    const keep = new Set<string>();
    for (const instance of this.#instances) keep.add(instance.firmware.hash);
    for (const slot of this.#slots.values()) keep.add(slot.firmware.hash);
    for (const firmware of this.#knownGood.values()) keep.add(firmware.hash);
    for (const record of this.#history) {
      if (record.from !== null) keep.add(record.from);
      if (record.to !== null) keep.add(record.to);
    }
    for (const [path, firmware] of this.#built) {
      if (keep.has(firmware.hash)) continue;
      this.#built.delete(path);
      if (this.#firmwares.get(firmware.hash) === firmware) this.#firmwares.delete(firmware.hash);
      await unlink(path).catch(() => {
        // Already gone, for example removed with .rack/; there is nothing left to delete.
      });
    }
  }

  /** Records a swap event in the history, and puts a successful update on probation. */
  #record(event: Extract<RackEvent, { type: "swap" }>, group?: GroupKey): void {
    const context = updates.getStore();
    const record: UpdateRecord = {
      seq: ++this.#seq,
      time: context?.started ?? Date.now(),
      device: event.device,
      mode: event.mode,
      cause:
        context?.cause ??
        (event.mode === "plug" || event.mode === "unplug" ? event.mode : "reload"),
      from: event.from,
      to: event.to,
      ok: event.error === undefined,
    };
    // A fallback succeeds, and its record keeps the crash that caused it.
    const error = event.error ?? (context?.cause === "fallback" ? context.crash : undefined);
    if (error !== undefined) record.error = error;
    if (group !== undefined) {
      group.seq ??= record.seq;
      record.group = group.seq;
    }
    this.#history.push(record);
    if (this.#history.length > this.#historyLimit) this.#history.shift();
    if (event.mode === "unplug") {
      this.#endProbation(event.device);
      if (record.ok) this.#knownGood.delete(event.device);
    } else if (event.mode === "plug" && record.ok) {
      const slot = this.#slots.get(event.device);
      if (slot !== undefined) this.#knownGood.set(event.device, slot.firmware);
    } else if (record.ok && record.cause !== "fallback") {
      this.#startProbation(group?.devices ?? [event.device]);
    }
  }

  // ---- Instances ----

  /**
   * Starts a Worker for a firmware and boots it. No instance of a device starts while a thread
   * of an earlier one may still run: the rack waits for the threads it is ending, and refuses
   * while one is stuck.
   *
   * @param name The device's name; `undefined` when the firmware's FRU data names it.
   * @throws RackError `RACK_SWAP_REJECTED` while a thread of the device, or of the firmware
   *   loaded without a name, is stuck; `code`, or `RACK_INVALID_CONFIG`, when the boot fails.
   */
  async #boot(
    firmware: Firmware,
    name: string | undefined,
    u: number,
    config: unknown,
    code: "RACK_MANIFEST" | "RACK_SWAP_REJECTED",
  ): Promise<Instance> {
    // @decision .agents/decisions/261117_185131-ending-instances.md#stuck-threads
    if (name !== undefined) await this.#stopping(name);
    const stuck =
      (name === undefined ? undefined : this.#stuckDevice(name)) ??
      this.#stuckFirmware(firmware.hash);
    if (stuck !== undefined) {
      throw new RackError("RACK_SWAP_REJECTED", this.#stuckMessage(name ?? firmware.source, stuck));
    }
    const instance = new Instance(firmware, name ?? firmware.source, this);
    this.#instances.add(instance);
    try {
      await instance.boot({
        name,
        u,
        config,
        baseDir: this.#baseDir,
        callTimeout: this.#callTimeout,
        watchdog: this.#watchdog,
        queueLimit: this.#queueLimit,
        timeout: this.#hookTimeout,
      });
      return instance;
    } catch (error) {
      await this.#end(instance, name);
      const failure = asRackError(error);
      if (failure.code === "RACK_INVALID_CONFIG") throw failure;
      throw new RackError(code, `${firmware.source}: ${failure.message}`, {
        cause: toWireError(failure),
      });
    }
  }

  async #powerOn(instance: Instance): Promise<void> {
    await instance.hook("powerOn", this.#hookTimeout);
    instance.poweredOn = true;
    await instance.hook("selfTest", this.#hookTimeout);
    await instance.hook("activate", this.#hookTimeout);
    instance.active = true;
  }

  /**
   * Runs the hooks that power an instance down: `deactivate` when it is active, a drain of its
   * calls, `snapshot` when asked, and `powerOff`. A hook that the instance doesn't answer within
   * `hookTimeout` is its last: its calls fail with `RACK_DEVICE_FAULT`, and the rest is skipped.
   *
   * @param markers Hold markers of the switch that retired the instance; calls sent before
   *   them still reach it and must finish first.
   * @returns The snapshot and the firmware it came from, when one was asked for and taken.
   * @decision .agents/decisions/261117_185131-ending-instances.md#ending-an-instance
   */
  async #powerDown(
    instance: Instance,
    markers: Marker[],
    takeSnapshot = false,
  ): Promise<{ state: unknown; from: string } | undefined> {
    if (instance.dead) return undefined;
    const silent = () =>
      this.#backplane.fail(
        instance,
        "RACK_DEVICE_FAULT",
        `${instance.slot} stopped answering while it powered off`,
      );
    const answered = !instance.active || (await this.#bestEffort(instance, "deactivate"));
    instance.active = false;
    if (!answered) {
      silent();
      return undefined;
    }
    if (!(await this.#backplane.drain(instance, markers, this.#drainTimeout))) {
      this.#backplane.fail(
        instance,
        "RACK_LINK_DOWN",
        `${instance.slot} was powered off before the call finished`,
      );
    }
    let saved: { state: unknown; from: string } | undefined;
    if (takeSnapshot && instance.fru?.snapshot && !instance.dead) {
      try {
        const state = await instance.hook("snapshot", this.#hookTimeout);
        saved = { state, from: instance.firmware.hash };
      } catch (error) {
        this.#log(
          "error",
          `${instance.slot}: snapshot failed; the new instance starts without it`,
          {
            error: toWireError(error),
          },
        );
        if (timedOut(error)) {
          silent();
          return undefined;
        }
      }
    }
    if (instance.poweredOn && !instance.dead) await this.#bestEffort(instance, "powerOff");
    return saved;
  }

  /**
   * Powers an instance down and ends it.
   *
   * @param markers As for {@link #powerDown}.
   * @returns Whether its thread stopped within `hookTimeout`.
   */
  async #retire(instance: Instance, markers: Marker[] = []): Promise<boolean> {
    const wasAlive = !instance.dead;
    await this.#powerDown(instance, markers);
    const stopped = this.#end(instance, instance.slot);
    if (wasAlive) this.#poweredOff(instance);
    return stopped;
  }

  /**
   * Ends an instance: terminates its Worker and waits for the thread to stop, up to
   * `hookTimeout`. A thread that hasn't stopped by then is stuck, and the rack keeps a record
   * of it until it stops. Every path that ends an instance goes through here.
   *
   * @param device The device the instance belongs to; `undefined` for a Worker that loaded
   *   firmware without a name.
   * @returns Whether the thread stopped in time.
   * @decision .agents/decisions/261117_185131-ending-instances.md#ending-an-instance
   */
  #end(instance: Instance, device: string | undefined): Promise<boolean> {
    const ending = this.#ending.get(instance);
    if (ending !== undefined) return ending.done;
    if (this.#stuck.has(instance)) return Promise.resolve(false);
    const done = instance.end(this.#hookTimeout).then((stopped) => {
      this.#ending.delete(instance);
      if (!stopped) this.#addStuck(instance, device);
      return stopped;
    });
    this.#ending.set(instance, { device, done });
    return done;
  }

  /** Waits until the rack ends no thread of the device any more: each stopped, or is stuck. */
  async #stopping(device: string): Promise<void> {
    const pending = [...this.#ending.values()].filter((ending) => ending.device === device);
    await Promise.all(pending.map((ending) => ending.done));
  }

  /**
   * Records a stuck thread and reports it, then forgets it once the thread stops.
   *
   * @decision .agents/decisions/261117_185131-ending-instances.md#stuck-threads
   */
  #addStuck(instance: Instance, device: string | undefined): void {
    const stuck: Stuck = {
      device,
      firmware: instance.firmware.hash,
      since: instance.terminatedAt ?? Date.now(),
    };
    this.#stuck.set(instance, stuck);
    const what = device ?? instance.firmware.source;
    const error: WireError = {
      code: "RACK_DEVICE_FAULT",
      message: `${what}: the thread of firmware ${stuck.firmware} did not stop within ${this.#hookTimeout} ms of its termination; it is stuck in native code`,
    };
    const blocks =
      device === undefined
        ? "The rack doesn't load this firmware again until the thread stops"
        : `No other instance of ${device} starts until the thread stops`;
    this.#log(
      "error",
      `${error.message}. ${blocks}; only a restart of the rack reclaims a thread that never stops.`,
    );
    if (device !== undefined) {
      this.#emit({ type: "fault", device, firmware: stuck.firmware, error, reset: false });
    }
    void instance.closed.then(() => {
      if (!this.#stuck.delete(instance)) return;
      this.#log("info", `${what}: the stuck thread of firmware ${stuck.firmware} stopped`, {
        stuckMs: Date.now() - stuck.since,
      });
    });
  }

  /** A stuck thread of the device. */
  #stuckDevice(name: string): Stuck | undefined {
    for (const stuck of this.#stuck.values()) if (stuck.device === name) return stuck;
    return undefined;
  }

  /** A stuck thread of a Worker that loaded the firmware without a name. */
  #stuckFirmware(hash: string): Stuck | undefined {
    for (const stuck of this.#stuck.values()) {
      if (stuck.device === undefined && stuck.firmware === hash) return stuck;
    }
    return undefined;
  }

  /** Why nothing of `what` starts while `stuck` runs. */
  #stuckMessage(what: string, stuck: Stuck): string {
    const since = new Date(stuck.since).toISOString();
    return `${what}: a thread of firmware ${stuck.firmware} has been stuck in native code since ${since}; nothing of it starts until that thread stops, or the rack restarts`;
  }

  /** Announces that an instance has powered off. */
  #poweredOff(instance: Instance): void {
    this.#emit({
      type: "power",
      device: instance.slot,
      firmware: instance.firmware.hash,
      state: "off",
    });
    this.#log("info", `${instance.slot} powered off`, { firmware: instance.firmware.hash });
  }

  /**
   * Runs a hook whose failure doesn't stop what the rack is doing, and logs the failure.
   *
   * @returns `false` when the instance didn't answer within `hookTimeout`.
   */
  async #bestEffort(instance: Instance, hook: "deactivate" | "powerOff"): Promise<boolean> {
    try {
      await instance.hook(hook, this.#hookTimeout);
      return true;
    } catch (error) {
      this.#log("warn", `${instance.slot}: ${hook} failed`, { error: toWireError(error) });
      return !timedOut(error);
    }
  }

  #powered(instance: Instance): void {
    this.#emit({
      type: "power",
      device: instance.slot,
      firmware: instance.firmware.hash,
      state: "on",
    });
    this.#log("info", `${instance.slot} powered on`, { firmware: instance.firmware.hash });
  }

  // ---- Faults ----

  /** Records a crash; returns whether the slot may reset. */
  #countCrash(slot: Slot, firmware: string, error: WireError): boolean {
    const now = Date.now();
    const window = crashWindow(slot.longestWatchdog);
    slot.crashes = slot.crashes.filter((time) => now - time < window);
    slot.crashes.push(now);
    slot.error = error;
    const reset = slot.crashes.length <= CRASH_LIMIT;
    if (!reset) slot.state = "faulted";
    this.#emit({ type: "fault", device: slot.name, firmware, error, reset });
    if (!reset) {
      this.#log(
        "error",
        `${slot.name} faulted after ${slot.crashes.length} crashes within ${window / 1000} s`,
      );
    }
    return reset;
  }

  /** After a failed swap lost the old instance: reset, or stay faulted at the crash limit. */
  #recover(slot: Slot): void {
    const now = Date.now();
    const window = crashWindow(slot.longestWatchdog);
    const recent = slot.crashes.filter((time) => now - time < window).length;
    if (recent > CRASH_LIMIT) slot.state = "faulted";
    else void this.#reset(slot);
  }

  /**
   * Resets a slot from the same firmware: a new instance runs `powerOn`, `selfTest`, and
   * `activate`. A failed attempt counts as another crash. While a thread of the device is
   * stuck, the slot is faulted instead.
   *
   * @param fallback For a fallback, the crash on probation that caused it: the slot reports
   *   `degraded`, with this error, from the moment the new instance is installed.
   */
  async #reset(slot: Slot, fallback?: WireError): Promise<void> {
    slot.busy = true;
    slot.state = "resetting";
    try {
      while (this.#phase === "running" && !slot.removed) {
        // @decision .agents/decisions/261117_185131-ending-instances.md#stuck-threads
        await this.#stopping(slot.name);
        const stuck = this.#stuckDevice(slot.name);
        if (stuck !== undefined) {
          const failure = new RackError("RACK_DEVICE_FAULT", this.#stuckMessage(slot.name, stuck));
          slot.state = "faulted";
          slot.error = toWireError(failure);
          this.#log("error", `${slot.name} faulted instead of resetting: ${failure.message}`);
          return;
        }
        this.#log("warn", `${slot.name} resetting`, { crashes: slot.crashes.length });
        let instance: Instance | undefined;
        try {
          instance = await this.#boot(
            slot.firmware,
            slot.name,
            slot.u,
            slot.config,
            "RACK_MANIFEST",
          );
          instance.wiring = slot.wiring;
          await this.#backplane.connect(instance);
          await this.#powerOn(instance);
          if (this.#phase !== "running" || slot.removed) {
            await this.#end(instance, slot.name);
            return;
          }
          slot.installed = instance;
          slot.fru = instance.fru as Fru;
          // The state is final before the install awaits, so status() never shows a fallback
          // online in between.
          slot.state = fallback === undefined ? "online" : "degraded";
          if (fallback !== undefined) slot.error = fallback;
          await this.#backplane.install(slot, instance, null);
          if (instance.dead) {
            // It exited while it was being installed. onExit counted the crash and left the
            // reset to this loop, which was still running; at the crash limit it set the slot
            // faulted during the await, which narrowing on the assignment above cannot see.
            if ((slot.state as SlotState) === "faulted") return;
            slot.state = "resetting";
            continue;
          }
          this.#powered(instance);
          return;
        } catch (error) {
          if (instance !== undefined) await this.#end(instance, slot.name);
          if (this.#phase !== "running") return;
          if (!this.#countCrash(slot, slot.firmware.hash, toWireError(error))) return;
        }
      }
    } finally {
      slot.busy = false;
    }
  }

  // ---- Reporting ----

  #status(): SlotStatus[] {
    if (this.#phase === "stopped") return [];
    const now = Date.now();
    const owners = this.#owners();
    return this.#ordered().map((slot) => {
      const status: SlotStatus = {
        name: slot.name,
        model: slot.model,
        u: slot.u,
        height: slot.height,
        state: slot.state,
        firmware: slot.installed?.firmware.hash ?? null,
        source: slot.source,
        inFlight: slot.installed?.serving ?? 0,
        crashes: slot.crashes.filter((time) => now - time < crashWindow(slot.longestWatchdog))
          .length,
        knownGood: this.#knownGood.get(slot.name)?.hash ?? null,
        watchdogs: slot.installed?.watchdogs ?? [],
        stuck: [...this.#stuck.values()]
          .filter((stuck) => stuck.device === slot.name)
          .map(({ firmware, since }) => ({ firmware, since })),
      };
      const owner = owners.get(slot.name);
      if (owner !== undefined) status.owner = owner;
      const probation = this.#probation.get(slot.name);
      if (probation !== undefined) status.probationUntil = probation.until;
      if (slot.error !== undefined) status.error = slot.error;
      return status;
    });
  }

  async #metrics(): Promise<RackMetrics> {
    if (this.#phase !== "running") return { devices: [], outside: { ports: {}, unrouted: 0 } };
    const instances: Instance[] = [];
    for (const slot of this.#ordered()) {
      if (slot.installed !== null && !slot.removed) instances.push(slot.installed);
    }
    const answers = await Promise.allSettled(
      instances.map((instance) => instance.metrics(this.#hookTimeout)),
    );
    const devices: DeviceMetrics[] = [];
    for (const [index, answer] of answers.entries()) {
      const instance = instances[index] as Instance;
      // An instance that died or did not answer in time is left out.
      if (answer.status === "fulfilled") {
        devices.push({ device: instance.slot, firmware: instance.firmware.hash, ...answer.value });
      }
    }
    return { devices, outside: this.#backplane.outside() };
  }

  #swapFailed(
    device: string,
    action: SwapAction,
    from: string | null,
    to: string | null,
    error: RackError,
    slot?: Slot,
    mode: ReloadMode = action === "swap" ? "hot" : action,
    group?: GroupKey,
  ): RackError {
    const wire = toWireError(error);
    if (slot !== undefined) slot.error = wire;
    this.#emit({ type: "swap", device, action, mode, from, to, error: wire }, group);
    this.#log("error", `${action} of ${device} failed: ${wire.message}`, { code: wire.code });
    return error;
  }

  #emit(event: RackEvent, group?: GroupKey): void {
    if (event.type === "swap") this.#record(event, group);
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // A failing listener must not break the rack or the other listeners.
      }
    }
  }

  #log(level: LogEntry["level"], message: string, data?: unknown, device?: string): void {
    const entry: LogEntry = { time: Date.now(), level, message };
    if (device !== undefined) entry.device = device;
    if (data !== undefined) entry.data = data;
    try {
      this.#logger(entry);
    } catch {
      // A failing logger must not break the rack; listeners still receive the entry.
    }
    this.#emit({ type: "log", ...entry });
  }

  #ordered(): Slot[] {
    return [...this.#slots.values()].sort((a, b) => a.u - b.u);
  }

  #layout(): Layout[] {
    return this.#ordered()
      .filter((slot) => !slot.removed)
      .map(({ name, u, height }) => ({ name, u, height }));
  }
}

/** An instance being ended: the device it belongs to, and whether its thread stopped in time. */
interface Ending {
  /** The device's name; `undefined` for a Worker that loaded firmware without a name. */
  device: string | undefined;
  done: Promise<boolean>;
}

/** A stuck thread: the instance's {@link StuckThread} status, and the device it belongs to. */
interface Stuck extends StuckThread {
  /** As in {@link Ending}; a stuck thread without a device keeps its firmware from loading. */
  device: string | undefined;
}

interface Booted {
  u: number;
  config: unknown;
  firmware: Firmware;
  instance: Instance;
}

/** What an update runs for: its cause and start time, and for a fallback, the crash. */
interface UpdateContext {
  cause: UpdateCause;
  started: number;
  crash?: WireError;
}

/**
 * The cause of the update in progress. It travels with the operation through every await, so
 * a fallback that a crash starts in the middle of a reload keeps its own cause.
 */
const updates = new AsyncLocalStorage<UpdateContext>();

/** Shared by the records of one group replacement. */
interface GroupKey {
  /** `seq` of the group's first record, once it has one. */
  seq?: number;
  devices: readonly string[];
}

/** One device of a replacement, with the firmware it gets. */
interface Member {
  slot: Slot;
  firmware: Firmware;
  /** Absolute path of the device file the firmware was built from. */
  source: string;
}

/** What a slot had before a cold replacement, to restore it when the replacement fails. */
interface SlotRecord {
  /** It had an instance, alive or not, to start again. */
  running: boolean;
  fields: Pick<Slot, "firmware" | "fru" | "model" | "height" | "wiring" | "source">;
}

function snapshotOf(slot: Slot): SlotRecord {
  const { firmware, fru, model, height, wiring, source } = slot;
  return {
    running: slot.installed !== null,
    fields: { firmware, fru, model, height, wiring, source },
  };
}

/** Describes why a provided port no longer serves a need. */
function misfit(
  user: string,
  provider: string,
  portName: string,
  port: ConnectorInfo | undefined,
  need: ConnectorInfo | undefined,
): string {
  if (port === undefined) {
    return `${user} uses ${provider}.${portName}, which the new firmware does not provide`;
  }
  return `${user} needs ${need?.id}; the new ${provider}.${portName} is ${port.id} with members ${Object.keys(port.members).join(", ")}`;
}

/** Whether a provided port still serves a need: the same connector, with every member it uses. */
function fits(port: ConnectorInfo | undefined, need: ConnectorInfo | undefined): boolean {
  if (need === undefined) return true;
  return port !== undefined && port.id === need.id && covers(port, need);
}

/** Where a device of a target layout sits, and what it is made from. */
interface TargetDevice {
  u: number;
  /** Absolute path of the device file. */
  source: string;
  config: unknown;
}

/** A layout to move a running rack to. */
interface Target {
  devices: ReadonlyMap<string, TargetDevice>;
  patch: ReadonlyArray<readonly [string, string]>;
  /** The plan of a scanned rack that the layout comes from. */
  plan: Plan | undefined;
}

/** A change of layout in progress. */
interface Change {
  target: Target;
  /** Devices whose configuration changed, replaced even when their firmware did not. */
  forced: Set<string>;
  /** Devices that leave, unplugged once nothing uses them. */
  leaving: Slot[];
  /** Results of the plugs so far. */
  results: ReloadResult[];
}

/** A device to boot into a slot. */
interface Entry {
  u: number;
  spec: SlotSpec;
  /** Absolute path of the device file. */
  source: string;
}

/** A model of a scanned rack: what it declares, its file, and its default configuration. */
interface ModelSource {
  type: PlanType;
  source: string;
  config: unknown;
  /** A `slot()` spec named it, rather than a directory scan alone. */
  explicit: boolean;
}

/** How a plan file compares with the plan the devices give now. */
export type PlanFileState = "missing" | "fits" | "reordered" | "differs";

/** What {@link planRack} reports. */
export interface PlanReport {
  /** The plan in the format of the plan file; for a rack placed by hand, its layout. */
  text: string;
  /** Models of a scanned rack that nothing uses. */
  unused: string[];
  /** For a scanned rack: its plan file, and how the file compares with the plan. */
  file: { path: string; state: PlanFileState; differences: string[] } | undefined;
}

/**
 * Works out a rack's plan without starting it: builds, boots, and wires every device as
 * `start()` would, then terminates them. Used by `rack plan`.
 *
 * @param manifest A manifest created by `rack()`.
 * @param options Start options; `plan` is ignored.
 * @param write Write the plan file of a scanned rack.
 * @returns The plan, and how an existing plan file compares with it.
 * @throws RackError like `start()`.
 * @decision .agents/decisions/261116_233919-automatic-assembly.md#commands-and-management
 */
export async function planRack(
  manifest: RackManifest,
  options: StartOptions = {},
  write = false,
): Promise<PlanReport> {
  if (!isRackManifest(manifest)) {
    throw new RackError("RACK_MANIFEST", "planRack() requires a manifest created by rack()");
  }
  return new Rack(manifest, { ...options, plan: false }).dryRun(write);
}

/** The wiring of a plan, as patches. */
function patchesOf(plan: Plan): (readonly [string, string])[] {
  return plan.instances.flatMap((instance) =>
    Object.entries(instance.wiring).map(
      ([need, wire]) => [`${instance.name}.${need}`, `${wire.provider}.${wire.port}`] as const,
    ),
  );
}

/**
 * Lists the device files below a directory: `.ts`, `.tsx`, `.js`, and `.mjs` files at any depth,
 * skipping `node_modules` and names that start with `_` or `.`.
 *
 * @decision .agents/decisions/261116_233919-automatic-assembly.md#scanned-manifests
 */
async function deviceFiles(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    throw new RackError("RACK_MANIFEST", `cannot scan ${dir}: ${messageOf(error)}`);
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const files: string[] = [];
  for (const entry of entries) {
    const { name } = entry;
    if (name === "node_modules" || name.startsWith("_") || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (entry.isDirectory()) files.push(...(await deviceFiles(path)));
    else if (entry.isFile() && /\.(ts|tsx|js|mjs)$/.test(name) && !name.endsWith(".d.ts")) {
      files.push(path);
    }
  }
  return files;
}

/**
 * Fails a call from outside the rack while the rack is not running. The call still takes the
 * buffers it transfers, as every call does whatever its outcome.
 *
 * @decision .agents/decisions/261116_213839-transfer-and-shared-buffers.md#transfer
 */
function refuse(where: string, options: CallOptions): Promise<never> {
  try {
    const transfer = transferList(options.transfer, where);
    if (transfer !== undefined) detach(transfer);
  } catch (error) {
    return Promise.reject(error);
  }
  return Promise.reject(new RackError("RACK_LINK_DOWN", "the rack is not running"));
}

function newSlot({ u, config, firmware, instance }: Booted): Slot {
  const fru = instance.fru as Fru;
  return {
    name: fru.name,
    u,
    height: fru.height,
    model: fru.model,
    source: firmware.source,
    config,
    firmware,
    fru,
    wiring: new Map(),
    installed: instance,
    state: "swapping",
    busy: false,
    held: false,
    queue: [],
    unfinished: 0,
    crashes: [],
    longestWatchdog: 0,
    error: undefined,
    removed: false,
  };
}

function covers(provider: ConnectorInfo, need: ConnectorInfo): boolean {
  return Object.entries(need.members).every(([member, kind]) => provider.members[member] === kind);
}

function requireCover(
  where: string,
  target: string,
  provider: ConnectorInfo,
  need: ConnectorInfo,
): void {
  const missing = Object.entries(need.members)
    .filter(([member, kind]) => provider.members[member] !== kind)
    .map(([member]) => member);
  if (missing.length > 0) {
    throw new RackError(
      "RACK_MANIFEST",
      `${where} -> ${target}: the provider lacks ${missing.join(", ")}`,
    );
  }
}

function isHttpPort(info: ConnectorInfo): boolean {
  return info.id === "http/v1" && info.members.handle === "rpc";
}

function resolveSource(source: string | URL, baseDir: string): string {
  if (source instanceof URL) return Bun.fileURLToPath(source);
  return resolvePath(baseDir, source);
}

function asRackError(error: unknown): RackError {
  if (error instanceof RackError) return error;
  return new RackError("RACK_DEVICE_FAULT", messageOf(error));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positive(name: string, value: number): number {
  if (!(typeof value === "number" && Number.isFinite(value) && value > 0)) {
    throw new RackError("RACK_MANIFEST", `${name} must be a positive number of milliseconds`);
  }
  return value;
}

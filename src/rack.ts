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
 * @decision .agents/decisions/261120_011627-single-executables.md
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#the-rack-keeps-its-recent-events
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Dirent } from "node:fs";
import { readdir, rename, stat, unlink } from "node:fs/promises";
import { basename, join, relative, resolve as resolvePath, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Backplane, type EveryWiring, type Slot } from "./backplane.ts";
import { type ConnectorInfo, isConnectorId } from "./connector.ts";
import { alive, type Control, openControl } from "./control.ts";
import type { CallOptions } from "./device.ts";
import { RackError, toWireError, type WireError } from "./errors.ts";
import {
  buildFirmware as buildBundle,
  explainMissingPackage,
  type Firmware,
  type PackagedBuild,
  sweepFirmware,
} from "./firmware.ts";
import { Instance, type InstanceHost, timedOut, type Wire } from "./instance.ts";
import { bigints, consoleLogger, detailText, type LogEntry, type Logger } from "./log.ts";
import {
  checkDeviceName,
  isRackManifest,
  isSlotSpec,
  slot as mountSpec,
  parseAddress,
  type RackManifest,
  rack as rackManifest,
  type ScanSpec,
  type SlotSpec,
} from "./manifest.ts";
import type { DeviceMetrics, RackMetrics } from "./metrics.ts";
import { hasOutsideFile, keyOfSource, type Packaged, packaged, sourceOfKey } from "./packaged.ts";
import {
  fitPlan,
  formatInstance,
  formatPlan,
  makePlan,
  type Plan,
  type PlannedInstance,
  type PlanType,
  parsePlan,
  placeHotplug,
  type RunningInstance,
} from "./plan.ts";
import {
  type DataFromWorker,
  type Fru,
  type InheritedListener,
  type InjectedFault,
  type LogNotice,
  type Marker,
  type MemberInfo,
  QUEUE_LIMIT,
  type ReserveAsk,
  WATCHDOG_MIN,
} from "./protocol.ts";
import type {
  EventRecord,
  ListenerStatus,
  RackEvent,
  ReloadMode,
  ReloadResult,
  SlotState,
  SlotStatus,
  StuckThread,
  SwapAction,
  UpdateCause,
  UpdateRecord,
} from "./reports.ts";
import { cancelStreams } from "./streams.ts";
import { detach, transferList } from "./transfer.ts";

export type {
  EventRecord,
  ListenerStatus,
  RackEvent,
  ReloadMode,
  ReloadResult,
  SlotState,
  SlotStatus,
  StuckThread,
  SwapAction,
  UpdateCause,
  UpdateRecord,
} from "./reports.ts";

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
  /**
   * Lets `injectFault()` make a device crash or hang on purpose, for tests; default false, so
   * that a rack in production refuses it. The bench allows it always.
   */
  faultInjection?: boolean;
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
   *   longer fits, or when the manifest changes the rack's name or kind.
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
   * Reads the rack's feed of recent events: the events that `subscribe()` delivers, apart from
   * log entries of level `debug`, as records numbered from 1 when the rack starts. It answers at
   * once, and after `stop()` too. The rack keeps the last 1 000 records, in memory; a record
   * longer than 4 096 characters as JSON loses its details, has its messages cut, and carries
   * `cut: true`.
   *
   * @param after Only the records whose `seq` is greater: a whole number, 0 or more. A first
   *   record whose `seq` is greater than `after + 1` means that the records between them dropped
   *   out before they were read.
   * @returns The records, oldest first; without `after`, every record the rack keeps.
   * @throws RackError `RACK_INVALID_INPUT` for an `after` that isn't a whole number of 0 or more.
   */
  events(after?: number): EventRecord[];
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
  /**
   * Makes a device crash or hang on purpose, for a test of its recovery, through the paths of a
   * real fault: `"crash"` throws an uncaught exception in its Worker, and `"hang"` blocks its
   * event loop until the event-loop watchdog bites. It resolves once the Worker has taken the
   * fault, before the crash or the bite, and waits for the management operations before it.
   *
   * @throws RackError `RACK_NO_ROUTE` for an unknown device; `RACK_SWAP_REJECTED` in a rack
   *   started without `faultInjection`, or for a hang while watchdogs are off; `RACK_INVALID_INPUT`
   *   for another kind; and `RACK_LINK_DOWN` when the device has no installed instance.
   */
  injectFault(name: string, kind: InjectedFault): Promise<void>;
  /** Powers devices off from the top down, so that panels stop listening first. */
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
 * Starts a rack: builds the firmware, boots and checks every device, and powers them on from the
 * bottom up; each device's listeners listen once it is active.
 *
 * @param manifest A manifest created by `rack()`.
 * @param options Base directory, logger, and timeouts.
 * @returns The rack handle.
 * @throws RackError `RACK_MANIFEST`, `RACK_INVALID_CONFIG`, or `RACK_HOOK_FAILED`; devices
 *   that were already powered on are powered off again first.
 */
/** The key of the handle's reload of hot-plug devices alone; not part of the public API. */
const RELOAD_HOTPLUG: unique symbol = Symbol("racku.reloadHotplug");
/** The key of the handle's sweep of firmware that nothing needs; not part of the public API. */
const SWEEP_FIRMWARE: unique symbol = Symbol("racku.sweepFirmware");

/**
 * Deletes the firmware of earlier runs that a rack doesn't need, once it holds its base
 * directory's management endpoint, as `rack start` does after it opens one.
 *
 * @decision .agents/decisions/261122_011655-security-review-fixes.md#code-loading-and-the-files-the-rack-writes
 */
export function sweepUnneededFirmware(running: RackHandle): Promise<void> {
  const sweep = (running as { [SWEEP_FIRMWARE]?: () => Promise<void> })[SWEEP_FIRMWARE];
  if (sweep === undefined) throw new RackError("RACK_NO_ROUTE", "not a rack handle");
  return sweep();
}

/** The files of a firmware on disk: none for firmware packaged inside an executable. */
function filesOf(firmware: Firmware): readonly string[] {
  return firmware.files ?? (firmware.packaged ? [] : [firmware.path]);
}

/**
 * Writes a file whole: to a new file, renamed into place, so that a crash leaves either the old
 * file or the new one, never one written halfway.
 *
 * @decision .agents/decisions/261122_011655-security-review-fixes.md#code-loading-and-the-files-the-rack-writes
 */
async function writeWhole(path: string, text: string): Promise<void> {
  const draft = `${path}.${process.pid}.tmp`;
  await Bun.write(draft, text);
  await rename(draft, path);
}

/**
 * Reloads the hot-plug devices of a rack alone: the watch of `rack start` applies their changes,
 * and leaves the fixed instances to `rack ctl reload`.
 *
 * @decision .agents/decisions/261121_065823-hot-plug-directories.md#when-changes-apply
 */
export function reloadHotplug(running: RackHandle): Promise<ReloadResult[]> {
  const reload = (running as { [RELOAD_HOTPLUG]?: () => Promise<ReloadResult[]> })[RELOAD_HOTPLUG];
  if (reload === undefined) throw new RackError("RACK_NO_ROUTE", "not a rack handle");
  return reload();
}

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
  /** When this rack began to start; firmware written before it may be an earlier run's. */
  readonly #begun = Date.now();
  readonly #logger: Logger;
  readonly #callTimeout: number;
  readonly #hookTimeout: number;
  readonly #drainTimeout: number;
  readonly #planMode: boolean | "update";
  /** Patches in effect: the manifest's, or the wiring of a scanned rack's plan. */
  #patch: ReadonlyArray<readonly [string, string]>;
  /** The plan a scanned rack runs. */
  #plan: Plan | undefined;
  /**
   * FRU data of firmware described for planning: by hash, and for needs that come from the
   * configuration by hash and configuration; see `describedKey`.
   */
  readonly #described = new Map<string, Fru>();
  readonly #probationMs: number;
  readonly #historyLimit: number;
  /** Timeout of the event-loop watchdogs, or 0 when watchdogs are off. */
  readonly #watchdog: number;
  readonly #faultInjection: boolean;
  /** The most unfinished calls of a need, or from outside the rack to a device. */
  readonly #queueLimit: number;
  /** Update records, oldest first, at most `#historyLimit`. */
  readonly #history: UpdateRecord[] = [];
  #seq = 0;
  /**
   * The feed of recent events, oldest first, at most {@link FEED_LIMIT} records. Each is kept as
   * its JSON text, so that the text bounds its memory, and a read only parses it.
   *
   * @decision .agents/decisions/261124_055114-rack-dashboard.md#the-rack-keeps-its-recent-events
   */
  readonly #feed: string[] = [];
  /** The `seq` of the feed's newest record; 0 before the first. */
  #feedSeq = 0;
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
  /**
   * The rack's table of listeners: the addresses each instance reserved, until its thread
   * stops, which a thread stuck in native code doesn't.
   *
   * @decision .agents/decisions/261118_070617-panels-as-devices.md#conflicts
   */
  readonly #addresses = new Map<Instance, Address[]>();
  /**
   * The ports each device's listeners got, which its later instances keep, until the device is
   * unplugged or the rack stops.
   *
   * @decision .agents/decisions/261118_070617-panels-as-devices.md#port-0
   */
  readonly #ports = new Map<string, Omit<InheritedListener, "held">[]>();
  #phase: Phase = "starting";
  readonly #controlOption: StartOptions["control"];
  #control: Control | undefined;
  #startFault: RackError | undefined;
  /**
   * The hot-plug devices that crashed or bit while the rack started, which leave out their group
   * instead of failing the start.
   *
   * @decision .agents/decisions/261121_065823-hot-plug-directories.md#failures
   */
  readonly #startCrashes = new Map<string, RackError>();
  /** The firmware of the instance whose crash made {@link #startFault}. */
  #startFaultFirmware: Firmware | undefined;
  #operations: Promise<unknown> = Promise.resolve();
  /**
   * What the executable that runs this rack packaged; `undefined` outside an executable.
   *
   * @decision .agents/decisions/261120_011627-single-executables.md#devices-from-outside-files
   */
  readonly #packaged: Packaged | undefined = packaged();
  /** The packaged firmware of each device file, by source, once asked for. */
  readonly #packagedFirmware = new Map<string, Firmware>();
  /**
   * In an executable, while the rack starts: the device files whose outside file failed, which
   * start from their packaged firmware.
   */
  readonly #fellBack = new Map<string, Fallen>();
  /** While the rack starts: what the firmware of each outside file declared, and with what. */
  readonly #outsideFrus = new Map<string, { fru: Fru; config: unknown; hash: string }>();
  /** Keys of the warnings that #warnOnce gave. */
  readonly #warned = new Set<string>();
  /** The models that `devices` gave at the last scan, for reloads of hot-plug devices alone. */
  #fixedModels: Map<string, ModelSource> | undefined;
  /** The instances of the last layout with hot-plug devices, fixed ones at their new slots. */
  #running: RunningInstance[] | undefined;
  /** The hot-plug files that the last scan left out, by absolute path. */
  #leftOut = new Map<string, LeftOutFile>();
  /** What the log last said about each hot-plug file left out, so that it says it once. */
  readonly #leftOutLogged = new Map<string, string>();
  /** The device files of each hot-plug directory at the last scan, or `undefined` when missing. */
  readonly #hotplugFiles = new Map<string, number | undefined>();

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
    this.#faultInjection = options.faultInjection === true;
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
      (instance) => this.#everyOf(instance),
    );
  }

  handle(): RackHandle {
    return Object.freeze({
      status: () => this.#status(),
      call: (address: string, method: string, input: unknown, options: CallOptions = {}) =>
        this.#phase === "running"
          ? this.#backplane.call(address, method, input, options, "rack")
          : refuse(`${address}.${method}`, input, options),
      reload: (manifest?: RackManifest) => this.#operate("reload", () => this.#reload(manifest)),
      [RELOAD_HOTPLUG]: () => this.#operate("reload", () => this.#reload(undefined, true)),
      [SWEEP_FIRMWARE]: () => this.#sweepFirmware(),
      swap: (name: string, source?: string | URL) =>
        this.#operate("swap", () => this.#swap(name, source)),
      restart: (name: string, options: RestartOptions = {}) =>
        this.#operate("restart", () => this.#restart(name, options.cascade ?? true)),
      rollback: (name: string, options: RollbackOptions = {}) =>
        this.#operate("rollback", () => this.#rollback(name, options.to)),
      history: (name?: string) =>
        this.#history.filter((record) => name === undefined || record.device === name).reverse(),
      events: (after?: number) => this.#events(after),
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
      injectFault: (name: string, kind: InjectedFault) =>
        this.#serialize(() => this.#injectFault(name, kind)),
    });
  }

  // ---- Instance host ----

  onData(instance: Instance, message: DataFromWorker): void {
    this.#backplane.onData(instance, message);
  }

  onLog(instance: Instance, notice: LogNotice): void {
    this.#log(notice.level, notice.message, notice.data, instance.slot);
  }

  /**
   * Reserves a listener's address for an instance in `powerOn`. Two listeners on one port
   * conflict, whatever their hostnames, unless they belong to two instances of one device, as
   * in a hot swap.
   *
   * @decision .agents/decisions/261118_070617-panels-as-devices.md#conflicts
   */
  onAsk(instance: Instance, ask: ReserveAsk): Promise<unknown> {
    const device = instance.slot;
    const listener = `${ask.hostname}:${ask.port}`;
    for (const [other, addresses] of this.#addresses) {
      if (other === instance) continue;
      const clash = addresses.find((a) => a.port === ask.port && a.device !== device);
      if (clash !== undefined) {
        const message = `${device}: ctx.serve: ${listener} is taken by ${clash.device}`;
        return Promise.reject(
          new RackError("RACK_HOOK_FAILED", message, { listener, holder: clash.device }),
        );
      }
    }
    let addresses = this.#addresses.get(instance);
    if (addresses === undefined) {
      addresses = [];
      this.#addresses.set(instance, addresses);
      // The thread holds its ports until it stops, even after its Worker is gone.
      void instance.closed.then(() => this.#addresses.delete(instance));
    }
    const same = (a: Omit<InheritedListener, "held">) =>
      a.hostname === ask.hostname && a.declared === ask.declared && a.ordinal === ask.ordinal;
    const { hostname, declared, ordinal, port } = ask;
    const address = addresses.find(same);
    if (address === undefined) addresses.push({ device, hostname, declared, ordinal, port });
    else address.port = port;
    const ports = this.#ports.get(device) ?? [];
    const kept = ports.find(same);
    if (kept === undefined) ports.push({ hostname, declared, ordinal, port });
    else kept.port = port;
    this.#ports.set(device, ports);
    return Promise.resolve(undefined);
  }

  /**
   * The listeners a device's next instance takes over: the ports its earlier instances got, and
   * whether an instance of the device listens on each now.
   *
   * @decision .agents/decisions/261118_070617-panels-as-devices.md#port-0
   */
  #inherited(device: string): InheritedListener[] {
    return (this.#ports.get(device) ?? []).map((kept) => {
      let held = false;
      for (const instance of this.#addresses.keys()) {
        if (instance.dead || instance.slot !== device) continue;
        const port = String(kept.port);
        if (instance.listenerReports.some((r) => r.listening && new URL(r.url).port === port)) {
          held = true;
        }
      }
      return { ...kept, held };
    });
  }

  /** Runs `powerOn`, handing the instance the listeners of the device's earlier instances. */
  #powerOnHook(instance: Instance): Promise<unknown> {
    const listeners = this.#inherited(instance.slot);
    return instance.hook("powerOn", this.#hookTimeout, { listeners });
  }

  /**
   * Puts an instance's listeners into service: those that don't listen bind. Logs `listening`
   * for each, unless `quiet`, as in a hot swap, which logs the handover instead.
   *
   * @returns The URLs of the listeners that bound.
   * @throws RackError `RACK_HOOK_FAILED` when a bind fails, as when `activate` fails.
   * @decision .agents/decisions/261118_070617-panels-as-devices.md#when-listeners-listen
   */
  async #listen(instance: Instance, quiet = false): Promise<string[]> {
    if (instance.dead || instance.listenerReports.length === 0) return [];
    const bound = (await instance.request({ op: "listen" }, this.#hookTimeout)) as string[];
    if (!quiet) for (const url of bound) this.#log("info", "listening", { url }, instance.slot);
    return bound;
  }

  /**
   * Takes an instance's listeners out of service: they stop listening, the requests that wait
   * for the install get 503, and the WebSockets close with `code` once their messages in flight
   * are handled.
   *
   * @param logClosed Log `listener closed` for each, as when no other instance takes it over.
   * @returns The URLs of the listeners that stopped, or `undefined` when the instance didn't
   *   confirm the stop within `hookTimeout`.
   * @decision .agents/decisions/261118_070617-panels-as-devices.md#when-listeners-listen
   */
  async #unlisten(
    instance: Instance,
    code: number,
    logClosed: boolean,
  ): Promise<string[] | undefined> {
    if (instance.dead || !instance.listenerReports.some((r) => r.listening)) return [];
    let stopped: string[];
    try {
      stopped = (await instance.request({ op: "unlisten", code }, this.#hookTimeout)) as string[];
    } catch {
      // An instance that is gone took its listeners with it; one that didn't answer didn't stop.
      return instance.dead ? [] : undefined;
    }
    if (logClosed) {
      for (const url of stopped) this.#log("info", "listener closed", { url }, instance.slot);
    }
    return stopped;
  }

  /** The listeners of an instance as `status()` shows them; with `listening`, those that listen. */
  #listenerStatus(instance: Instance | null, listening = false): ListenerStatus[] {
    if (instance === null) return [];
    return instance.listeners
      .filter((l) => !listening || l.listening)
      .map(({ url, certificates, requests, webSockets }) => ({
        url,
        certificates,
        requests,
        webSockets,
      }));
  }

  onExit(instance: Instance, deliberate: boolean, detail: string): void {
    this.#instances.delete(instance);
    for (const { url } of instance.listenerReports.filter((r) => r.listening)) {
      this.#log("info", "listener closed", { url }, instance.slot);
    }
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
      if (this.#slots.get(instance.slot)?.hotplug) {
        this.#startCrashes.set(instance.slot, new RackError("RACK_DEVICE_FAULT", message));
        return;
      }
      if (this.#startFault === undefined) {
        this.#startFault = new RackError("RACK_DEVICE_FAULT", message);
        this.#startFaultFirmware = instance.firmware;
      }
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
      if (this.#slots.get(instance.slot)?.hotplug) {
        this.#startCrashes.set(
          instance.slot,
          new RackError("RACK_DEVICE_FAULT", message, error.data),
        );
        return;
      }
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
      await this.#powerUpFallingBack();
      this.#settleKnownGood();
      this.#phase = "running";
      await this.#logHotplugStart();
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
        await this.#sweepFirmware();
      }
      this.#log("info", `rack ${this.#manifest.name} started`, { devices: this.#slots.size });
    } catch (error) {
      await this.#abortStart();
      throw error;
    }
  }

  /**
   * Powers every device on. In an executable, a device whose outside file fails while the rack
   * starts runs its packaged firmware: the rack powers off what it started, and starts again with
   * that file's packaged firmware, until it starts, or fails as it would under `rack start`. Each
   * new start has one outside file fewer, so there are at most as many as outside files.
   *
   * @decision .agents/decisions/261120_011627-single-executables.md#falling-back
   */
  async #powerUpFallingBack(): Promise<void> {
    for (;;) {
      try {
        await this.#powerUp();
        return;
      } catch (error) {
        await this.#abortStart();
        const fallen = await this.#fallingBack(error);
        if (fallen.size === 0) throw error instanceof OutsideFailure ? error.failure : error;
        for (const [source, why] of fallen) this.#fellBack.set(source, why);
        this.#resetStart();
      }
    }
  }

  /** Boots, wires, and powers on every device, from the bottom up. */
  async #powerUp(): Promise<void> {
    const planText = await this.#prepare();
    if (planText !== undefined) await writeWhole(this.#planPath(), planText);
    for (const slot of this.#ordered()) {
      const instance = slot.installed as Instance;
      if (slot.removed) continue;
      try {
        // Links to the devices below exist already; this links the devices above to it.
        await this.#backplane.connect(instance);
        await this.#backplane.install(slot, instance, null);
        await this.#powerOn(instance);
      } catch (error) {
        if (slot.hotplug) {
          await this.#dropHotplugGroup(slot, error);
          continue;
        }
        throw this.#outsideFailure(instance.firmware, error);
      }
      await this.#dropCrashedHotplug();
      if (slot.removed) continue;
      this.#throwStartFault();
      slot.state = "online";
      this.#powered(instance);
    }
    await this.#dropCrashedHotplug();
    this.#throwStartFault();
  }

  /**
   * The outside files to start from their packaged firmware after a start that failed: the one
   * that failed, or, for a layout, a wiring, or a plan that didn't fit, each whose firmware
   * declares another model, height, priority, needs, or ports than its packaged firmware.
   */
  async #fallingBack(error: unknown): Promise<Map<string, Fallen>> {
    const fallen = new Map<string, Fallen>();
    if (error instanceof OutsideFailure) {
      fallen.set(error.source, { error: toWireError(error.failure), from: error.from });
      return fallen;
    }
    if (!(error instanceof RackError) || error.code !== "RACK_MANIFEST") return fallen;
    for (const [source, outside] of this.#outsideFrus) {
      const firmware = this.#packagedFor(source);
      if (firmware === undefined) continue;
      let fru: Fru;
      try {
        fru = await this.#describe(firmware, outside.config);
      } catch {
        // The packaged firmware can't be read either, so it can't take the file's place.
        continue;
      }
      if (!sameDeclarations(fru, outside.fru)) {
        fallen.set(source, { error: toWireError(error), from: outside.hash });
      }
    }
    return fallen;
  }

  /** Makes the rack ready to start again, after a start that it powered off. */
  #resetStart(): void {
    this.#phase = "starting";
    this.#startFault = undefined;
    this.#startFaultFirmware = undefined;
    this.#startCrashes.clear();
    this.#plan = undefined;
    this.#patch = this.#manifest.patch;
    this.#ports.clear();
    this.#outsideFrus.clear();
  }

  /**
   * Sets each device's known-good firmware once the rack started: the firmware it started with,
   * or in an executable its packaged firmware. There, a device that runs an outside file starts
   * on probation, together with the devices of outside files wired to it, and a device whose
   * outside file failed is `degraded`, with a record of its fallback.
   *
   * @decision .agents/decisions/261120_011627-single-executables.md#falling-back
   */
  #settleKnownGood(): void {
    const outside: string[] = [];
    for (const slot of this.#slots.values()) {
      const firmware = this.#packagedFor(slot.source);
      if (firmware === undefined) {
        this.#knownGood.set(slot.name, slot.firmware);
        continue;
      }
      this.#knownGood.set(slot.name, firmware);
      const fell = this.#fellBack.get(slot.source);
      if (fell !== undefined) {
        slot.state = "degraded";
        slot.error = fell.error;
        this.#log("warn", `${slot.name} runs its packaged firmware: ${fell.error.message}`, {
          file: slot.source,
          code: fell.error.code,
        });
        const context = { cause: "fallback" as const, started: Date.now(), crash: fell.error };
        updates.run(context, () =>
          this.#emit({
            type: "swap",
            device: slot.name,
            action: "swap",
            mode: "restart",
            from: fell.from,
            to: firmware.hash,
          }),
        );
      } else if (slot.firmware.packaged !== true) {
        this.#log("info", `${slot.name} runs ${slot.source}`, { firmware: slot.firmware.hash });
        outside.push(slot.name);
      }
    }
    this.#fellBack.clear();
    this.#outsideFrus.clear();
    for (const group of this.#wiredGroups(outside)) this.#startProbation(group);
  }

  /** Splits devices into groups whose members are wired to one another, which fall back together. */
  #wiredGroups(names: readonly string[]): string[][] {
    const leader = new Map(names.map((name) => [name, name]));
    const find = (name: string): string => {
      let at = name;
      while (leader.get(at) !== at) at = leader.get(at) as string;
      return at;
    };
    for (const name of names) {
      for (const wire of this.#slots.get(name)?.wiring.values() ?? []) {
        if (leader.has(wire.provider)) leader.set(find(name), find(wire.provider));
      }
    }
    const groups = new Map<string, string[]>();
    for (const name of names) {
      const at = find(name);
      groups.set(at, [...(groups.get(at) ?? []), name]);
    }
    return [...groups.values()];
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
          hotplug: [],
          leftOut: [],
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
        await writeWhole(path, text);
        file.state = "fits";
        file.differences = [];
      }
      // @decision .agents/decisions/261121_065823-hot-plug-directories.md#observation
      const hotplug = (this.#running ?? [])
        .filter((instance) => instance.hotplug)
        .map(formatInstance);
      const leftOut = [...this.#leftOut].map(([source, { reason }]) => ({
        path: relative(this.#baseDir, source),
        reason,
      }));
      return { text, unused: [...scanned.unused], file, hotplug, leftOut };
    } finally {
      await this.#abortStart();
    }
  }

  /**
   * Builds a device file and reads what it declares, as planning does, without starting a rack.
   *
   * @param source The device file: a path relative to the base directory, or a `file:` URL.
   * @param config The configuration that needs computed from the configuration come from.
   * @throws RackError `RACK_MANIFEST` when the file doesn't build or load as a device.
   */
  async describeFile(source: string | URL, config: unknown): Promise<Fru> {
    try {
      const firmware = await this.#build(resolveSource(source, this.#baseDir)).catch(
        (error: unknown) => {
          throw new RackError("RACK_MANIFEST", messageOf(error));
        },
      );
      return await this.#describe(firmware, config);
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
          throw this.#buildFailure(entry.source, error);
        });
        if (firmware === undefined) throw new RackError("RACK_MANIFEST", "missing firmware");
        const instance = await this.#boot(
          firmware,
          entry.spec.name,
          entry.u,
          entry.spec.config,
          "RACK_MANIFEST",
        ).catch((error: unknown) => {
          throw this.#outsideFailure(firmware, error);
        });
        this.#noteOutside(entry.source, firmware, instance.fru as Fru, entry.spec.config);
        return {
          u: entry.u,
          config: entry.spec.config,
          firmware,
          instance,
          hotplug: entry.hotplug === true,
        };
      }),
    );
    // A hot-plug instance that doesn't boot leaves out its group: its device and the copies
    // that the device owns, which nothing else needs.
    // @decision .agents/decisions/261121_065823-hot-plug-directories.md#failures
    const failed = new Set<string>();
    booted.forEach((result, i) => {
      const entry = entries[i] as Entry;
      if (result.status !== "rejected") return;
      if (entry.group === undefined) throw result.reason;
      failed.add(entry.group);
      const device = entries.find((other) => other.spec.name === entry.group);
      this.#leaveOut(device?.source ?? entry.source, result.reason);
    });
    const ready: Booted[] = [];
    for (const [i, result] of booted.entries()) {
      if (result.status !== "fulfilled") continue;
      const group = (entries[i] as Entry).group;
      if (group !== undefined && failed.has(group)) {
        await this.#end(result.value.instance, (entries[i] as Entry).spec.name ?? group);
        continue;
      }
      ready.push(result.value);
    }
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
    this.#fixedModels = models;
    const computed = this.#computePlan(models);
    const { plan, write } = await this.#choosePlan(computed);
    this.#plan = plan;
    const layout = await this.#withHotplug(plan, models, builds);
    this.#patch = patchesOf({ instances: layout.instances, unused: [] });
    const groups = groupsOf(layout.instances);
    const entries: Entry[] = layout.instances.map((instance) => {
      const { source } = layout.models.get(instance.model) as ModelSource;
      const config = this.#configFor(instance, layout.models);
      return {
        u: instance.u,
        spec: mountSpec(source, { name: instance.name, config }),
        source,
        hotplug: instance.hotplug,
        group: groups.get(instance.name),
      };
    });
    return {
      entries,
      planText: write ? formatPlan(this.#manifest.name, plan) : undefined,
    };
  }

  /**
   * Places the hot-plug devices around the plan of the fixed instances, which it leaves as it is.
   *
   * @returns The instances to run, fixed ones at their new slots, and the models of all of them.
   * @decision .agents/decisions/261121_065823-hot-plug-directories.md#where-hot-plug-devices-go
   */
  async #withHotplug(
    plan: Plan,
    fixed: ReadonlyMap<string, ModelSource>,
    builds: Map<string, Promise<Firmware>>,
  ): Promise<{ instances: RunningInstance[]; models: Map<string, ModelSource> }> {
    const scan = this.#manifest.scan as ScanSpec;
    if (scan.hotplug.length === 0) {
      return {
        instances: plan.instances.map((instance) => ({ ...instance, hotplug: false })),
        models: new Map(fixed),
      };
    }
    const hot = await this.#scanHotplug(builds, fixed);
    // The manifest names no hot-plug model, so that hot-plug devices leave the fixed plan as it
    // is; roots, patched() addresses, and routes fail in the fixed plan already.
    // @decision .agents/decisions/261121_065823-hot-plug-directories.md#hot-plug-directories
    for (const [key, value] of Object.entries(scan.use)) {
      const keyed = isConnectorId(key) ? undefined : key.slice(0, key.indexOf("."));
      for (const named of [keyed, value]) {
        if (named !== undefined && hot.has(named)) {
          throw new RackError(
            "RACK_MANIFEST",
            `use ${key}: ${named} is a hot-plug model, which the manifest can't name`,
          );
        }
      }
    }
    const types = new Map([...fixed].map(([name, model]) => [name, model.type]));
    // Only use entries by connector id apply to hot-plug devices, whose models the manifest
    // can't name.
    const use = Object.fromEntries(Object.entries(scan.use).filter(([key]) => isConnectorId(key)));
    const placed = placeHotplug({
      fixed: plan,
      types,
      hotplug: [...hot.values()].map((model) => model.type),
      use,
      size: this.#manifest.size,
    });
    for (const [model, reason] of placed.leftOut) {
      const { source } = hot.get(model) as ModelSource;
      this.#leftOut.set(source, { reason, code: "RACK_MANIFEST" });
    }
    this.#running = [...placed.instances];
    return { instances: [...placed.instances], models: new Map([...fixed, ...hot]) };
  }

  /**
   * Builds and describes the files of the hot-plug directories, under their model names. A file
   * that doesn't build or load as a device, or whose model a model of `devices` or another file
   * has, is left out. A running hot-plug device whose file doesn't build or load now keeps the
   * model it runs, so that the reload leaves it on its firmware, `degraded`.
   *
   * @decision .agents/decisions/261121_065823-hot-plug-directories.md#failures
   */
  async #scanHotplug(
    builds: Map<string, Promise<Firmware>>,
    fixed: ReadonlyMap<string, ModelSource>,
  ): Promise<Map<string, ModelSource>> {
    const scan = this.#manifest.scan as ScanSpec;
    this.#leftOut = new Map();
    const found: string[] = [];
    for (const dir of scan.hotplug) {
      const path = resolvePath(this.#baseDir, dir);
      this.#checkHotplugDir(dir, path);
      const files = (await isDirectory(path)) ? await deviceFiles(path) : undefined;
      this.#hotplugFiles.set(dir, files?.length);
      found.push(...(files ?? []));
    }
    for (const source of found) {
      if (!builds.has(source)) builds.set(source, this.#build(source));
    }
    const described = await Promise.all(
      found.map(async (source) => {
        try {
          const firmware = await (builds.get(source) as Promise<Firmware>);
          let fru = await this.#describe(firmware, undefined);
          if (fru.computedNeeds && Object.hasOwn(scan.config, fru.model)) {
            fru = await this.#describe(firmware, scan.config[fru.model]);
          }
          return { source, fru };
        } catch (error) {
          const running = [...this.#slots.values()].find(
            (slot) => slot.hotplug && !slot.removed && slot.source === source,
          );
          if (running !== undefined) return { source, fru: running.fru };
          this.#leftOut.set(source, { reason: messageOf(error), code: codeOf(error) });
          return undefined;
        }
      }),
    );
    const models = new Map<string, ModelSource>();
    const clashes = new Set<string>();
    for (const item of described) {
      if (item === undefined) continue;
      const name = item.fru.model;
      const other = models.get(name);
      if (fixed.has(name)) {
        const reason = `its model ${name} is the model of ${relative(this.#baseDir, (fixed.get(name) as ModelSource).source)} too`;
        this.#leftOut.set(item.source, { reason, code: "RACK_MANIFEST" });
      } else if (other !== undefined || clashes.has(name)) {
        clashes.add(name);
        const reason = `another hot-plug file declares model ${name} too`;
        this.#leftOut.set(item.source, { reason, code: "RACK_MANIFEST" });
        if (other !== undefined) this.#leftOut.set(other.source, { reason, code: "RACK_MANIFEST" });
        models.delete(name);
      } else {
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
          config: undefined,
          explicit: false,
        });
      }
    }
    return models;
  }

  /**
   * Checks that a hot-plug directory overlaps no directory of `devices`.
   *
   * @throws RackError `RACK_MANIFEST` when it does.
   */
  #checkHotplugDir(dir: string, path: string): void {
    const scan = this.#manifest.scan as ScanSpec;
    const within = (outer: string, inner: string) =>
      inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : `${outer}${sep}`);
    for (const entry of scan.devices) {
      if (typeof entry !== "string") continue;
      const other = resolvePath(this.#baseDir, entry);
      if (within(other, path) || within(path, other)) {
        throw new RackError(
          "RACK_MANIFEST",
          `hotplug directory ${dir} overlaps the devices directory ${entry}`,
        );
      }
    }
  }

  /**
   * Logs each hot-plug file that is left out: at the start, and at a reload when the file or
   * the reason changed.
   *
   * @decision .agents/decisions/261121_065823-hot-plug-directories.md#observation
   */
  async #logLeftOut(): Promise<void> {
    for (const [source, { reason, code }] of this.#leftOut) {
      const stamp = await stat(source).then(
        (info) => info.mtimeMs,
        () => 0,
      );
      const said = `${stamp} ${reason}`;
      if (this.#leftOutLogged.get(source) === said) continue;
      this.#leftOutLogged.set(source, said);
      this.#log("warn", `${relative(this.#baseDir, source)} left out: ${reason}`, { code });
    }
    for (const source of this.#leftOutLogged.keys()) {
      if (!this.#leftOut.has(source)) this.#leftOutLogged.delete(source);
    }
  }

  /**
   * Logs at start what each hot-plug directory holds, so that a mistyped path shows, and the
   * files left out.
   *
   * @decision .agents/decisions/261121_065823-hot-plug-directories.md#observation
   */
  async #logHotplugStart(): Promise<void> {
    for (const [dir, count] of this.#hotplugFiles) {
      if (count === undefined) this.#log("info", `hot-plug directory ${dir}/ doesn't exist`);
      else if (count === 1) this.#log("info", `hot-plug directory ${dir}/ holds 1 device file`);
      else this.#log("info", `hot-plug directory ${dir}/ holds ${count} device files`);
    }
    await this.#logLeftOut();
  }

  /** Leaves out a hot-plug file whose device failed while the rack started or plugged it. */
  #leaveOut(source: string, error: unknown): void {
    this.#leftOut.set(source, { reason: messageOf(error), code: codeOf(error) });
  }

  /** Drops the groups of the hot-plug devices that crashed or bit while the rack started. */
  async #dropCrashedHotplug(): Promise<void> {
    for (const [name, error] of [...this.#startCrashes]) {
      this.#startCrashes.delete(name);
      const slot = this.#slots.get(name);
      if (slot !== undefined && !slot.removed) await this.#dropHotplugGroup(slot, error);
    }
  }

  /**
   * Ends a hot-plug instance that failed to power on while the rack starts, with the rest of its
   * group, and leaves their slots empty until the next reload. No fixed instance needs them.
   *
   * @decision .agents/decisions/261121_065823-hot-plug-directories.md#failures
   */
  async #dropHotplugGroup(failed: Slot, error: unknown): Promise<void> {
    const owners = this.#owners();
    const rootOf = (name: string) => {
      let root = name;
      for (let owner = owners.get(root); owner !== undefined; owner = owners.get(root))
        root = owner;
      return root;
    };
    const root = rootOf(failed.name);
    const group = [...this.#slots.values()].filter(
      (slot) => slot.hotplug && rootOf(slot.name) === root,
    );
    this.#leaveOut(this.#slots.get(root)?.source ?? failed.source, error);
    for (const slot of group) {
      slot.removed = true;
      const instance = slot.installed;
      slot.installed = null;
      if (instance !== null) await this.#end(instance, slot.name);
      this.#slots.delete(slot.name);
      this.#backplane.forget(slot.name);
    }
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
        for (const source of await this.#deviceFiles(resolvePath(this.#baseDir, entry))) {
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
            throw this.#buildFailure(item.source, error);
          },
        );
        let fru: Fru;
        let config = item.config;
        try {
          fru = await this.#describe(firmware, config);
          // Needs that come from the configuration come from the configuration of the model's
          // shared instance, which the model's entry in `config` gives before the spec does.
          // @decision .agents/decisions/261118_071513-http-panel-device.md#needs-from-configuration
          const name = item.variant ?? fru.model;
          if (fru.computedNeeds && Object.hasOwn(scan.config, name)) {
            config = scan.config[name];
            fru = await this.#describe(firmware, config);
          }
        } catch (error) {
          throw this.#outsideFailure(firmware, error);
        }
        this.#noteOutside(item.source, firmware, fru, config);
        return { ...item, firmware, fru };
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

  /**
   * Builds a device file, remembering the bundle so that it can be deleted once unused.
   *
   * In an executable, a device file that it packaged gives its packaged firmware, unless its
   * outside file is there, and didn't fail while the rack started; then the outside file is built
   * as the executable builds firmware. A file that the executable didn't package is built only
   * for a swap that names it.
   *
   * @param named Whether a swap names the file.
   * @throws Error with the build's messages, or when an executable didn't package the file.
   * @decision .agents/decisions/261120_011627-single-executables.md#devices-from-outside-files
   */
  async #build(source: string, named = false): Promise<Firmware> {
    const exe = this.#packaged;
    let packagedBuild: PackagedBuild | undefined;
    if (exe !== undefined) {
      const inside = this.#packagedFor(source);
      if (inside === undefined && !named) {
        throw new Error(`${source} is not packaged in this executable`);
      }
      if (inside !== undefined) {
        if (!this.#outsideCandidate(source)) return inside;
        if (!(await Bun.file(source).exists())) return inside;
      }
      packagedBuild = {
        appDir: this.#baseDir,
        carried: { root: exe.root, specifiers: exe.table.carried },
      };
    }
    const firmware = await buildBundle(source, this.#baseDir, packagedBuild);
    this.#built.set(firmware.path, firmware);
    this.#firmwares.set(firmware.hash, firmware);
    return firmware;
  }

  /** The packaged firmware of a device file, in an executable that packaged it. */
  #packagedFor(source: string): Firmware | undefined {
    const exe = this.#packaged;
    if (exe === undefined) return undefined;
    const known = this.#packagedFirmware.get(source);
    if (known !== undefined) return known;
    const entry = exe.table.devices[keyOfSource(source, exe)];
    if (entry === undefined) return undefined;
    const path = join(exe.root, ...entry.file.split("/"));
    const firmware: Firmware = {
      path,
      url: pathToFileURL(path).href,
      hash: entry.hash,
      source,
      packaged: true,
    };
    this.#packagedFirmware.set(source, firmware);
    this.#firmwares.set(firmware.hash, firmware);
    return firmware;
  }

  /**
   * Whether an outside file may give a device file's firmware: the executable packaged it, it
   * belongs to the app, and its outside file hasn't failed while the rack started.
   */
  #outsideCandidate(source: string): boolean {
    const exe = this.#packaged;
    if (exe === undefined || this.#packagedFor(source) === undefined) return false;
    return hasOutsideFile(keyOfSource(source, exe)) && !this.#fellBack.has(source);
  }

  /** Whether a firmware is an outside file's, in an executable. */
  #isOutside(firmware: Firmware): boolean {
    return firmware.packaged !== true && this.#outsideCandidate(firmware.source);
  }

  /** What a failed build of a device file fails the start with. */
  #buildFailure(source: string, error: unknown): RackError | OutsideFailure {
    if (!this.#outsideCandidate(source)) return new RackError("RACK_MANIFEST", messageOf(error));
    // As a swap of the file reports it.
    return new OutsideFailure(source, new RackError("RACK_SWAP_REJECTED", messageOf(error)), null);
  }

  /** Marks a failure of an outside file's firmware while the rack starts as that file's. */
  #outsideFailure(firmware: Firmware, error: unknown): unknown {
    if (error instanceof OutsideFailure || !this.#isOutside(firmware)) return error;
    return new OutsideFailure(firmware.source, asRackError(error), firmware.hash);
  }

  /** Keeps what an outside file's firmware declared, for a start that fails to fit it. */
  #noteOutside(source: string, firmware: Firmware, fru: Fru, config: unknown): void {
    if (this.#isOutside(firmware))
      this.#outsideFrus.set(source, { fru, config, hash: firmware.hash });
  }

  /** The device files in a directory that a scanned rack names: in an executable, those it packaged. */
  async #deviceFiles(dir: string): Promise<string[]> {
    const exe = this.#packaged;
    if (exe === undefined) return deviceFiles(dir);
    const keys = exe.table.scans[keyOfSource(dir, exe)];
    if (keys === undefined) {
      throw new RackError(
        "RACK_MANIFEST",
        `cannot scan ${dir}: the executable packaged no such directory`,
      );
    }
    return keys.map((key) => sourceOfKey(key, exe));
  }

  /**
   * Reads what a firmware declares, loading it once in a Worker that is ended after. While the
   * thread of an earlier such Worker of the firmware is stuck, it isn't loaded again.
   *
   * @param config The configuration that needs computed from the configuration come from.
   * @decision .agents/decisions/261117_185131-ending-instances.md#inspecting-firmware
   * @decision .agents/decisions/261118_071513-http-panel-device.md#needs-from-configuration
   */
  async #describe(firmware: Firmware, config?: unknown): Promise<Fru> {
    // Firmware whose needs don't come from the configuration describes the same for any.
    const plain = this.#described.get(firmware.hash);
    if (plain !== undefined && !plain.computedNeeds) return plain;
    const key = describedKey(firmware, config);
    const known = key === undefined ? undefined : this.#described.get(key);
    if (known !== undefined) return known;
    const stuck = this.#stuckFirmware(firmware.hash);
    if (stuck !== undefined) {
      throw new RackError("RACK_MANIFEST", this.#stuckMessage(firmware.source, stuck));
    }
    const instance = new Instance(firmware, firmware.source, this);
    try {
      const fru = await instance.describe(this.#hookTimeout, this.#baseDir, config);
      const keep = fru.computedNeeds ? key : firmware.hash;
      if (keep !== undefined) this.#described.set(keep, fru);
      return fru;
    } catch (error) {
      const { message } = asRackError(error);
      const why = explainMissingPackage(message, firmware, this.#baseDir);
      throw new RackError("RACK_MANIFEST", `${firmware.source}: ${message}${why}`);
    } finally {
      await this.#end(instance, undefined);
    }
  }

  /** Works out the plan from the models and the roots. */
  #computePlan(models: ReadonlyMap<string, ModelSource>): Plan {
    const scan = this.#manifest.scan as ScanSpec;
    const roots = [...scan.roots];
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
    // An executable follows the plan file it packaged, and writes none.
    // @decision .agents/decisions/261120_011627-single-executables.md#running-an-executable
    const writable = this.#packaged === undefined;
    const file = Bun.file(path);
    const text = !writable
      ? this.#packaged?.table.plans[name]
      : (await file.exists())
        ? await file.text()
        : undefined;
    if (text === undefined) return { plan: computed, write: writable };
    const fit = fitPlan(parsePlan(text, name), computed, this.#manifest.size);
    if (fit.fits && fit.sameOrder) return { plan: fit.plan, write: false };
    if (this.#planMode === "update") {
      const differences = fit.fits ? ["the priorities give another order"] : fit.differences;
      this.#log("info", `${name} changed`, { differences });
      return { plan: computed, write: writable };
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

  /**
   * Writes the plan file, unless it already holds the text: the watcher of `rack dev` counts every
   * write as a change, so a reload that wrote the same plan again would set off another reload,
   * without end.
   */
  async #writePlanFile(text: string): Promise<void> {
    const path = this.#planPath();
    // A file that is missing, or that can't be read, is written anew.
    const current = await Bun.file(path)
      .text()
      .catch(() => undefined);
    if (current !== text) await writeWhole(path, text);
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
    const fault = this.#startFault;
    if (fault === undefined) return;
    const firmware = this.#startFaultFirmware;
    throw firmware === undefined ? fault : this.#outsideFailure(firmware, fault);
  }

  async #abortStart(): Promise<void> {
    this.#phase = "stopping";
    await this.#control?.close().catch(() => undefined);
    this.#control = undefined;
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
    // Top down: upper devices finish their work while the devices below still serve them.
    // @decision .agents/decisions/261112_035942-rack-architecture.md#gravity-rule
    for (const slot of this.#ordered().reverse()) {
      const instance = slot.installed;
      if (instance !== null) {
        const wasAlive = !instance.dead;
        await this.#powerDown(instance, [], false, true);
        // Terminated now, in order; the wait for the threads comes once, for all of them.
        void this.#end(instance, slot.name);
        if (wasAlive) this.#poweredOff(instance);
      }
      slot.installed = null;
      slot.removed = true;
    }
    await this.#endAll();
    this.#slots.clear();
    this.#ports.clear();
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
      // An every need reaches what #everyOf finds, and no patch picks for it.
      // @decision .agents/decisions/261121_065823-hot-plug-directories.md#every-needs
      if (info.every) {
        if (this.#patch.some(([consumer]) => consumer === `${name}.${need}`)) {
          throw new RackError(
            "RACK_MANIFEST",
            `patch ${where}: ${name}.${need} is an every need, which reaches every provider below`,
          );
        }
        continue;
      }
      // A patch decides first: when a plan or a manifest changes, its wiring wins. A need that
      // patched() wires carries a patch of its own, which a patch of the manifest overrides.
      // @decision .agents/decisions/261118_071513-http-panel-device.md#needs-from-configuration
      const patch =
        this.#patch.find(([consumer]) => consumer === `${name}.${need}`) ??
        (info.patched === undefined ? undefined : ([`${name}.${need}`, info.patched] as const));
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
   * What the every needs of an instance reach: the devices below its slot that provide the
   * connector on one port, which covers the need, apart from copies that serve an `own` need
   * and devices that are being unplugged.
   *
   * @decision .agents/decisions/261121_065823-hot-plug-directories.md#every-needs
   */
  #everyOf(instance: Instance): EveryWiring {
    const wires = new Map<string, Wire>();
    const members = new Map<string, MemberInfo[]>();
    const fru = instance.fru;
    const slot = this.#slots.get(instance.slot);
    if (fru === undefined || slot === undefined) return { wires, members };
    let copies: Map<string, string> | undefined;
    for (const [need, info] of Object.entries(fru.needs)) {
      if (!info.every) continue;
      copies ??= this.#owners();
      const reached: Slot[] = [];
      for (const other of this.#slots.values()) {
        if (other.removed || other === slot || other.u >= slot.u || copies.has(other.name))
          continue;
        const ports = Object.entries(other.fru.provides).filter(
          ([, port]) => port.id === info.id && covers(port, info),
        );
        const [only, ...more] = ports;
        if (only === undefined) continue;
        if (more.length > 0) {
          this.#warnOnce(
            `every:${slot.name}.${need}:${other.name}`,
            `${slot.name}.${need} doesn't reach ${other.name}, which provides ${info.id} on several ports`,
          );
          continue;
        }
        reached.push(other);
        wires.set(`${need}:${other.name}`, { provider: other.name, port: only[0] });
      }
      reached.sort((a, b) => a.u - b.u);
      members.set(
        need,
        reached.map((other) => ({
          name: other.name,
          model: other.model,
          firmware: other.firmware.hash,
          hotplug: other.hotplug,
        })),
      );
    }
    return { wires, members };
  }

  /** Brings the every needs of every installed instance up to date with the rack. */
  async #syncEvery(): Promise<void> {
    const work: Promise<void>[] = [];
    for (const slot of this.#slots.values()) {
      const instance = slot.installed;
      if (slot.removed || instance === null || instance.dead) continue;
      if (!Object.values(instance.fru?.needs ?? {}).some((info) => info.every)) continue;
      work.push(this.#backplane.syncEvery(instance));
    }
    await Promise.all(work);
  }

  /** Logs a warning once per key, for the life of the rack. */
  #warnOnce(key: string, message: string): void {
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    this.#log("warn", message);
  }

  /**
   * Checks that the new FRU still provides every port that other devices use.
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
  }

  /** Names the needs that use a device. */
  #usersOf(name: string): string[] {
    const users: string[] = [];
    for (const consumer of this.#slots.values()) {
      if (consumer.name === name || consumer.removed) continue;
      for (const [need, wire] of consumer.wiring) {
        if (wire.provider === name) users.push(`${consumer.name}.${need}`);
      }
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
        // What every needs reach follows the devices that an operation plugged, swapped, moved,
        // or unplugged.
        // @decision .agents/decisions/261121_065823-hot-plug-directories.md#every-needs
        await this.#syncEvery();
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

  /**
   * Has a device's installed instance crash or hang on purpose, once the checks pass.
   *
   * @decision .agents/decisions/261119_205416-injected-faults.md#who-may-inject
   */
  async #injectFault(name: string, kind: InjectedFault): Promise<void> {
    this.#requireRunning();
    const slot = this.#slots.get(name);
    if (slot === undefined || slot.removed) {
      throw new RackError("RACK_NO_ROUTE", `no device named ${name}`);
    }
    if (!this.#faultInjection) {
      throw new RackError(
        "RACK_SWAP_REJECTED",
        `${name}: this rack doesn't inject faults; start it with faultInjection: true`,
      );
    }
    if (kind !== "crash" && kind !== "hang") {
      throw new RackError("RACK_INVALID_INPUT", `${name}: no fault "${String(kind)}" to inject`);
    }
    if (kind === "hang" && this.#watchdog === 0) {
      throw new RackError(
        "RACK_SWAP_REJECTED",
        `${name}: watchdogs are off, so nothing would end an injected hang`,
      );
    }
    const instance = slot.installed;
    if (instance === null || instance.dead) {
      throw new RackError("RACK_LINK_DOWN", `${name} has no installed instance`);
    }
    this.#log("warn", `${name}: injecting a ${kind}`);
    await instance.injectFault(kind, this.#hookTimeout);
  }

  #requireRunning(): void {
    if (this.#phase !== "running") {
      throw new RackError("RACK_SWAP_REJECTED", "the rack is not running");
    }
  }

  async #reload(manifest?: RackManifest, hotplugOnly = false): Promise<ReloadResult[]> {
    this.#requireRunning();
    if (manifest !== undefined) this.#adopt(manifest);
    const builds = new Map<string, Promise<Firmware>>();
    let change: Change | undefined;
    if (this.#manifest.scan !== undefined) {
      change = await this.#beginChange(await this.#replan(builds, hotplugOnly), builds);
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
    await this.#logLeftOut();
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
  async #replan(builds: Map<string, Promise<Firmware>>, hotplugOnly = false): Promise<Target> {
    if (hotplugOnly && this.#fixedModels !== undefined && this.#plan !== undefined) {
      // The fixed instances keep their plan and the firmware they run, whatever their files.
      // @decision .agents/decisions/261121_065823-hot-plug-directories.md#when-changes-apply
      for (const slot of this.#slots.values()) {
        if (!slot.hotplug && !slot.removed && !builds.has(slot.source)) {
          builds.set(slot.source, Promise.resolve(slot.firmware));
        }
      }
      return this.#targetWithHotplug(this.#plan, this.#fixedModels, builds);
    }
    const models = await this.#scanModels(builds);
    this.#fixedModels = models;
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
    return this.#targetWithHotplug(next, models, builds);
  }

  /** The layout of a fixed plan with the hot-plug devices placed around it. */
  async #targetWithHotplug(
    plan: Plan,
    models: ReadonlyMap<string, ModelSource>,
    builds: Map<string, Promise<Firmware>>,
  ): Promise<Target> {
    const layout = await this.#withHotplug(plan, models, builds);
    const groups = groupsOf(layout.instances);
    const devices = new Map<string, TargetDevice>();
    for (const instance of layout.instances) {
      const { source } = layout.models.get(instance.model) as ModelSource;
      const device: TargetDevice = {
        u: instance.u,
        source,
        config: this.#configFor(instance, layout.models),
      };
      const group = groups.get(instance.name);
      if (group !== undefined) {
        const root = layout.instances.find((other) => other.name === group) as RunningInstance;
        device.hotplug = true;
        device.hotplugSource = (layout.models.get(root.model) as ModelSource).source;
      }
      devices.set(instance.name, device);
    }
    return { devices, patch: patchesOf({ instances: layout.instances, unused: [] }), plan };
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
      const name = spec.name ?? (await this.#describeForSwap(firmware, spec.config)).model;
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
    const failedGroups = new Set<string>();
    for (const [name, next] of arriving) {
      let firmware: Firmware | undefined;
      try {
        let build = builds.get(next.source);
        if (build === undefined) {
          build = this.#build(next.source);
          builds.set(next.source, build);
        }
        firmware = await build;
        if (next.hotplugSource !== undefined && failedGroups.has(next.hotplugSource)) {
          throw new RackError("RACK_SWAP_REJECTED", `a device of its group failed to plug`);
        }
        await this.#plugSlot(
          next.u,
          mountSpec(next.source, { name, config: next.config }),
          firmware,
          name,
          next.hotplug === true,
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
        // A hot-plug group that doesn't plug is left out whole, copies included.
        // @decision .agents/decisions/261121_065823-hot-plug-directories.md#failures
        if (next.hotplugSource !== undefined && !failedGroups.has(next.hotplugSource)) {
          failedGroups.add(next.hotplugSource);
          this.#leaveOut(next.hotplugSource, error);
        }
      }
    }
    for (const source of failedGroups) {
      for (const [name, next] of arriving) {
        const slot = this.#slots.get(name);
        if (next.hotplugSource === source && slot !== undefined && !slot.removed) {
          await this.#unplugSlot(slot, slot.firmware.hash).catch(() => undefined);
        }
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
    const plan = change.target.plan;
    if (plan !== undefined) {
      // Hot-plug devices that fail are left out; the fixed plan ran whole without them.
      // @decision .agents/decisions/261121_065823-hot-plug-directories.md#the-plan-file
      const complete = [...earlier, ...results].every(
        (result) =>
          result.error === undefined || change.target.devices.get(result.device)?.hotplug === true,
      );
      if (complete) {
        this.#plan = plan;
        if (this.#planMode === "update") {
          await this.#writePlanFile(formatPlan(this.#manifest.name, plan));
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
   * Takes over an edited manifest. The rack keeps its name and its kind, which need a restart to
   * change; its size, devices, and wiring follow the new manifest.
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
      firmware = await this.#build(path, source !== undefined);
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
      const fru = await this.#describeForSwap(firmware, slot.config);
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
  async #describeForSwap(firmware: Firmware, config?: unknown): Promise<Fru> {
    try {
      return await this.#describe(firmware, config);
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
        frus.set(consumer.name, await this.#describeForSwap(next, consumer.config));
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
    // Its listeners leave service with its calls held; nothing listens until the next instance.
    // @decision .agents/decisions/261118_070617-panels-as-devices.md#cold-swaps-restarts-and-resets
    await this.#unlisten(old, 1012, true);
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
    await this.#powerOnHook(instance);
    instance.poweredOn = true;
    await instance.hook("selfTest", this.#hookTimeout);
    if (saved !== undefined) await instance.hook("restore", this.#hookTimeout, saved);
    await instance.hook("activate", this.#hookTimeout);
    instance.active = true;
    await this.#listen(instance);
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
      const fru = await this.#describeForSwap(firmware, slot.config);
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
    /** The listeners' switch: what the new instance bound and the old one stopped. */
    let handover: { bound: string[]; stopped: string[] } | undefined;
    /** The old instance stopped listening, or was asked to and didn't confirm. */
    let switched = false;
    let unconfirmed = false;
    /**
     * Binds the new instance's listeners while the slot is held, then stops the old ones: make
     * before break, with reusePort. A bind that fails fails the swap while the old ones listen.
     *
     * @decision .agents/decisions/261118_070617-panels-as-devices.md#hot-swaps
     */
    const switchListeners = async (next: Instance) => {
      const bound = await this.#listen(next, true);
      let stopped: string[] = [];
      if (old !== null && !old.dead) {
        switched = true;
        const confirmed = await this.#unlisten(old, 1012, false);
        if (confirmed === undefined) {
          unconfirmed = true;
          throw new RackError(
            "RACK_SWAP_REJECTED",
            `${slot.name}: the old instance did not confirm within ${this.#hookTimeout} ms that its listeners stopped`,
          );
        }
        stopped = confirmed;
      }
      handover = { bound, stopped };
    };
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
      await this.#powerOnHook(neo);
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
        // The old instance stops taking requests before it drains, so every request during the
        // handover waits for the new instance and sees the restored state.
        await switchListeners(neo);
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
      if (handover === undefined) await switchListeners(neo);
      // The new instance may have exited while the hold waited; it must not be installed then.
      if (neo.dead) {
        throw new RackError(
          "RACK_SWAP_REJECTED",
          `${slot.name}: the new instance exited before the switch`,
        );
      }
    } catch (error) {
      // A switch goes back: the old instance listens again while the new one still holds the
      // ports, then the new one answers the requests it held with 503.
      // @decision .agents/decisions/261118_070617-panels-as-devices.md#hot-swaps
      let lost: WireError | undefined;
      if (unconfirmed && old !== null) {
        lost = {
          code: "RACK_DEVICE_FAULT",
          message: `${slot.name}: the old instance did not confirm within ${this.#hookTimeout} ms that its listeners stopped`,
        };
      } else if (switched && old !== null && !old.dead) {
        try {
          await this.#listen(old, true);
        } catch (relisten) {
          lost = {
            code: "RACK_DEVICE_FAULT",
            message: `${slot.name}: the old instance did not listen again: ${asRackError(relisten).message}`,
          };
        }
      }
      if (neo !== undefined) await this.#unlisten(neo, 1012, false);
      // The new instance goes at once, but the wait for its thread comes after the old instance
      // serves again, so that a stuck new instance doesn't keep the old one waiting.
      const neoStopped = neo === undefined ? Promise.resolve(true) : this.#end(neo, slot.name);
      const failure = asRackError(error);
      // An old instance that began to deactivate activates again, which also has its watchdogs
      // watch it again. One that didn't answer deactivate, or doesn't activate again, can't keep
      // serving, and goes the way of a watchdog bite.
      // @decision .agents/decisions/261117_185131-ending-instances.md#failed-hot-swaps
      if (lost === undefined && old !== null && !old.dead && deactivating) {
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
    this.#logHandover(slot.name, handover, from, firmware.hash);
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

  /**
   * Logs what a hot swap did to the device's listeners: `listener handed over` for each address
   * that both instances listen on, `listening` for one only the new instance has, and `listener
   * closed` for one only the old instance had.
   *
   * @decision .agents/decisions/261118_070617-panels-as-devices.md#observation
   */
  #logHandover(
    device: string,
    handover: { bound: string[]; stopped: string[] } | undefined,
    from: string | null,
    to: string,
  ): void {
    if (handover === undefined) return;
    const { bound, stopped } = handover;
    for (const url of bound) {
      if (stopped.includes(url))
        this.#log("info", "listener handed over", { url, from, to }, device);
      else this.#log("info", "listening", { url }, device);
    }
    for (const url of stopped) {
      if (!bound.includes(url)) this.#log("info", "listener closed", { url }, device);
    }
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
  async #plugSlot(
    u: number,
    spec: SlotSpec,
    firmware: Firmware,
    label: string,
    hotplug = false,
  ): Promise<void> {
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
    const slot = newSlot({ u, config: spec.config, firmware, instance, hotplug });
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
    // Every needs stop reaching the device first, and the calls in flight to it drain.
    // @decision .agents/decisions/261121_065823-hot-plug-directories.md#when-changes-apply
    await this.#syncEvery();
    const instance = slot.installed;
    slot.installed = null;
    if (instance !== null) await this.#retire(instance);
    const stuck = this.#stuckDevice(name);
    if (stuck !== undefined) throw jammed(stuck);
    this.#slots.delete(name);
    this.#backplane.forget(name);
    this.#ports.delete(name);
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
      const fru = await this.#describeForSwap(firmware, member.config);
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
      const fru = await this.#describeForSwap(only.firmware, only.slot.config);
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
    await this.#syncEvery();
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
    // A file that kept firmware lists stays, such as one that two versions of a device import.
    const kept = new Set<string>();
    for (const firmware of this.#built.values()) {
      if (keep.has(firmware.hash)) for (const file of filesOf(firmware)) kept.add(file);
    }
    for (const [path, firmware] of this.#built) {
      if (keep.has(firmware.hash)) continue;
      this.#built.delete(path);
      if (this.#firmwares.get(firmware.hash) === firmware) this.#firmwares.delete(firmware.hash);
      for (const key of this.#described.keys()) {
        if (key === firmware.hash || key.startsWith(`${firmware.hash} `))
          this.#described.delete(key);
      }
      for (const file of filesOf(firmware)) {
        if (kept.has(file)) continue;
        await unlink(file).catch(() => {
          // Already gone, for example removed with .rack/; there is nothing left to delete.
        });
      }
    }
  }

  /**
   * Deletes the firmware that earlier runs and `rack plan` left in `.rack/firmware/`, which this
   * rack doesn't need. It runs once the rack holds its base directory's management endpoint, which
   * no other rack holds at once, so that no other rack uses that firmware.
   *
   * @decision .agents/decisions/261122_011655-security-review-fixes.md#code-loading-and-the-files-the-rack-writes
   */
  async #sweepFirmware(): Promise<void> {
    const keep = new Set<string>();
    for (const firmware of [...this.#built.values(), ...this.#firmwares.values()]) {
      for (const file of filesOf(firmware)) keep.add(file);
    }
    const deleted = await sweepFirmware(this.#baseDir, keep, this.#begun, alive);
    if (deleted > 0) this.#log("info", "firmware that nothing needs deleted", { files: deleted });
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
      const why = explainMissingPackage(failure.message, firmware, this.#baseDir);
      throw new RackError(code, `${firmware.source}: ${failure.message}${why}`, {
        cause: toWireError(failure),
      });
    }
  }

  /** Powers an instance on, and puts its listeners into service once `activate` succeeded. */
  async #powerOn(instance: Instance): Promise<void> {
    await this.#powerOnHook(instance);
    instance.poweredOn = true;
    await instance.hook("selfTest", this.#hookTimeout);
    await instance.hook("activate", this.#hookTimeout);
    instance.active = true;
    await this.#listen(instance);
  }

  /**
   * Runs the hooks that power an instance down: `deactivate` when it is active, a drain of its
   * calls, `snapshot` when asked, and `powerOff`. A hook that the instance doesn't answer within
   * `hookTimeout` is its last: its calls fail with `RACK_DEVICE_FAULT`, and the rest is skipped.
   *
   * @param markers Hold markers of the switch that retired the instance; calls sent before
   *   them still reach it and must finish first.
   * @param streams The drain waits for the instance's open streams too: it retires, or the rack
   *   stops. A drain that holds calls for a replacement waits for results only.
   * @returns The snapshot and the firmware it came from, when one was asked for and taken.
   * @decision .agents/decisions/261117_185131-ending-instances.md#ending-an-instance
   * @decision .agents/decisions/261118_071155-backplane-streams.md#swaps-and-resets
   */
  async #powerDown(
    instance: Instance,
    markers: Marker[],
    takeSnapshot = false,
    streams = false,
  ): Promise<{ state: unknown; from: string } | undefined> {
    if (instance.dead) return undefined;
    // An unplug and stop() take the listeners out of service as the power-down starts; after a
    // hot swap or for a cold replacement, they are out already.
    // @decision .agents/decisions/261118_070617-panels-as-devices.md#when-listeners-listen
    await this.#unlisten(instance, 1001, true);
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
    if (!(await this.#backplane.drain(instance, markers, this.#drainTimeout, streams))) {
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
    await this.#powerDown(instance, markers, false, true);
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
        stuck: [...this.#stuck]
          .filter(([, stuck]) => stuck.device === slot.name)
          .map(([instance, { firmware, since }]) => ({
            firmware,
            since,
            listeners: this.#listenerStatus(instance, true),
          })),
        listeners: this.#listenerStatus(slot.installed),
      };
      const owner = owners.get(slot.name);
      if (owner !== undefined) status.owner = owner;
      if (slot.hotplug) status.hotplug = true;
      if (slot.firmware.packaged === true) status.packaged = true;
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
    // Kept before the listeners run, so that one that reads the feed finds the event there.
    this.#keep(event);
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // A failing listener must not break the rack or the other listeners.
      }
    }
  }

  /**
   * Keeps an event in the feed as the JSON text of its record, unless it is a log entry of level
   * `debug`, which costs nothing: a device's debugging can't push the other records out. A
   * record beyond {@link FEED_LIMIT} drops the oldest. It never throws, so that the listeners
   * that `#emit` calls next still get the event.
   *
   * @decision .agents/decisions/261124_055114-rack-dashboard.md#the-rack-keeps-its-recent-events
   */
  #keep(event: RackEvent): void {
    if (event.type === "log" && event.level === "debug") return;
    // A log entry keeps its own time, which the spread puts in place of the rack's.
    const record: EventRecord = { seq: this.#feedSeq + 1, time: Date.now(), ...event };
    this.#feed.push(recordText(record));
    // The number is spent only on a record that the feed holds, so that #events finds no gaps.
    this.#feedSeq = record.seq;
    if (this.#feed.length > FEED_LIMIT) this.#feed.shift();
  }

  /**
   * The records of the feed whose `seq` is greater than `after`, oldest first; all of them for 0.
   *
   * @throws RackError `RACK_INVALID_INPUT` for an `after` that isn't a whole number of 0 or more.
   * @decision .agents/decisions/261124_055114-rack-dashboard.md#the-rack-keeps-its-recent-events
   */
  #events(after = 0): EventRecord[] {
    if (!(Number.isInteger(after) && after >= 0)) {
      throw new RackError("RACK_INVALID_INPUT", "events: after must be a whole number, 0 or more");
    }
    // #keep numbers the records it holds without gaps, so the newest one's number places the first
    // to read.
    const first = Math.max(0, this.#feed.length - (this.#feedSeq - after));
    return this.#feed.slice(first).map((text) => JSON.parse(text) as EventRecord);
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

/**
 * The most records the feed of recent events keeps: a new one beyond them drops the oldest.
 *
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#bounds
 */
const FEED_LIMIT = 1_000;

/**
 * The most characters of one record of the feed, as JSON; a longer record is cut.
 *
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#bounds
 */
const RECORD_MAX = 4_096;

/**
 * The most characters of each message of a record that is cut, the last of them `…`.
 *
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#the-rack-keeps-its-recent-events
 */
const CUT_MESSAGE = 1_024;

/**
 * The most characters of the device's name in a record kept at its minimum, the last of them `…`.
 * JSON writes a character as six at most, so that record stays well within {@link RECORD_MAX}.
 *
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#bounds
 */
const MINIMAL_NAME = 256;

/**
 * A record of the feed as the JSON text that the feed keeps, of at most {@link RECORD_MAX}
 * characters. A longer one loses its `data` and its error's `data`, has its message and its
 * error's message cut to {@link CUT_MESSAGE} characters, and gets `cut: true`.
 *
 * Messages full of characters that JSON escapes, which take up to six characters each, can leave
 * the record too long still, and so can a device's name, an error's code, or a swap's `from` or
 * `to` thousands of characters long: those texts are then cut shorter, by half each time, until
 * the record fits, and a `from` or `to` that isn't a string is cut as its `String()`.
 *
 * It never throws, and its text never exceeds the bound: a record that JSON can't write, or that
 * the cuts leave too long, is kept at its minimum, as {@link minimalText} writes it.
 *
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#the-rack-keeps-its-recent-events
 */
function recordText(record: EventRecord): string {
  try {
    let text = recordJson(record);
    for (let limit = CUT_MESSAGE; text.length > RECORD_MAX && limit >= 1; limit >>= 1) {
      text = recordJson(cutRecord(record, limit, limit < CUT_MESSAGE));
    }
    if (text.length <= RECORD_MAX) return text;
  } catch {
    // A field other than the details holds what JSON can't write, such as a circular `to` that
    // code gave rollback() against its type; the minimum below holds none of those fields.
  }
  return minimalText(record);
}

/**
 * A record as JSON, with its details as `--log json` writes them: a `bigint` as a string ending in
 * `n`, and details that JSON can't hold otherwise, such as circular ones, as their `String()`.
 * A log record's details are its `data`, and a swap's or a fault's, its error's `data`.
 *
 * @throws TypeError when a field other than the details holds what JSON can't write, which only
 *   code that breaks the types gives, such as a circular `to` of rollback().
 */
function recordJson(record: EventRecord): string {
  try {
    return JSON.stringify(record, bigints);
  } catch {
    // The rack's own fields are strings, numbers, booleans, or null, so the details failed,
    // unless code gave a value against its type, which this throws for again.
    return JSON.stringify(detailsAsText(record));
  }
}

/**
 * A record at its minimum, as JSON: its `seq`, `time`, and `type`, its device's name cut to
 * {@link MINIMAL_NAME} characters, and `cut: true`. Every field is one the rack sets, so JSON
 * writes it, and its text stays within {@link RECORD_MAX}.
 */
function minimalText(record: EventRecord): string {
  const minimal: Record<string, unknown> = {
    seq: record.seq,
    time: record.time,
    type: record.type,
  };
  // Every record but a log entry of the rack's own names a device.
  if (typeof record.device === "string") minimal.device = cutText(record.device, MINIMAL_NAME);
  minimal.cut = true;
  return JSON.stringify(minimal);
}

/** A record whose details are their text, as {@link detailText} gives it. */
function detailsAsText(record: EventRecord): EventRecord {
  if (record.type === "log") return { ...record, data: detailText(record.data) };
  if (record.type === "power" || record.error === undefined) return record;
  return { ...record, error: { ...record.error, data: detailText(record.error.data) } };
}

/**
 * A record without its details, and with its messages cut to `limit` characters; with `names`,
 * also its device's name, its error's code, and a swap's `from` and `to`. A value that isn't a
 * string, such as a `to` that code gave rollback() against its type, is cut as its `String()`,
 * so that it can't keep the record long; `null` stays.
 */
function cutRecord(record: EventRecord, limit: number, names: boolean): EventRecord {
  const shorten = (value: unknown) =>
    value === null || value === undefined
      ? value
      : cutText(typeof value === "string" ? value : detailText(value), limit);
  const fields: Record<string, unknown> = { ...record, cut: true };
  // JSON leaves out a field that is undefined.
  fields.data = undefined;
  fields.message = shorten(fields.message);
  if (names) {
    fields.device = shorten(fields.device);
    if (record.type === "swap") {
      fields.from = shorten(record.from);
      fields.to = shorten(record.to);
    }
  }
  if (record.type !== "power" && record.type !== "log" && record.error !== undefined) {
    const { code, message } = record.error;
    fields.error = { code: names ? shorten(code) : code, message: shorten(message) };
  }
  return fields as EventRecord;
}

/**
 * A text cut to `max` characters, the last of them `…`, and never between the two halves of a
 * character outside the Basic Multilingual Plane; a text that fits stays as it is.
 */
function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

/** An instance being ended: the device it belongs to, and whether its thread stopped in time. */
interface Ending {
  /** The device's name; `undefined` for a Worker that loaded firmware without a name. */
  device: string | undefined;
  done: Promise<boolean>;
}

/** A listener's address in the rack's table, and the device whose instance reserved it. */
interface Address extends Omit<InheritedListener, "held"> {
  device: string;
}

/** A stuck thread: the instance's {@link StuckThread} status, and the device it belongs to. */
interface Stuck extends Omit<StuckThread, "listeners"> {
  /** As in {@link Ending}; a stuck thread without a device keeps its firmware from loading. */
  device: string | undefined;
}

interface Booted {
  u: number;
  config: unknown;
  firmware: Firmware;
  instance: Instance;
  /** A hot-plug device, or a copy that one owns. */
  hotplug?: boolean;
}

/** What an update runs for: its cause and start time, and for a fallback, the crash. */
/**
 * A failure while an executable's rack starts that a device's outside file caused, which its
 * packaged firmware may not have.
 *
 * @decision .agents/decisions/261120_011627-single-executables.md#falling-back
 */
class OutsideFailure extends Error {
  /**
   * @param source The device file.
   * @param failure What the start would have failed with.
   * @param from The hash of the outside file's firmware; `null` when it didn't build.
   */
  constructor(
    readonly source: string,
    readonly failure: RackError,
    readonly from: string | null,
  ) {
    super(failure.message);
  }
}

/** Why a device file runs its packaged firmware after a start in an executable. */
interface Fallen {
  error: WireError;
  /** The hash of the outside file's firmware; `null` when it didn't build. */
  from: string | null;
}

/** Whether two firmwares declare the same model, height, priority, needs, and ports. */
function sameDeclarations(a: Fru, b: Fru): boolean {
  const declared = (fru: Fru) => ({
    model: fru.model,
    height: fru.height,
    priority: fru.priority,
    needs: fru.needs,
    provides: fru.provides,
  });
  return Bun.deepEquals(declared(a), declared(b));
}

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
  /** A hot-plug device, or a copy that one owns. */
  hotplug?: boolean;
  /** For a hot-plug instance, the file of the hot-plug device of its group. */
  hotplugSource?: string;
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
  /** A hot-plug device, or a copy that one owns. */
  hotplug?: boolean;
  /** For a hot-plug instance, the hot-plug device of its group: itself, or its owner. */
  group?: string;
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
  /** The hot-plug instances, as lines of a plan file with the slots that they would take. */
  hotplug: string[];
  /** The hot-plug files that can't run, by their path in the base directory, with why. */
  leftOut: { path: string; reason: string }[];
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

/**
 * Builds a device file and reads what it declares, its model, height, needs, and ports, without
 * starting a rack: the firmware loads once in a Worker that ends after. Not exported from
 * `racku`; the bench uses it.
 *
 * @param source The device file: a path relative to `options.baseDir`, or a `file:` URL.
 * @param config The configuration that needs computed from the configuration come from.
 * @param options Start options; the base directory, logger, and `hookTimeout` apply.
 * @returns The device's FRU data.
 * @throws RackError `RACK_MANIFEST` when the file doesn't build or load as a device.
 * @decision .agents/decisions/261118_173457-device-test-bench.md#stubs
 */
export async function describeDevice(
  source: string | URL,
  config: unknown,
  options: StartOptions = {},
): Promise<Fru> {
  const empty = rackManifest("describe", { slots: {} });
  return new Rack(empty, { ...options, plan: false }).describeFile(source, config);
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
export async function deviceFiles(dir: string): Promise<string[]> {
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
/** Fails a call to a rack that isn't running; the call still takes its buffers and its stream. */
function refuse(where: string, input: unknown, options: CallOptions): Promise<never> {
  cancelStreams(input, new RackError("RACK_CANCELLED", `${where}: the rack is not running`));
  try {
    const transfer = transferList(options.transfer, where);
    if (transfer !== undefined) detach(transfer);
  } catch (error) {
    return Promise.reject(error);
  }
  return Promise.reject(new RackError("RACK_LINK_DOWN", "the rack is not running"));
}

function newSlot({ u, config, firmware, instance, hotplug = false }: Booted): Slot {
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
    hotplug,
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

function codeOf(error: unknown): string {
  return error instanceof RackError ? error.code : "RACK_DEVICE_FAULT";
}

/** A hot-plug file that can't run, and why. */
interface LeftOutFile {
  reason: string;
  code: string;
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );
}

/**
 * The hot-plug device of each hot-plug instance's group: the device itself, or the device that
 * owns the copy, through copies of copies.
 */
function groupsOf(instances: readonly RunningInstance[]): Map<string, string> {
  const owners = new Map(instances.map((instance) => [instance.name, instance.owner]));
  const groups = new Map<string, string>();
  for (const instance of instances) {
    if (!instance.hotplug) continue;
    let root = instance.name;
    for (let owner = owners.get(root); owner !== undefined; owner = owners.get(root)) root = owner;
    groups.set(instance.name, root);
  }
  return groups;
}

function positive(name: string, value: number): number {
  if (!(typeof value === "number" && Number.isFinite(value) && value > 0)) {
    throw new RackError("RACK_MANIFEST", `${name} must be a positive number of milliseconds`);
  }
  return value;
}

/**
 * The key a description of firmware is kept under: its hash, and the configuration it was
 * described with; `undefined` for a configuration that has no plain-text form, which isn't kept.
 */
function describedKey(firmware: Firmware, config: unknown): string | undefined {
  if (config === undefined) return firmware.hash;
  try {
    return `${firmware.hash} ${JSON.stringify(config)}`;
  } catch {
    // Not plain data, such as a BigInt: the firmware is described again each time.
    return undefined;
  }
}

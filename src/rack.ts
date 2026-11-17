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
 */
import { resolve as resolvePath } from "node:path";
import { Backplane, type Slot, type SlotState } from "./backplane.ts";
import type { ConnectorInfo } from "./connector.ts";
import type { CallOptions } from "./device.ts";
import { RackError, toWireError, type WireError } from "./errors.ts";
import { buildFirmware, type Firmware } from "./firmware.ts";
import { Instance, type InstanceHost, type Wire } from "./instance.ts";
import { consoleLogger, type LogEntry, type Logger } from "./log.ts";
import {
  checkDeviceName,
  isRackManifest,
  isSlotSpec,
  parseAddress,
  type RackManifest,
  type SlotSpec,
} from "./manifest.ts";
import type { DeviceMetrics, RackMetrics } from "./metrics.ts";
import { openHttpPanel, type Panel } from "./panel.ts";
import type { DataFromWorker, Fru, LogNotice, Marker } from "./protocol.ts";
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
  /** The last failed swap or crash. */
  error?: WireError;
}

/** What a management operation did to a device. */
export type SwapAction = "plug" | "unplug" | "swap";

/** An event of the rack, delivered to {@link RackHandle.subscribe} listeners. */
export type RackEvent =
  | { type: "power"; device: string; firmware: string; state: "on" | "off" }
  | {
      type: "swap";
      device: string;
      action: SwapAction;
      from: string | null;
      to: string | null;
      error?: WireError;
    }
  | { type: "fault"; device: string; firmware: string; error: WireError; reset: boolean }
  | ({ type: "log" } & LogEntry);

/** One device that {@link RackHandle.reload} tried to swap. */
export interface ReloadResult {
  device: string;
  from: string | null;
  to: string | null;
  error?: WireError;
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
  /** Rebuilds every firmware and swaps only the devices whose hash changed. */
  reload(): Promise<ReloadResult[]>;
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
  readonly #manifest: RackManifest;
  readonly #baseDir: string;
  readonly #logger: Logger;
  readonly #callTimeout: number;
  readonly #hookTimeout: number;
  readonly #drainTimeout: number;
  readonly #slots = new Map<string, Slot>();
  readonly #backplane: Backplane;
  readonly #listeners = new Set<(event: RackEvent) => void>();
  /** Every instance whose Worker has not exited. */
  readonly #instances = new Set<Instance>();
  #phase: Phase = "starting";
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
    this.#backplane = new Backplane(
      this.#slots,
      this.#instances,
      this.#callTimeout,
      this.#hookTimeout,
    );
  }

  handle(): RackHandle {
    return Object.freeze({
      status: () => this.#status(),
      call: (address: string, method: string, input: unknown, options: CallOptions = {}) =>
        this.#phase === "running"
          ? this.#backplane.call(address, method, input, options, "rack")
          : refuse(`${address}.${method}`, options),
      reload: () => this.#serialize(() => this.#reload()),
      swap: (name: string, source?: string | URL) =>
        this.#serialize(() => this.#swap(name, source)),
      plug: (u: number, spec: SlotSpec) => this.#serialize(() => this.#plug(u, spec)),
      unplug: (name: string) => this.#serialize(() => this.#unplug(name)),
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
    const error: WireError = { code: "RACK_DEVICE_FAULT", message };
    const reset = this.#countCrash(slot, instance.firmware.hash, error);
    // A running swap installs its new instance, or resets the slot when it fails.
    // @decision .agents/decisions/261115_222025-p0-api-details.md#resets
    if (reset && !slot.busy) void this.#reset(slot);
  }

  // ---- Start and stop ----

  async start(): Promise<void> {
    try {
      const entries = this.#manifest.slots.map(({ u, spec }) => ({
        u,
        spec,
        source: resolveSource(spec.source, this.#baseDir),
      }));
      const builds = new Map<string, Promise<Firmware>>();
      for (const { source } of entries) {
        if (!builds.has(source)) builds.set(source, buildFirmware(source, this.#baseDir));
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
      this.#phase = "running";
      this.#log("info", `rack ${this.#manifest.name} started`, { devices: this.#slots.size });
    } catch (error) {
      await this.#abortStart();
      throw error;
    }
  }

  #throwStartFault(): void {
    if (this.#startFault !== undefined) throw this.#startFault;
  }

  async #abortStart(): Promise<void> {
    this.#phase = "stopping";
    await this.#panel?.stop().catch(() => undefined);
    this.#panel = undefined;
    for (const slot of this.#ordered().reverse()) {
      const instance = slot.installed;
      slot.installed = null;
      slot.removed = true;
      if (instance === null || instance.dead) continue;
      if (instance.active) await this.#bestEffort(instance, "deactivate");
      if (instance.poweredOn) await this.#bestEffort(instance, "powerOff");
    }
    for (const instance of [...this.#instances]) instance.terminate();
    this.#slots.clear();
    this.#phase = "stopped";
  }

  async #stop(): Promise<void> {
    if (this.#phase !== "running") return;
    this.#phase = "stopping";
    await this.#panel?.stop();
    this.#panel = undefined;
    // Top down: upper devices finish their work while the devices below still serve them.
    // @decision .agents/decisions/261112_035942-rack-architecture.md#gravity-rule
    for (const slot of this.#ordered().reverse()) {
      const instance = slot.installed;
      if (instance !== null) await this.#retire(instance);
      slot.installed = null;
      slot.removed = true;
    }
    for (const instance of [...this.#instances]) instance.terminate();
    this.#slots.clear();
    this.#phase = "stopped";
    this.#log("info", `rack ${this.#manifest.name} stopped`);
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
    for (const [consumer] of this.#manifest.patch) {
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
  #wire(name: string, u: number, fru: Fru, previous: ReadonlyMap<string, Wire>): Map<string, Wire> {
    const wiring = new Map<string, Wire>();
    for (const [need, info] of Object.entries(fru.needs)) {
      const where = `${name}.${need} (${info.id})`;
      const kept = previous.get(need);
      const keptPort = kept && this.#slots.get(kept.provider)?.fru.provides[kept.port];
      if (kept !== undefined && keptPort && keptPort.id === info.id && covers(keptPort, info)) {
        wiring.set(need, kept);
        continue;
      }
      const patch = this.#manifest.patch.find(([consumer]) => consumer === `${name}.${need}`);
      if (patch !== undefined) {
        const target = parseAddress(patch[1]);
        const provider = this.#slots.get(target.device);
        if (provider === undefined) {
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
        const port = provider.fru.provides[target.port];
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
        for (const [port, portInfo] of Object.entries(slot.fru.provides)) {
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
  #checkCompatibility(slot: Slot, fru: Fru): void {
    for (const consumer of this.#slots.values()) {
      if (consumer === slot || consumer.removed) continue;
      for (const [need, wire] of consumer.wiring) {
        if (wire.provider !== slot.name) continue;
        const needInfo = consumer.fru.needs[need];
        const port = fru.provides[wire.port];
        const user = `${consumer.name}.${need}`;
        if (port === undefined) {
          throw new RackError(
            "RACK_SWAP_REJECTED",
            `${user} uses ${slot.name}.${wire.port}, which the new firmware does not provide`,
          );
        }
        if (needInfo !== undefined && (port.id !== needInfo.id || !covers(port, needInfo))) {
          throw new RackError(
            "RACK_SWAP_REJECTED",
            `${user} needs ${needInfo.id}; the new ${slot.name}.${wire.port} is ${port.id} with members ${Object.keys(port.members).join(", ")}`,
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

  // ---- Management operations ----

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

  async #reload(): Promise<ReloadResult[]> {
    this.#requireRunning();
    const slots = this.#ordered();
    const builds = new Map<string, Promise<Firmware>>();
    for (const slot of slots) {
      if (!builds.has(slot.source))
        builds.set(slot.source, buildFirmware(slot.source, this.#baseDir));
    }
    await Promise.allSettled(builds.values());
    const results: ReloadResult[] = [];
    for (const slot of slots) {
      if (slot.removed || this.#phase !== "running") continue;
      const from = slot.installed?.firmware.hash ?? null;
      let firmware: Firmware;
      try {
        firmware = (await builds.get(slot.source)) as Firmware;
      } catch (error) {
        if (slot.installed !== null && !slot.busy) slot.state = "degraded";
        const failure = new RackError("RACK_SWAP_REJECTED", messageOf(error));
        this.#swapFailed(slot.name, "swap", from, null, failure, slot);
        results.push({ device: slot.name, from, to: null, error: toWireError(failure) });
        continue;
      }
      if (firmware.hash === slot.firmware.hash) continue;
      try {
        await this.#swapSlot(slot, firmware, slot.source);
        results.push({ device: slot.name, from, to: firmware.hash });
      } catch (error) {
        results.push({ device: slot.name, from, to: firmware.hash, error: toWireError(error) });
      }
    }
    return results;
  }

  async #swap(name: string, source: string | URL | undefined): Promise<void> {
    this.#requireRunning();
    const slot = this.#slots.get(name);
    if (slot === undefined || slot.removed) {
      throw new RackError("RACK_NO_ROUTE", `no device named ${name}`);
    }
    const path = source === undefined ? slot.source : resolveSource(source, this.#baseDir);
    let firmware: Firmware;
    try {
      firmware = await buildFirmware(path, this.#baseDir);
    } catch (error) {
      const from = slot.installed?.firmware.hash ?? null;
      if (slot.installed !== null && !slot.busy) slot.state = "degraded";
      const failure = new RackError("RACK_SWAP_REJECTED", messageOf(error));
      throw this.#swapFailed(name, "swap", from, null, failure, slot);
    }
    await this.#swapSlot(slot, firmware, path);
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
      this.#checkCompatibility(slot, fru);
      // A standby instance can call its needs from powerOn on; events reach it once installed.
      await this.#backplane.connect(neo);
      await neo.hook("powerOn", this.#hookTimeout);
      neo.poweredOn = true;
      await neo.hook("selfTest", this.#hookTimeout);
      // Background tasks are break-before-make: the old ones stop before the new ones start.
      if (old !== null && !old.dead) {
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
      neo?.terminate();
      const failure = asRackError(error);
      if (old !== null && !old.dead) {
        if (deactivated) {
          try {
            await old.hook("activate", this.#hookTimeout);
            old.active = true;
          } catch (reactivation) {
            this.#log("error", `${slot.name}: the old instance did not reactivate`, {
              error: toWireError(reactivation),
            });
          }
        }
        slot.state = "degraded";
      }
      if (held) await this.#backplane.release(slot);
      slot.busy = false;
      if (old === null) slot.state = "faulted";
      else if (old.dead) this.#recover(slot);
      throw this.#swapFailed(slot.name, "swap", from, firmware.hash, failure, slot);
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
    this.#emit({ type: "swap", device: slot.name, action: "swap", from, to: firmware.hash });
    this.#log("info", `${slot.name} swapped`, { from, to: firmware.hash });
    // A crash while the slot was busy was counted but not reset; the reset starts now.
    // @decision .agents/decisions/261115_222025-p0-api-details.md#resets
    if (neo.dead && slot.installed === null) this.#recover(slot);
  }

  async #plug(u: number, spec: SlotSpec): Promise<void> {
    this.#requireRunning();
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
      firmware = await buildFirmware(source, this.#baseDir);
    } catch (error) {
      const failure = new RackError("RACK_SWAP_REJECTED", messageOf(error));
      throw this.#swapFailed(label, "plug", null, null, failure);
    }
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
      await this.#backplane.connect(instance);
      await this.#powerOn(instance);
      this.#requireRunning();
    } catch (error) {
      instance?.terminate();
      const name = instance?.fru?.name ?? label;
      throw this.#swapFailed(name, "plug", null, firmware.hash, asRackError(error));
    }
    const slot = newSlot({ u, config: spec.config, firmware, instance });
    slot.wiring = instance.wiring;
    slot.state = "online";
    this.#slots.set(slot.name, slot);
    await this.#backplane.install(slot, instance, null);
    if (!instance.dead) this.#powered(instance);
    this.#emit({ type: "swap", device: slot.name, action: "plug", from: null, to: firmware.hash });
    this.#log("info", `${slot.name} plugged in at U${u}`, { firmware: firmware.hash });
  }

  async #unplug(name: string): Promise<void> {
    this.#requireRunning();
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
    slot.removed = true;
    slot.busy = true;
    const instance = slot.installed;
    slot.installed = null;
    if (instance !== null) await this.#retire(instance);
    this.#slots.delete(name);
    this.#emit({ type: "swap", device: name, action: "unplug", from, to: null });
    this.#log("info", `${name} unplugged`);
  }

  // ---- Instances ----

  async #boot(
    firmware: Firmware,
    name: string | undefined,
    u: number,
    config: unknown,
    code: "RACK_MANIFEST" | "RACK_SWAP_REJECTED",
  ): Promise<Instance> {
    const instance = new Instance(firmware, name ?? firmware.source, this);
    this.#instances.add(instance);
    try {
      await instance.boot({
        name,
        u,
        config,
        baseDir: this.#baseDir,
        callTimeout: this.#callTimeout,
        timeout: this.#hookTimeout,
      });
      return instance;
    } catch (error) {
      instance.terminate();
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
   * Deactivates if needed, drains, powers off, and terminates an instance.
   *
   * @param markers Hold markers of the switch that retired the instance; calls sent before
   *   them still reach it and must finish first.
   */
  async #retire(instance: Instance, markers: Marker[] = []): Promise<void> {
    const wasAlive = !instance.dead;
    if (wasAlive) {
      if (instance.active) await this.#bestEffort(instance, "deactivate");
      instance.active = false;
      if (!(await this.#backplane.drain(instance, markers, this.#drainTimeout))) {
        this.#backplane.fail(
          instance,
          "RACK_LINK_DOWN",
          `${instance.slot} was powered off before the call finished`,
        );
      }
      if (instance.poweredOn && !instance.dead) await this.#bestEffort(instance, "powerOff");
    }
    instance.terminate();
    if (!wasAlive) return;
    this.#emit({
      type: "power",
      device: instance.slot,
      firmware: instance.firmware.hash,
      state: "off",
    });
    this.#log("info", `${instance.slot} powered off`, { firmware: instance.firmware.hash });
  }

  async #bestEffort(instance: Instance, hook: "deactivate" | "powerOff"): Promise<void> {
    try {
      await instance.hook(hook, this.#hookTimeout);
    } catch (error) {
      this.#log("warn", `${instance.slot}: ${hook} failed`, { error: toWireError(error) });
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
    slot.crashes = slot.crashes.filter((time) => now - time < CRASH_WINDOW);
    slot.crashes.push(now);
    slot.error = error;
    const reset = slot.crashes.length <= CRASH_LIMIT;
    if (!reset) slot.state = "faulted";
    this.#emit({ type: "fault", device: slot.name, firmware, error, reset });
    if (!reset) {
      this.#log("error", `${slot.name} faulted after ${slot.crashes.length} crashes within 60 s`);
    }
    return reset;
  }

  /** After a failed swap lost the old instance: reset, or stay faulted at the crash limit. */
  #recover(slot: Slot): void {
    const now = Date.now();
    const recent = slot.crashes.filter((time) => now - time < CRASH_WINDOW).length;
    if (recent > CRASH_LIMIT) slot.state = "faulted";
    else void this.#reset(slot);
  }

  /**
   * Resets a slot from the same firmware: a new instance runs `powerOn`, `selfTest`, and
   * `activate`. A failed attempt counts as another crash.
   */
  async #reset(slot: Slot): Promise<void> {
    slot.busy = true;
    slot.state = "resetting";
    try {
      while (this.#phase === "running" && !slot.removed) {
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
            instance.terminate();
            return;
          }
          slot.installed = instance;
          slot.fru = instance.fru as Fru;
          slot.state = "online";
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
          instance?.terminate();
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
        crashes: slot.crashes.filter((time) => now - time < CRASH_WINDOW).length,
      };
      if (slot.error !== undefined) status.error = slot.error;
      return status;
    });
  }

  async #metrics(): Promise<RackMetrics> {
    if (this.#phase !== "running") return { devices: [] };
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
    return { devices };
  }

  #swapFailed(
    device: string,
    action: SwapAction,
    from: string | null,
    to: string | null,
    error: RackError,
    slot?: Slot,
  ): RackError {
    const wire = toWireError(error);
    if (slot !== undefined) slot.error = wire;
    this.#emit({ type: "swap", device, action, from, to, error: wire });
    this.#log("error", `${action} of ${device} failed: ${wire.message}`, { code: wire.code });
    return error;
  }

  #emit(event: RackEvent): void {
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

interface Booted {
  u: number;
  config: unknown;
  firmware: Firmware;
  instance: Instance;
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
    crashes: [],
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

/**
 * Rack manifests: which device file sits in which slot, and explicit patches.
 *
 * A manifest references devices only by path; building one never loads device code.
 *
 * @decision .agents/decisions/261112_043034-device-api.md#rack-manifest
 * @decision .agents/decisions/261112_035943-hot-swap.md#the-main-thread-never-loads-device-code
 * @decision .agents/decisions/261115_222025-p0-api-details.md#names
 * @decision .agents/decisions/261116_233919-automatic-assembly.md#scanned-manifests
 * @decision .agents/decisions/261118_071513-http-panel-device.md#manifests
 * @decision .agents/decisions/261121_065823-hot-plug-directories.md#hot-plug-directories
 */
import { posix } from "node:path";
import { isConnectorId, isIdentifierName } from "./connector.ts";
import { RackError } from "./errors.ts";

const SLOT: unique symbol = Symbol.for("rack42u.slot");
const RACK: unique symbol = Symbol.for("rack42u.rack");
const DEVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Options of {@link slot}. */
export interface SlotOptions {
  /** Device name; defaults to the model name the device reports. */
  name?: string | undefined;
  /** Configuration, validated by the device's config schema at boot; must be structured-cloneable. */
  config?: unknown;
}

/** A mount description: the device file and how to mount it. */
export interface SlotSpec {
  readonly [SLOT]: true;
  /** Path of the device file; relative paths resolve against the rack base directory. */
  readonly source: string | URL;
  readonly name: string | undefined;
  readonly config: unknown;
}

/** A rack whose devices are placed in slots by hand. */
export interface PlacedRackSpec {
  /** Capacity in U; default 42. */
  size?: number;
  /** Slot number (from 1 at the bottom) mapped to the device mounted there. */
  slots: Record<number, SlotSpec>;
  /** Explicit wiring: `[<consumer device>.<need>, <provider device>.<port>]`. */
  patch?: ReadonlyArray<readonly [string, string]>;
  devices?: never;
  hotplug?: never;
}

/** A rack whose devices are scanned from files and placed by its plan. */
export interface ScannedRackSpec {
  /** Capacity in U; default 42. */
  size?: number;
  /**
   * Where device models come from: directories, whose device files are found at any depth, and
   * `slot()` or standard-device specs, whose `config` becomes the model's default configuration.
   * A `name` in a spec defines a variant: the same file under that model name.
   */
  devices: ReadonlyArray<string | SlotSpec>;
  /**
   * Hot-plug directories, relative to the base directory and inside it: every device file in
   * them starts on its own, without being a root, and comes and goes with its file. Only every
   * needs reach these devices, and a file that can't run is left out, while the rest of the rack
   * starts and reloads.
   */
  hotplug?: readonly string[];
  /** Models that start of their own accord, an HTTP panel among them. */
  roots?: readonly string[];
  /** Provider choices: a connector id, or `<model>.<need>`, mapped to a model name. */
  use?: Readonly<Record<string, string>>;
  /** Configuration by instance name or by model; an instance name wins over its model. */
  config?: Readonly<Record<string, unknown>>;
  slots?: never;
  patch?: never;
}

/** What {@link rack} accepts: slots placed by hand, or devices to scan. */
export type RackSpec = PlacedRackSpec | ScannedRackSpec;

/** How a scanned rack finds and plans its devices. */
export interface ScanSpec {
  readonly devices: ReadonlyArray<string | SlotSpec>;
  /** Hot-plug directories, as relative paths with `/` separators. */
  readonly hotplug: readonly string[];
  readonly roots: readonly string[];
  readonly use: Readonly<Record<string, string>>;
  readonly config: Readonly<Record<string, unknown>>;
}

/** One mounted slot of a manifest. */
export interface ManifestSlot {
  readonly u: number;
  readonly spec: SlotSpec;
}

/** A validated rack manifest, the default export of a manifest file. */
export interface RackManifest {
  readonly [RACK]: true;
  readonly name: string;
  readonly size: number;
  /** Mounted slots, ordered from the bottom up. */
  readonly slots: readonly ManifestSlot[];
  readonly patch: ReadonlyArray<readonly [string, string]>;
  /** Present for a scanned rack, whose `slots` and `patch` are then empty. */
  readonly scan: ScanSpec | undefined;
}

/** A parsed `<device>.<port>` address. */
export interface Address {
  device: string;
  port: string;
}

/**
 * Describes a device to mount.
 *
 * @param source Path of the device file, as a string or a `file:` URL; a relative path resolves
 *   against the rack base directory when the rack starts.
 * @param options Device name and configuration.
 * @returns A mount description; no device code is loaded.
 * @throws RackError `RACK_MANIFEST` when the source or the name is malformed.
 */
export function slot(source: string | URL, options: SlotOptions = {}): SlotSpec {
  if (source instanceof URL) {
    if (source.protocol !== "file:") {
      throw new RackError("RACK_MANIFEST", `slot source ${source.href} is not a file: URL`);
    }
  } else if (typeof source !== "string" || source === "") {
    throw new RackError("RACK_MANIFEST", "slot() requires a device file path");
  }
  const { name, config } = options;
  if (name !== undefined) checkDeviceName(name);
  return Object.freeze({ [SLOT]: true as const, source, name, config });
}

/**
 * Declares a rack manifest.
 *
 * @param name Rack name. A scanned rack also uses it to name its plan file, `<name>.plan`.
 * @param spec Size, with either slots and patches, or the devices to scan.
 * @returns The validated manifest.
 * @throws RackError `RACK_MANIFEST` when a field is malformed, when a spec has both `slots`
 *   and `devices`, or when it has a `panel` section, which `httpPanel()` replaces. Checks that
 *   need the devices' FRU data, such as overlap and wiring, run when the rack starts.
 */
export function rack(name: string, spec: RackSpec): RackManifest {
  if (typeof name !== "string" || name === "") {
    throw new RackError("RACK_MANIFEST", "rack() requires a non-empty name");
  }
  if (typeof spec !== "object" || spec === null) {
    throw new RackError("RACK_MANIFEST", `rack ${name}: rack() requires a spec object`);
  }
  const size = spec.size ?? 42;
  if (!Number.isInteger(size) || size < 1) {
    throw new RackError("RACK_MANIFEST", `rack ${name}: size must be a positive integer`);
  }
  // The HTTP panel is a device now; a manifest from before says where it went.
  // @decision .agents/decisions/261118_071513-http-panel-device.md#manifests
  if ((spec as { panel?: unknown }).panel !== undefined) {
    throw new RackError(
      "RACK_MANIFEST",
      `rack ${name}: the panel section is gone; mount httpPanel() from rack42u/std in a slot, or list it in a scanned rack's devices and roots`,
    );
  }
  if (spec.devices !== undefined) {
    if (spec.slots !== undefined || spec.patch !== undefined) {
      throw new RackError(
        "RACK_MANIFEST",
        `rack ${name}: a rack has either slots and patch, or devices, not both`,
      );
    }
    return Object.freeze({
      [RACK]: true as const,
      name,
      size,
      slots: Object.freeze([]),
      patch: Object.freeze([]),
      scan: checkScan(name, spec),
    });
  }
  if (typeof spec.slots !== "object" || spec.slots === null) {
    throw new RackError("RACK_MANIFEST", `rack ${name}: slots must be an object`);
  }
  const slots: ManifestSlot[] = [];
  for (const [key, value] of Object.entries(spec.slots)) {
    const u = Number(key);
    if (!/^\d+$/.test(key) || u < 1 || u > size) {
      throw new RackError("RACK_MANIFEST", `rack ${name}: slot ${key} is outside 1..${size}`);
    }
    if (!isSlotSpec(value)) {
      throw new RackError(
        "RACK_MANIFEST",
        `rack ${name}: slot ${key} must be created by slot() or a standard device factory`,
      );
    }
    slots.push({ u, spec: value });
  }
  slots.sort((a, b) => a.u - b.u);

  const patch = spec.patch ?? [];
  if (!Array.isArray(patch)) {
    throw new RackError("RACK_MANIFEST", `rack ${name}: patch must be an array`);
  }
  for (const entry of patch) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new RackError(
        "RACK_MANIFEST",
        `rack ${name}: each patch entry is [consumer, provider]`,
      );
    }
    parseAddress(entry[0]);
    parseAddress(entry[1]);
  }

  return Object.freeze({
    [RACK]: true as const,
    name,
    size,
    slots: Object.freeze(slots),
    patch: Object.freeze(patch.map((entry) => Object.freeze([entry[0], entry[1]] as const))),
    scan: undefined,
  });
}

function checkScan(name: string, spec: ScannedRackSpec): ScanSpec {
  const fail = (message: string): never => {
    throw new RackError("RACK_MANIFEST", `rack ${name}: ${message}`);
  };
  // The plan file is named after the rack, so the name must be a safe file name.
  // @decision .agents/decisions/261116_233919-automatic-assembly.md#plan-file
  if (!DEVICE_NAME.test(name)) {
    fail(`a scanned rack's name names its plan file and must match ${DEVICE_NAME.source}`);
  }
  const { devices } = spec;
  if (!Array.isArray(devices) || devices.length === 0) {
    fail("devices must be a non-empty array of directories and slot() specs");
  }
  for (const entry of devices) {
    if (!(typeof entry === "string" && entry !== "") && !isSlotSpec(entry)) {
      fail("each entry of devices is a directory path or a spec created by slot()");
    }
  }
  const roots = spec.roots ?? [];
  if (!Array.isArray(roots)) fail("roots must be an array of model names");
  for (const root of roots) {
    if (typeof root !== "string" || !DEVICE_NAME.test(root))
      fail(`root "${root}" is not a model name`);
  }
  const use = spec.use ?? {};
  if (typeof use !== "object" || use === null) fail("use must be an object");
  for (const [key, model] of Object.entries(use)) {
    const dot = key.indexOf(".");
    const valid = isConnectorId(key) || (dot > 0 && isAddress(key));
    if (!valid) fail(`use key "${key}" is neither a connector id nor <model>.<need>`);
    if (typeof model !== "string" || !DEVICE_NAME.test(model)) {
      fail(`use ${key} names "${String(model)}", which is not a model name`);
    }
  }
  const config = spec.config ?? {};
  if (typeof config !== "object" || config === null) fail("config must be an object");
  const hotplug = spec.hotplug ?? [];
  if (!Array.isArray(hotplug)) fail("hotplug must be an array of directories");
  const dirs: string[] = [];
  for (const entry of hotplug) {
    if (typeof entry !== "string" || entry === "")
      fail("each entry of hotplug is a directory path");
    // Inside the base directory, which the watchers of rack start and rack dev watch; the rack
    // checks that it overlaps no devices directory, once it knows the base directory.
    // @decision .agents/decisions/261121_065823-hot-plug-directories.md#hot-plug-directories
    const dir = relativeDir(entry);
    if (dir === undefined || dir === ".") {
      fail(`hotplug directory ${entry} must be a relative path inside the base directory`);
    }
    dirs.push(dir as string);
  }
  return Object.freeze({
    devices: Object.freeze([...devices]),
    hotplug: Object.freeze(dirs),
    roots: Object.freeze([...roots]),
    use: Object.freeze({ ...use }),
    config: Object.freeze({ ...config }),
  });
}

/** A relative path inside the base directory, with `/` separators; `undefined` for others. */
function relativeDir(path: string): string | undefined {
  const normal = posix.normalize(path.replaceAll("\\", "/")).replace(/\/+$/, "");
  if (posix.isAbsolute(normal) || /^[A-Za-z]:/.test(normal)) return undefined;
  if (normal === ".." || normal.startsWith("../")) return undefined;
  return normal === "" ? "." : normal;
}

function isAddress(value: string): boolean {
  try {
    parseAddress(value);
    return true;
  } catch {
    // Not a <model>.<need> address; the caller reports the key itself.
    return false;
  }
}

/**
 * Reports whether a value is a mount description created by {@link slot}.
 *
 * @param value Any value.
 * @returns `true` when the value carries the slot brand.
 */
export function isSlotSpec(value: unknown): value is SlotSpec {
  return (
    typeof value === "object" && value !== null && (value as { [SLOT]?: unknown })[SLOT] === true
  );
}

/**
 * Reports whether a value is a manifest created by {@link rack}.
 *
 * @param value Any value, typically the default export of a manifest file.
 * @returns `true` when the value carries the manifest brand.
 */
export function isRackManifest(value: unknown): value is RackManifest {
  return (
    typeof value === "object" && value !== null && (value as { [RACK]?: unknown })[RACK] === true
  );
}

/**
 * Checks a device name.
 *
 * @param name The candidate name.
 * @throws RackError `RACK_MANIFEST` when the name could make `<device>.<port>` ambiguous.
 */
export function checkDeviceName(name: string): void {
  if (typeof name !== "string" || !DEVICE_NAME.test(name)) {
    throw new RackError(
      "RACK_MANIFEST",
      `device name "${String(name)}" must match ${DEVICE_NAME.source}`,
    );
  }
}

/**
 * Parses a `<device>.<port>` address.
 *
 * @param address The address, for example `orders.http`.
 * @returns The device and port names.
 * @throws RackError `RACK_MANIFEST` when the address is malformed.
 */
export function parseAddress(address: string): Address {
  const dot = typeof address === "string" ? address.indexOf(".") : -1;
  const device = dot > 0 ? address.slice(0, dot) : "";
  const port = dot > 0 ? address.slice(dot + 1) : "";
  if (!DEVICE_NAME.test(device) || !isIdentifierName(port)) {
    throw new RackError("RACK_MANIFEST", `"${String(address)}" is not a <device>.<port> address`);
  }
  return { device, port };
}

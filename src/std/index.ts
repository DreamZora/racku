/**
 * Entry point of `rack42u/std`: the standard connectors and the factories that mount the
 * standard devices.
 *
 * @decision .agents/decisions/261115_232410-p0-scope-and-toolchain-bun-1-4-4.md#p0-scope
 * @decision .agents/decisions/261115_222025-p0-api-details.md#standard-devices
 */
import { type SlotSpec, slot } from "../manifest.ts";

export { Kv, Sql } from "./connectors.ts";

/** Options shared by the standard device factories. */
export interface StdDeviceOptions {
  /** Device name; defaults to the model name. */
  name?: string;
}

/** Configuration of the `sqlite` device. */
export interface SqliteConfig {
  /** Database file relative to the rack base directory, or `":memory:"`. */
  path: string;
}

// The factories return paths only: the main thread never loads device code.
// @decision .agents/decisions/261112_035943-hot-swap.md#the-main-thread-never-loads-device-code

/**
 * Mounts `memkv`, an in-memory `kv/v1` store whose entries survive swaps and hot reloads but
 * not crash resets or restarts.
 *
 * @param options Device name.
 * @returns The mount description.
 */
export function memkv(options: StdDeviceOptions = {}): SlotSpec {
  return slot(new URL("./memkv.ts", import.meta.url), { name: options.name });
}

/**
 * Mounts `sqlite`, a `sql/v1` database on `bun:sqlite`.
 *
 * @param config The database path.
 * @param options Device name.
 * @returns The mount description.
 */
export function sqlite(config: SqliteConfig, options: StdDeviceOptions = {}): SlotSpec {
  return slot(new URL("./sqlite.ts", import.meta.url), { name: options.name, config });
}

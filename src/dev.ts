/**
 * Development mode: watch the base directory and reload the rack after changes.
 *
 * Reloading goes through the swap process, so only devices whose firmware hash changed are
 * replaced; `bun --hot` is not involved. An edited manifest is imported again and handed to the
 * running rack, which moves to its new layout.
 *
 * @decision .agents/decisions/261112_035943-hot-swap.md#firmware
 * @decision .agents/decisions/261115_222025-p0-api-details.md#command-line
 * @decision .agents/decisions/261116_233956-cold-swaps-and-restarts.md#applying-a-changed-plan
 */
import { type FSWatcher, watch } from "node:fs";
import { resolve, sep } from "node:path";
import { buildFirmware } from "./firmware.ts";
import type { LogEntry } from "./log.ts";
import { isRackManifest, type RackManifest } from "./manifest.ts";
import type { RackHandle } from "./rack.ts";

/** Milliseconds of quiet after the last change before a reload starts. */
export const DEBOUNCE_MS = 100;

/** Options of {@link watchAndReload}. */
export interface WatchOptions {
  /** Directory to watch recursively. */
  baseDir: string;
  /** Absolute path of the manifest; an edit to it is imported again and applied. */
  manifestPath: string;
  /** Writes the watcher's own log entries. */
  log: (entry: LogEntry) => void;
}

/**
 * Watches `baseDir` and calls `running.reload()` after changes, one reload at a time.
 *
 * @param running The rack to reload.
 * @param options Directory, manifest path, and logger.
 * @returns A function that stops watching.
 */
export function watchAndReload(running: RackHandle, options: WatchOptions): () => void {
  const manifestPath = resolve(options.manifestPath);
  const log = (level: LogEntry["level"], message: string, data?: unknown) => {
    const entry: LogEntry = { time: Date.now(), level, message };
    if (data !== undefined) entry.data = data;
    options.log(entry);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reloading = false;
  let again = false;
  let closed = false;
  let manifestChanged = false;

  const reload = async () => {
    if (reloading) {
      again = true;
      return;
    }
    reloading = true;
    try {
      do {
        again = false;
        let manifest: RackManifest | undefined;
        if (manifestChanged) {
          manifestChanged = false;
          manifest = await importManifest(manifestPath, options.baseDir);
          log("info", "the manifest changed; applying it", { manifestPath });
        }
        const results = await running.reload(manifest);
        if (results.length === 0) log("info", "reload: no firmware changed");
      } while (again && !closed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("error", `reload failed: ${message}`);
    } finally {
      reloading = false;
    }
  };

  const watcher: FSWatcher = watch(options.baseDir, { recursive: true }, (_event, filename) => {
    if (closed || filename === null) return;
    const relative = filename.toString();
    if (relative.split(/[\\/]/).some((part) => part === "node_modules" || part.startsWith("."))) {
      return;
    }
    if (resolve(options.baseDir, relative) === manifestPath) manifestChanged = true;
    clearTimeout(timer);
    timer = setTimeout(() => void reload(), DEBOUNCE_MS);
  });
  log("info", `watching ${options.baseDir}${sep} for changes`);

  return () => {
    closed = true;
    clearTimeout(timer);
    watcher.close();
  };
}

/**
 * Imports an edited manifest file. Bun 1.4.4 keeps returning its first copy of a module, even
 * for a URL with a new query, so the manifest is bundled like firmware: an edit gives the bundle
 * a new content hash, and with it a new module, helpers included.
 *
 * @throws Error when the file does not build or does not default-export a rack().
 */
async function importManifest(manifestPath: string, baseDir: string): Promise<RackManifest> {
  const bundle = await buildFirmware(manifestPath, baseDir);
  const manifest = ((await import(bundle.url)) as { default?: unknown }).default;
  if (!isRackManifest(manifest))
    throw new Error(`${manifestPath} does not default-export a rack()`);
  return manifest;
}

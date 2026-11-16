/**
 * Development mode: watch the base directory and reload the rack after changes.
 *
 * Reloading goes through the swap process, so only devices whose firmware hash changed are
 * replaced; `bun --hot` is not involved.
 *
 * @decision .agents/decisions/261112_035943-hot-swap.md#firmware
 * @decision .agents/decisions/261115_222025-p0-api-details.md#command-line
 */
import { type FSWatcher, watch } from "node:fs";
import { resolve, sep } from "node:path";
import type { LogEntry } from "./log.ts";
import type { RackHandle } from "./rack.ts";

/** Milliseconds of quiet after the last change before a reload starts. */
export const DEBOUNCE_MS = 100;

/** Options of {@link watchAndReload}. */
export interface WatchOptions {
  /** Directory to watch recursively. */
  baseDir: string;
  /** Absolute path of the manifest; changes to it only produce a warning. */
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
        if (manifestChanged) {
          manifestChanged = false;
          log("warn", "the manifest changed; restart the rack to apply it", { manifestPath });
        }
        const results = await running.reload();
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

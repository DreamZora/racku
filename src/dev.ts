/**
 * Watching a base directory, and reloading the rack after changes: `rack dev`'s, and an
 * executable's with `--watch`.
 *
 * Reloading goes through the swap process, so only devices whose firmware hash changed are
 * replaced; `bun --hot` is not involved. Under `rack dev`, an edited manifest is imported again
 * and handed to the running rack, which moves to its new layout.
 *
 * @decision .agents/decisions/261112_035943-hot-swap.md#firmware
 * @decision .agents/decisions/261115_222025-p0-api-details.md#command-line
 * @decision .agents/decisions/261116_233956-cold-swaps-and-restarts.md#applying-a-changed-plan
 * @decision .agents/decisions/261120_221450-watching-outside-files.md
 */
import { type FSWatcher, statSync, watch } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { buildFirmware } from "./firmware.ts";
import type { LogEntry } from "./log.ts";
import { isRackManifest, type RackManifest } from "./manifest.ts";
import type { RackHandle } from "./rack.ts";

/** Milliseconds of quiet after the last change before a reload starts. */
export const DEBOUNCE_MS = 100;

/**
 * The most milliseconds a reload waits after the first change it applies, so that changes that
 * never pause don't hold it off.
 *
 * @decision .agents/decisions/261120_221450-watching-outside-files.md#when-the-reload-starts
 */
export const MAX_WAIT_MS = 1_000;

/**
 * The kinds of file whose changes reload an executable with `--watch`: those that device files
 * are written in, and JSON, which they often import.
 *
 * @decision .agents/decisions/261120_221450-watching-outside-files.md#what-counts-as-a-change
 */
const DEVICE_FILE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
]);

/**
 * Whether a file is of a kind that device files are written in, or JSON: what counts as a change
 * for an executable with `--watch`.
 *
 * @param path The file's path, relative to the watched directory.
 */
export function isDeviceFileOrJson(path: string): boolean {
  return DEVICE_FILE_EXTENSIONS.has(extname(path));
}

/** Options of {@link watchAndReload}. */
export interface WatchOptions {
  /** Directory to watch recursively. */
  baseDir: string;
  /**
   * Absolute path of `rack dev`'s manifest; an edit to it is imported again and applied. An
   * executable, whose manifest is packaged, has none.
   */
  manifestPath?: string;
  /**
   * Whether a change to a file counts, by its path relative to `baseDir`: by default, every
   * file. Files in `node_modules`, and files and directories whose names start with a dot, never
   * count.
   */
  counts?: (path: string) => boolean;
  /** Writes the watcher's own log entries. */
  log: (entry: LogEntry) => void;
}

/**
 * Watches `baseDir` and calls `running.reload()` after changes: {@link DEBOUNCE_MS} after the
 * last change, and at most {@link MAX_WAIT_MS} after the first. One reload runs at a time, and
 * changes during one start one more after it.
 *
 * Watching never throws, and never ends the rack. A watch that can't start logs
 * `cannot watch <dir>`; a base directory that is removed, or a watch that fails, stops watching
 * and logs `stopped watching <dir>`; a reload that fails logs `reload failed`, and watching goes
 * on.
 *
 * @param running The rack to reload.
 * @param options Directory, manifest path, which changes count, and logger.
 * @returns A function that stops watching.
 */
export function watchAndReload(
  running: Pick<RackHandle, "reload">,
  options: WatchOptions,
): () => void {
  const { baseDir } = options;
  const where = `${baseDir}${sep}`;
  const manifestPath =
    options.manifestPath === undefined ? undefined : resolve(options.manifestPath);
  const counts = options.counts ?? (() => true);
  const log = (level: LogEntry["level"], message: string, data?: unknown) => {
    const entry: LogEntry = { time: Date.now(), level, message };
    if (data !== undefined) entry.data = data;
    options.log(entry);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** When the first change that the next reload applies arrived. */
  let firstChange: number | undefined;
  let reloading = false;
  let again = false;
  let closed = false;
  let manifestChanged = false;
  let watcher: FSWatcher | undefined;

  const close = () => {
    closed = true;
    clearTimeout(timer);
    try {
      watcher?.close();
    } catch {
      // A watch that already failed has nothing left to close.
    }
  };

  // @decision .agents/decisions/261120_221450-watching-outside-files.md#failure-modes
  const stopWatching = (reason: string) => {
    if (closed) return;
    close();
    log("error", `stopped watching ${where}: ${reason}`);
  };

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
        if (manifestChanged && manifestPath !== undefined) {
          manifestChanged = false;
          manifest = await importManifest(manifestPath, baseDir);
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

  const due = () => {
    timer = undefined;
    firstChange = undefined;
    if (closed) return;
    // The system reports the removal of a watched directory differently on each system, if at
    // all, but always the removals of what it held, which bring the reload here.
    const gone = goneReason(baseDir);
    if (gone !== undefined) {
      stopWatching(gone);
      return;
    }
    void reload();
  };

  const changed = () => {
    const now = performance.now();
    firstChange ??= now;
    clearTimeout(timer);
    timer = setTimeout(due, Math.max(0, Math.min(DEBOUNCE_MS, firstChange + MAX_WAIT_MS - now)));
  };

  try {
    watcher = watch(baseDir, { recursive: true }, (_event, filename) => {
      if (closed) return;
      // No name, as for the watched directory itself or for events the system dropped: anything
      // may have changed.
      if (filename === null || filename === undefined) {
        changed();
        return;
      }
      const relative = filename.toString();
      if (relative.split(/[\\/]/).some((part) => part === "node_modules" || part.startsWith("."))) {
        return;
      }
      const isManifest = manifestPath !== undefined && resolve(baseDir, relative) === manifestPath;
      if (!isManifest && !counts(relative)) return;
      if (isManifest) manifestChanged = true;
      changed();
    });
  } catch (error) {
    closed = true;
    log("error", `cannot watch ${where}: ${error instanceof Error ? error.message : error}`);
    return () => undefined;
  }
  watcher.on("error", (error: unknown) => {
    stopWatching(goneReason(baseDir) ?? (error instanceof Error ? error.message : String(error)));
  });
  log("info", `watching ${where} for changes`);

  return close;
}

/**
 * Why `dir` can no longer be watched: `it was removed` when it is gone or is no longer a
 * directory, the reason when it can't be read, and `undefined` while it is there.
 */
function goneReason(dir: string): string | undefined {
  try {
    return statSync(dir).isDirectory() ? undefined : "it was removed";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "it was removed";
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Imports an edited manifest file. Bun 1.4.4 keeps returning its first copy of a module, even
 * for a URL with a new query, so the manifest is bundled like firmware: an edit gives the bundle
 * a new content hash, and with it a new module, helpers included. Each of its files keeps the
 * `import.meta` paths of its own source, as firmware does, so a manifest that reads a file next
 * to it reads the same file as when the rack started.
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
